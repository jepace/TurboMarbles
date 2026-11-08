// Accounts.js — the account and stats actions over the WebSocket.
//
//   identify     { key }            sign this connection in with a device key
//   register     { name }           new player → { player, key } (rate-limited per IP)
//   rename       { name }
//   linkCode     {}                 a 10-minute code to sign in another device
//   redeemLink   { code }           → { player, key } (failures rate-limited per IP)
//   signOutOthers{}                 revoke every other device of this player
//   deleteAccount{ confirm }        confirm must equal the current name
//   profile      {}                 stats + recent games
//   history      { before }         more games
//   openGame     { id }             a past game (only for its players) to replay
//
// A signed-in connection carries ws._player = { id, name }.
import * as store from './Store.js';

const WINDOW_MS = 60 * 60 * 1000;
const LIMITS = { register: 10, linkFail: 10, identifyFail: 30 };    // per IP per hour
const hits = new Map();       // `${kind}:${ip}` → [timestamps]
function limited(kind, ip) {
  const k = `${kind}:${ip}`, t = Date.now();
  const list = (hits.get(k) ?? []).filter(x => t - x < WINDOW_MS);
  hits.set(k, list);
  return list.length >= LIMITS[kind];
}
function hit(kind, ip) { const k = `${kind}:${ip}`; (hits.get(k) ?? hits.set(k, []).get(k)).push(Date.now()); }
setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (!v.some(x => t - x < WINDOW_MS)) hits.delete(k); }, 10 * 60 * 1000).unref();

export const ACCOUNT_ACTIONS = new Set(['setPrefs', 'identify', 'register', 'rename', 'linkCode', 'redeemLink', 'signOutOthers',
  'deleteAccount', 'profile', 'history', 'openGame']);

// send(ws, msg); cleanName(raw) → '' if unusable; onOpenGame(ws, game) shows a stored game.
export function handleAccountAction(ws, msg, { send, cleanName, onOpenGame }) {
  const err = (code, message) => send(ws, { event: 'error', code, message });
  if (!store.storeEnabled()) return err('STATS_UNAVAILABLE', 'Accounts and stats are not available on this server.');
  const ip = ws._ip ?? 'unknown';
  const me = ws._player;
  const needMe = () => { if (!me) { err('NOT_SIGNED_IN', 'Sign in first.'); return false; } return true; };

  switch (msg.action) {
    case 'identify': {
      if (limited('identifyFail', ip)) return err('RATE_LIMITED', 'Too many attempts. Try again later.');
      const p = store.authenticate(msg.key);
      if (!p) { hit('identifyFail', ip); return send(ws, { event: 'identity', player: null }); }
      ws._player = p;
      ws._key = msg.key;
      return send(ws, { event: 'identity', player: p, devices: store.deviceCount(p.id), prefs: store.getPrefs(p.id) });
    }
    case 'register': {
      const name = cleanName(msg.name);
      if (!name) return err('MISSING_FIELDS', 'Choose a name.');
      if (limited('register', ip)) return err('RATE_LIMITED', 'Too many new players from here. Try again later.');
      const r = store.register(name);
      if (r.error === 'NAME_TAKEN') return err('NAME_TAKEN', `"${name}" is taken. Choose another name, or sign in on this device with a link code.`);
      if (r.error) return err(r.error, 'Could not register.');
      hit('register', ip);
      ws._player = r.player; ws._key = r.key;
      return send(ws, { event: 'registered', player: r.player, key: r.key });
    }
    case 'rename': {
      if (!needMe()) return;
      const name = cleanName(msg.name);
      if (!name) return err('MISSING_FIELDS', 'Choose a name.');
      const r = store.rename(me.id, name);
      if (r.error) return err(r.error, `"${name}" is taken.`);
      me.name = name;
      return send(ws, { event: 'identity', player: me, devices: store.deviceCount(me.id) });
    }
    case 'setPrefs': {
      if (!needMe()) return;
      return send(ws, { event: 'prefs', prefs: store.setPrefs(me.id, msg.prefs) });
    }
    case 'linkCode': {
      if (!needMe()) return;
      return send(ws, { event: 'linkCode', ...store.createLinkCode(me.id) });
    }
    case 'redeemLink': {
      if (limited('linkFail', ip)) return err('RATE_LIMITED', 'Too many wrong codes. Try again later.');
      const r = store.redeemLinkCode(msg.code);
      if (!r) { hit('linkFail', ip); return err('BAD_LINK_CODE', 'That code is wrong or has expired.'); }
      ws._player = r.player; ws._key = r.key;
      return send(ws, { event: 'registered', player: r.player, key: r.key, linked: true, prefs: store.getPrefs(r.player.id) });
    }
    case 'signOutOthers': {
      if (!needMe() || !ws._key) return;
      const n = store.revokeOtherDevices(me.id, ws._key);
      return send(ws, { event: 'identity', player: me, devices: store.deviceCount(me.id), signedOut: n });
    }
    case 'deleteAccount': {
      if (!needMe()) return;
      if (typeof msg.confirm !== 'string' || msg.confirm.trim().toLowerCase() !== me.name.toLowerCase()) {
        return err('CONFIRM_MISMATCH', 'Type your name exactly to confirm.');
      }
      store.deletePlayer(me.id);
      ws._player = null; ws._key = null;
      return send(ws, { event: 'accountDeleted' });
    }
    case 'profile': {
      if (!needMe()) return;
      return send(ws, { event: 'profile', player: me, devices: store.deviceCount(me.id),
        stats: store.playerStats(me.id), games: store.playerGames(me.id, { limit: 30 }) });
    }
    case 'history': {
      if (!needMe()) return;
      const before = Number(msg.before);
      return send(ws, { event: 'history', games: store.playerGames(me.id, { limit: 30, before: Number.isFinite(before) ? before : Infinity }) });
    }
    case 'openGame': {
      if (!needMe()) return;
      if (typeof msg.id !== 'string' || msg.id.length > 40 || !store.playedIn(me.id, msg.id)) return err('NOT_FOUND', 'Game not found.');
      const g = store.getGame(msg.id);
      if (!g) return err('NOT_FOUND', 'Game not found.');
      return onOpenGame(ws, g);
    }
  }
}
