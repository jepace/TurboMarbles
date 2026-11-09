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
//   leaderboard  {}                 top players by rating (results against people)
//   friends      {}                 friends (online or not), requests, blocked, unread counts
//   friendRequest{ name }           ask (or accept, if they asked first)
//   friendRespond{ id, accept }     accept or decline a request
//   friendRemove { id }   block { id }   unblock { id }
//   dm           { to, body }       a direct message to a friend (rate-limited)
//   conversation { with, before }   messages with a friend (marks them read)
//   invite       { to }             invite an online friend into my room
// Pushed: friends (list changed), presence { id, online }, dm, invited { from, code }.
//
// A signed-in connection carries ws._player = { id, name }.
import * as store from './Store.js';
import { sendMail, publicUrl } from './Mailer.js';

const WINDOW_MS = 60 * 60 * 1000;
const LIMITS = { register: 10, linkFail: 10, identifyFail: 30, loginFail: 30, loginAcct: 15, mail: 6 };    // per IP (or account) per hour
const hits = new Map();       // `${kind}:${ip}` → [timestamps]
function limited(kind, ip) {
  const k = `${kind}:${ip}`, t = Date.now();
  const list = (hits.get(k) ?? []).filter(x => t - x < WINDOW_MS);
  hits.set(k, list);
  return list.length >= LIMITS[kind];
}
function hit(kind, ip) { const k = `${kind}:${ip}`; (hits.get(k) ?? hits.set(k, []).get(k)).push(Date.now()); }
setInterval(() => { const t = Date.now(); for (const [k, v] of hits) if (!v.some(x => t - x < WINDOW_MS)) hits.delete(k); }, 10 * 60 * 1000).unref();

export const ACCOUNT_ACTIONS = new Set(['login', 'logout', 'setPassword', 'setEmail', 'clearEmail', 'verifyEmail', 'forgotPassword', 'resetPassword', 'leaderboard', 'friends', 'friendRequest', 'friendRespond', 'friendRemove',
  'block', 'unblock', 'dm', 'conversation', 'invite', 'setPrefs', 'identify', 'register', 'rename', 'linkCode', 'redeemLink', 'signOutOthers',
  'deleteAccount', 'profile', 'history', 'openGame']);

// ---- Presence: which players are connected (by account) ----
const online = new Map();            // playerId → Set<ws>
let sendFn = null;
const pushTo = (id, msg) => { for (const w of online.get(id) ?? []) sendFn?.(w, msg); };
const isOnline = id => (online.get(id)?.size ?? 0) > 0;
function friendIds(id) { return store.friendList(id).friends.map(f => f.id); }
function setPlayer(ws, p) {
  if (ws._player?.id && ws._player.id !== p?.id) accountDisconnected(ws);
  ws._player = p;
  if (!p) return;
  const set = online.get(p.id) ?? online.set(p.id, new Set()).get(p.id);
  const was = set.size > 0;
  set.add(ws);
  if (!was) for (const f of friendIds(p.id)) pushTo(f, { event: 'presence', id: p.id, online: true });
}
// The connection closed (or signed in as someone else).
export function accountDisconnected(ws) {
  const id = ws._player?.id;
  const set = id && online.get(id);
  if (!set) return;
  set.delete(ws);
  if (!set.size) { online.delete(id); if (store.storeEnabled()) for (const f of friendIds(id)) pushTo(f, { event: 'presence', id, online: false }); }
}
// Messages: at most 20 a minute per player.
const dmTimes = new Map();
function dmLimited(id) {
  const t = Date.now(), list = (dmTimes.get(id) ?? []).filter(x => t - x < 60_000);
  dmTimes.set(id, list);
  if (list.length >= 20) return true;
  list.push(t); return false;
}
function mailVerify(player, email) {
  const token = store.createMailToken(player.id, 'verify', email);
  sendMail(email, 'Confirm your email for TurboMarbles',
    `Hi ${player.name},\n\nTo use this address for password resets, open this link within a day:\n${publicUrl()}/?verify=${token}\n\nIf this wasn't you, ignore this email.`);
}
function friendsPayload(id) {
  const l = store.friendList(id), unread = store.unreadCounts(id);
  const mark = f => ({ ...f, online: isOnline(f.id), unread: unread[f.id] ?? 0 });
  return { event: 'friends', friends: l.friends.map(mark), incoming: l.incoming.map(mark), outgoing: l.outgoing, blocked: store.blockList(id) };
}

// send(ws, msg); cleanName(raw) → '' if unusable; onOpenGame(ws, game) shows a stored game;
// roomCodeOf(ws) → the code of the room this connection is in (for invites), or null.
export function handleAccountAction(ws, msg, { send, cleanName, onOpenGame, roomCodeOf }) {
  sendFn = send;
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
      setPlayer(ws, p);
      ws._key = msg.key;
      return send(ws, { event: 'identity', player: p, devices: store.deviceCount(p.id), prefs: store.getPrefs(p.id),
        needsPassword: !store.hasPassword(p.id) });
    }
    case 'register': {
      const name = cleanName(msg.name);
      if (!name) return err('MISSING_FIELDS', 'Choose a name.');
      if (!store.validPassword(msg.password)) return err('BAD_PASSWORD', `Choose a password of ${store.PASSWORD_MIN} to ${store.PASSWORD_MAX} characters.`);
      const email = msg.email ? store.cleanEmail(msg.email) : null;
      if (msg.email && !email) return err('BAD_EMAIL', "That email address doesn't look right.");
      if (limited('register', ip)) return err('RATE_LIMITED', 'Too many new players from here. Try again later.');
      const r = store.register(name);
      if (r.error === 'NAME_TAKEN') return err('NAME_TAKEN', `"${name}" is taken. Choose another name, or sign in on this device with a link code.`);
      if (r.error) return err(r.error, 'Could not register.');
      hit('register', ip);
      store.setPassword(r.player.id, msg.password);
      if (email) mailVerify(r.player, email);
      setPlayer(ws, r.player); ws._key = r.key;
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
      setPlayer(ws, r.player); ws._key = r.key;
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
      accountDisconnected(ws);
      store.deletePlayer(me.id);
      ws._player = null; ws._key = null;
      return send(ws, { event: 'accountDeleted' });
    }
    case 'profile': {
      if (!needMe()) return;
      return send(ws, { event: 'profile', player: me, devices: store.deviceCount(me.id),
        stats: store.playerStats(me.id, { players: ['2', '3+'].includes(msg.players) ? msg.players : 'all', robots: msg.robots === 'none' ? 'none' : 'any' }), games: store.playerGames(me.id, { limit: 30 }), rating: store.ratingOf(me.id),
        email: store.emailOf(me.id), hasPassword: store.hasPassword(me.id) });
    }
    case 'history': {
      if (!needMe()) return;
      const before = Number(msg.before);
      return send(ws, { event: 'history', games: store.playerGames(me.id, { limit: 30, before: Number.isFinite(before) ? before : Infinity }) });
    }
    case 'login': {
      const acct = 'acct:' + String(msg.name ?? '').toLowerCase().slice(0, 40);
      if (limited('loginFail', ip) || limited('loginAcct', acct)) return err('RATE_LIMITED', 'Too many tries. Wait a while, or reset your password.');
      const r = store.login(msg.name, msg.password);
      if (!r) { hit('loginFail', ip); hit('loginAcct', acct); return err('BAD_LOGIN', 'Wrong name or password.'); }
      setPlayer(ws, r.player); ws._key = r.key;
      return send(ws, { event: 'registered', player: r.player, key: r.key, prefs: store.getPrefs(r.player.id) });
    }
    case 'logout': {
      if (ws._key) store.revokeSession(ws._key);
      accountDisconnected(ws);
      ws._player = null; ws._key = null;
      return send(ws, { event: 'loggedOut' });
    }
    case 'setPassword': {
      if (!needMe()) return;
      if (store.hasPassword(me.id) && !store.checkPassword(me.id, msg.current)) return err('BAD_LOGIN', 'Your current password is wrong.');
      if (!store.validPassword(msg.password)) return err('BAD_PASSWORD', `Choose a password of ${store.PASSWORD_MIN} to ${store.PASSWORD_MAX} characters.`);
      store.setPassword(me.id, msg.password);
      return send(ws, { event: 'passwordSet' });
    }
    case 'setEmail': {
      if (!needMe()) return;
      const email = store.cleanEmail(msg.email);
      if (!email) return err('BAD_EMAIL', "That email address doesn't look right.");
      if (limited('mail', 'id:' + me.id)) return err('RATE_LIMITED', 'Too many emails. Try again later.');
      hit('mail', 'id:' + me.id);
      mailVerify(me, email);
      return send(ws, { event: 'emailPending', email });
    }
    case 'clearEmail':
      if (!needMe()) return;
      store.clearEmail(me.id);
      return send(ws, { event: 'emailCleared' });
    case 'verifyEmail': {
      const r = store.verifyEmail(msg.token);
      if (!r || r.error) return err(r?.error ?? 'BAD_TOKEN', r?.error === 'EMAIL_TAKEN' ? 'Another account uses that email.' : 'That link is wrong or has expired.');
      return send(ws, { event: 'emailVerified', email: r.email });
    }
    case 'forgotPassword': {
      // Same answer whether or not the account (or its email) exists.
      if (!limited('mail', ip)) {
        hit('mail', ip);
        const t = store.resetTarget(msg.name);
        if (t) {
          const token = store.createMailToken(t.id, 'reset');
          sendMail(t.email, 'Reset your TurboMarbles password',
            `Hi ${t.name},\n\nTo choose a new password, open this link within an hour:\n${publicUrl()}/?reset=${token}\n\nIf you didn't ask for this, ignore this email; your password stays as it is.`);
        }
      }
      return send(ws, { event: 'resetSent' });
    }
    case 'resetPassword': {
      const r = store.resetPassword(msg.token, msg.password);
      if (r.error) return err(r.error, r.error === 'BAD_PASSWORD' ? `Choose a password of ${store.PASSWORD_MIN} to ${store.PASSWORD_MAX} characters.` : 'That link is wrong or has expired.');
      setPlayer(ws, r.player); ws._key = r.key;
      return send(ws, { event: 'registered', player: r.player, key: r.key, prefs: store.getPrefs(r.player.id), reset: true });
    }
    case 'leaderboard':
      return send(ws, { event: 'leaderboard', players: store.leaderboard({ limit: 100 }), me: me ? store.ratingOf(me.id) : null });
    case 'friends':
      if (!needMe()) return;
      return send(ws, friendsPayload(me.id));
    case 'friendRequest': {
      if (!needMe()) return;
      const other = store.findPlayerByName(msg.name);
      if (!other) return err('NOT_FOUND', 'No player by that name.');
      const r = store.friendRequest(me.id, other.id);
      if (r === 'SELF' || r === 'BLOCKED') return err(r, r === 'SELF' ? "That's you." : 'Not possible.');
      send(ws, friendsPayload(me.id)); pushTo(other.id, friendsPayload(other.id));
      return;
    }
    case 'friendRespond': {
      if (!needMe() || typeof msg.id !== 'string') return;
      if (msg.accept) store.friendRequest(me.id, msg.id); else store.friendRemove(me.id, msg.id);
      send(ws, friendsPayload(me.id)); pushTo(msg.id, friendsPayload(msg.id));
      return;
    }
    case 'friendRemove': case 'block': case 'unblock': {
      if (!needMe() || typeof msg.id !== 'string') return;
      if (msg.action === 'friendRemove') store.friendRemove(me.id, msg.id);
      else if (msg.action === 'block') store.block(me.id, msg.id); else store.unblock(me.id, msg.id);
      send(ws, friendsPayload(me.id)); pushTo(msg.id, friendsPayload(msg.id));
      return;
    }
    case 'dm': {
      if (!needMe() || typeof msg.to !== 'string') return;
      if (!store.areFriends(me.id, msg.to) || store.isBlocked(msg.to, me.id)) return err('NOT_FRIENDS', 'You can only message friends.');
      if (dmLimited(me.id)) return err('RATE_LIMITED', 'Slow down a little.');
      const m = store.sendMessage(me.id, msg.to, msg.body);
      if (!m) return;
      const out = { event: 'dm', message: { ...m, fromName: me.name } };
      send(ws, out); pushTo(msg.to, out);
      for (const w of online.get(me.id) ?? []) if (w !== ws) send(w, out);
      return;
    }
    case 'conversation': {
      if (!needMe() || typeof msg.with !== 'string') return;
      const before = Number(msg.before);
      return send(ws, { event: 'conversation', with: msg.with,
        messages: store.conversation(me.id, msg.with, { before: Number.isFinite(before) ? before : Infinity }) });
    }
    case 'invite': {
      if (!needMe() || typeof msg.to !== 'string') return;
      if (!store.areFriends(me.id, msg.to)) return err('NOT_FRIENDS', 'You can only invite friends.');
      const code = roomCodeOf?.(ws);
      if (!code) return err('NO_ROOM', 'Create a game first, then invite.');
      if (!isOnline(msg.to)) return err('OFFLINE', 'They are not online.');
      pushTo(msg.to, { event: 'invited', from: me.name, fromId: me.id, code });
      return send(ws, { event: 'inviteSent', to: msg.to });
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
