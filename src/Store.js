// Store.js — persistent players, devices, games and stats (SQLite, node:sqlite).
//
// Identity without passwords: registering a name gives the browser a secret
// device key (256-bit random). The server stores only its SHA-256 hash; the
// key is the login. A player can have several keys (one per device), added
// with a short single-use link code from a device that is already signed in.
// The key can also be shown as a "recovery key" for safekeeping.
//
// Names are unique (case-insensitive), so nobody can play as someone else.
//
// Games: every finished game is stored with its seats, result and roll
// records (positions before/after each roll, gzipped), so it can be replayed
// and analysed later. Per-seat numbers (points, aggro, cube actions, error
// rate once analysed) make the stats simple queries. Games against robots are
// flagged so stats keep them separate.
//
// If node:sqlite is unavailable (Node too old), the store is disabled: games
// still work, and identity/stats actions answer STATS_UNAVAILABLE.
import { createHash, randomBytes } from 'crypto';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { gzipSync, gunzipSync } from 'zlib';

let db = null;
let disabledReason = null;

// Default: data/ next to src/ (the rc.d script sets DATA_DIR=/var/db/turbomarbles).
const DEFAULT_DIR = new URL('../data/', import.meta.url).pathname;
export function openStore(dir = process.env.DATA_DIR || DEFAULT_DIR, file = 'turbomarbles.sqlite') {
  if (db) return true;
  let DatabaseSync;
  try {
    // Loaded lazily so an older Node just runs without stats.
    ({ DatabaseSync } = process.getBuiltinModule?.('node:sqlite') ?? {});
    if (!DatabaseSync) throw new Error('node:sqlite not available (needs Node 22.13+)');
  } catch (err) {
    disabledReason = String(err.message ?? err);
    console.error(`[store] disabled: ${disabledReason}`);
    return false;
  }
  try {
    if (dir !== ':memory:') mkdirSync(dir, { recursive: true, mode: 0o700 });
    db = new DatabaseSync(dir === ':memory:' ? ':memory:' : join(dir, file));
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 2000;');
    migrate();
    return true;
  } catch (err) {
    disabledReason = String(err.message ?? err);
    console.error(`[store] disabled: ${disabledReason}`);
    db = null;
    return false;
  }
}
export const storeEnabled = () => !!db;
export const storeDisabledReason = () => disabledReason;
export function closeStore() { if (db) { db.close(); db = null; } }

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS players (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      name_key   TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      key_hash   TEXT PRIMARY KEY,
      player_id  TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      last_used  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS devices_player ON devices(player_id);
    CREATE TABLE IF NOT EXISTS link_codes (
      code_hash  TEXT PRIMARY KEY,
      player_id  TEXT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS games (
      id          TEXT PRIMARY KEY,
      ended_at    INTEGER NOT NULL,
      n_players   INTEGER NOT NULL,
      vs_robot    INTEGER NOT NULL,         -- any robot seat
      cube        INTEGER NOT NULL,
      winner_seat INTEGER,
      rolls_gz    BLOB,                     -- the game's roll records (replay/analysis)
      report_gz   BLOB                      -- the analysis report, once analysed
    );
    CREATE INDEX IF NOT EXISTS games_ended ON games(ended_at);
    CREATE TABLE IF NOT EXISTS seats (
      game_id    TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
      seat       INTEGER NOT NULL,
      player_id  TEXT REFERENCES players(id) ON DELETE SET NULL,
      name       TEXT NOT NULL,
      color      TEXT NOT NULL,
      is_robot   INTEGER NOT NULL,
      won        INTEGER NOT NULL,
      points     INTEGER NOT NULL,          -- money points (two-player rooms), else 0
      aggro      INTEGER NOT NULL,          -- won or lost by an aggro
      doubles    INTEGER NOT NULL DEFAULT 0,
      takes      INTEGER NOT NULL DEFAULT 0,
      drops      INTEGER NOT NULL DEFAULT 0,
      choices    INTEGER,                   -- from the analysis: real choices,
      errors     INTEGER,                   --   errors, blunders and equity lost
      blunders   INTEGER,
      eq_lost    REAL,
      PRIMARY KEY (game_id, seat)
    );
    CREATE INDEX IF NOT EXISTS seats_player ON seats(player_id);
  `);
  // Added later: cube-decision numbers per seat.
  const cols = new Set(db.prepare('PRAGMA table_info(seats)').all().map(c => c.name));
  for (const [c, t] of [['cube_decisions', 'INTEGER'], ['cube_errors', 'INTEGER'], ['cube_blunders', 'INTEGER'], ['cube_eq_lost', 'REAL']]) {
    if (!cols.has(c)) db.exec(`ALTER TABLE seats ADD COLUMN ${c} ${t}`);
  }
  const pcols = new Set(db.prepare('PRAGMA table_info(players)').all().map(c => c.name));
  if (!pcols.has('prefs')) db.exec('ALTER TABLE players ADD COLUMN prefs TEXT');
  db.prepare("INSERT OR IGNORE INTO meta VALUES ('schema', '2')").run();
}

const now = () => Date.now();
const sha = s => createHash('sha256').update(s).digest('hex');
const nameKey = n => n.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const newId = () => randomBytes(12).toString('base64url');

// ---- Identity -------------------------------------------------------------------

// Register a new player under `name`. Returns { player, key } (the key is only
// ever returned here and from link codes) or { error: 'NAME_TAKEN' }.
export function register(name) {
  if (!db) return { error: 'STATS_UNAVAILABLE' };
  const key = randomBytes(32).toString('base64url');
  const id = newId();
  try {
    db.prepare('INSERT INTO players (id, name, name_key, created_at) VALUES (?, ?, ?, ?)').run(id, name, nameKey(name), now());
  } catch {
    return { error: 'NAME_TAKEN' };
  }
  db.prepare('INSERT INTO devices (key_hash, player_id, created_at, last_used) VALUES (?, ?, ?, ?)').run(sha(key), id, now(), now());
  return { player: { id, name }, key };
}

// The player a device key belongs to, or null.
export function authenticate(key) {
  if (!db || typeof key !== 'string' || key.length < 20 || key.length > 100) return null;
  const row = db.prepare('SELECT p.id, p.name FROM devices d JOIN players p ON p.id = d.player_id WHERE d.key_hash = ?').get(sha(key));
  if (!row) return null;
  db.prepare('UPDATE devices SET last_used = ? WHERE key_hash = ?').run(now(), sha(key));
  return { id: row.id, name: row.name };
}

// ---- Preferences ---------------------------------------------------------------
// Only known keys with known values are kept.
const PREFS = { apFilter: ['errors', 'all'], apPlayer: ['me', 'all'], myColor: ['blue', 'pink', 'orange', 'yellow', 'green', 'white'],
  boardTrack: ['muted', 'solid', 'deep', 'outline'], boardMarbles: ['socket', 'classic', 'dark', 'white'] };
export function cleanPrefs(p) {
  const out = {};
  if (p && typeof p === 'object') for (const [k, ok] of Object.entries(PREFS)) if (ok.includes(p[k])) out[k] = p[k];
  return out;
}
export function getPrefs(id) {
  if (!db) return {};
  try { return cleanPrefs(JSON.parse(db.prepare('SELECT prefs FROM players WHERE id = ?').get(id)?.prefs ?? '{}')); } catch { return {}; }
}
export function setPrefs(id, prefs) {
  if (!db) return {};
  const p = cleanPrefs(prefs);
  db.prepare('UPDATE players SET prefs = ? WHERE id = ?').run(JSON.stringify(p), id);
  return p;
}

export function isNameTaken(name, exceptId = null) {
  if (!db) return false;
  const row = db.prepare('SELECT id FROM players WHERE name_key = ?').get(nameKey(name));
  return !!row && row.id !== exceptId;
}

export function rename(playerId, name) {
  if (!db) return { error: 'STATS_UNAVAILABLE' };
  if (isNameTaken(name, playerId)) return { error: 'NAME_TAKEN' };
  db.prepare('UPDATE players SET name = ?, name_key = ? WHERE id = ?').run(name, nameKey(name), playerId);
  return { ok: true };
}

// A short single-use code (10 minutes) to sign another device in.
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no 0/O, 1/I
export function createLinkCode(playerId) {
  if (!db) return { error: 'STATS_UNAVAILABLE' };
  db.prepare('DELETE FROM link_codes WHERE expires_at < ? OR player_id = ?').run(now(), playerId);
  const bytes = randomBytes(10);
  const code = [...bytes].map(b => CODE_CHARS[b % CODE_CHARS.length]).join('');
  db.prepare('INSERT INTO link_codes VALUES (?, ?, ?)').run(sha(code), playerId, now() + 10 * 60 * 1000);
  return { code: `${code.slice(0, 5)}-${code.slice(5)}`, expiresInMin: 10 };
}

// Use a link code: a new device key for that player (the code is used up).
export function redeemLinkCode(code) {
  if (!db || typeof code !== 'string') return null;
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length !== 10) return null;
  const row = db.prepare('SELECT player_id, expires_at FROM link_codes WHERE code_hash = ?').get(sha(clean));
  db.prepare('DELETE FROM link_codes WHERE code_hash = ? OR expires_at < ?').run(sha(clean), now());
  if (!row || row.expires_at < now()) return null;
  const key = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO devices (key_hash, player_id, created_at, last_used) VALUES (?, ?, ?, ?)').run(sha(key), row.player_id, now(), now());
  const p = db.prepare('SELECT id, name FROM players WHERE id = ?').get(row.player_id);
  return { player: { id: p.id, name: p.name }, key };
}

export function deviceCount(playerId) {
  return db ? db.prepare('SELECT COUNT(*) n FROM devices WHERE player_id = ?').get(playerId).n : 0;
}

// Sign out every other device (keeps the one whose key is given).
export function revokeOtherDevices(playerId, keepKey) {
  if (!db) return 0;
  return Number(db.prepare('DELETE FROM devices WHERE player_id = ? AND key_hash != ?').run(playerId, sha(keepKey)).changes);
}

// Delete the account: the player and their devices go; their seats in past
// games stay (other players' history) but lose the link and the name.
export function deletePlayer(playerId) {
  if (!db) return false;
  db.prepare("UPDATE seats SET name = 'deleted player' WHERE player_id = ?").run(playerId);
  db.prepare('DELETE FROM players WHERE id = ?').run(playerId);
  return true;
}

// ---- Games ------------------------------------------------------------------------

// Store a finished game. seats: [{ playerId|null, name, color, isRobot, won,
// points, aggro, doubles, takes, drops }]; rolls: the roll records.
export function recordGame({ id = newId(), endedAt = now(), cube, winnerSeat, seats, rolls }) {
  if (!db) return null;
  const vsRobot = seats.some(s => s.isRobot) ? 1 : 0;
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO games (id, ended_at, n_players, vs_robot, cube, winner_seat, rolls_gz) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, endedAt, seats.length, vsRobot, cube ? 1 : 0, winnerSeat ?? null, rolls ? gzipSync(JSON.stringify(rolls)) : null);
    const ins = db.prepare(`INSERT INTO seats (game_id, seat, player_id, name, color, is_robot, won, points, aggro, doubles, takes, drops)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    seats.forEach((s, i) => ins.run(id, i, s.playerId ?? null, s.name, s.color, s.isRobot ? 1 : 0, s.won ? 1 : 0,
      s.points | 0, s.aggro ? 1 : 0, s.doubles | 0, s.takes | 0, s.drops | 0));
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return id;
}

// Save (or replace) a game's analysis report, and the per-seat error numbers
// from it.
export function saveAnalysis(gameId, report, perSeat) {
  if (!db || !gameId) return;
  db.prepare('UPDATE games SET report_gz = ? WHERE id = ?').run(gzipSync(JSON.stringify(report)), gameId);
  const up = db.prepare(`UPDATE seats SET choices = ?, errors = ?, blunders = ?, eq_lost = ?,
    cube_decisions = ?, cube_errors = ?, cube_blunders = ?, cube_eq_lost = ? WHERE game_id = ? AND seat = ?`);
  perSeat.forEach((s, seat) => up.run(s.choices, s.errors, s.blunders, s.eqLost,
    s.cubeDecisions ?? null, s.cubeErrors ?? null, s.cubeBlunders ?? null, s.cubeEqLost ?? null, gameId, seat));
}

export function getGame(gameId) {
  if (!db) return null;
  const g = db.prepare('SELECT * FROM games WHERE id = ?').get(gameId);
  if (!g) return null;
  const seats = db.prepare('SELECT * FROM seats WHERE game_id = ? ORDER BY seat').all(gameId);
  return {
    id: g.id, endedAt: g.ended_at, cube: !!g.cube, vsRobot: !!g.vs_robot, winnerSeat: g.winner_seat,
    seats: seats.map(s => ({ playerId: s.player_id, name: s.name, color: s.color, isRobot: !!s.is_robot, won: !!s.won, points: s.points })),
    rolls: g.rolls_gz ? JSON.parse(gunzipSync(g.rolls_gz)) : null,
    report: g.report_gz ? JSON.parse(gunzipSync(g.report_gz)) : null,
  };
}

// ---- Stats --------------------------------------------------------------------------

// A player's stats, split into games against people and against robots.
export function playerStats(playerId) {
  if (!db) return null;
  const block = vsRobot => db.prepare(`
    SELECT COUNT(*) games, COALESCE(SUM(s.won),0) wins, COALESCE(SUM(s.points),0) points,
           COALESCE(SUM(CASE WHEN s.aggro AND s.won THEN 1 ELSE 0 END),0) aggro_wins,
           COALESCE(SUM(CASE WHEN s.aggro AND NOT s.won THEN 1 ELSE 0 END),0) aggro_losses,
           COALESCE(SUM(s.doubles),0) doubles, COALESCE(SUM(s.takes),0) takes, COALESCE(SUM(s.drops),0) drops,
           COALESCE(SUM(CASE WHEN g.n_players = 2 THEN 1 ELSE 0 END),0) two_player,
           COALESCE(SUM(s.choices),0) choices, COALESCE(SUM(s.errors),0) errors, COALESCE(SUM(s.blunders),0) blunders,
           COALESCE(SUM(s.eq_lost),0) eq_lost, COALESCE(SUM(CASE WHEN s.choices IS NOT NULL THEN 1 ELSE 0 END),0) analysed,
           COALESCE(SUM(s.cube_decisions),0) cube_decisions, COALESCE(SUM(s.cube_errors),0) cube_errors,
           COALESCE(SUM(s.cube_blunders),0) cube_blunders, COALESCE(SUM(s.cube_eq_lost),0) cube_eq_lost
    FROM seats s JOIN games g ON g.id = s.game_id
    WHERE s.player_id = ? AND g.vs_robot = ?`).get(playerId, vsRobot ? 1 : 0);
  // Opponents: per person (people games) — head to head.
  const h2h = db.prepare(`
    SELECT o.player_id id, MAX(o.name) name, COUNT(*) games, SUM(me.won) wins, SUM(me.points) points
    FROM seats me JOIN seats o ON o.game_id = me.game_id AND o.seat != me.seat JOIN games g ON g.id = me.game_id
    WHERE me.player_id = ? AND o.is_robot = 0 AND o.player_id IS NOT NULL
    GROUP BY o.player_id ORDER BY games DESC LIMIT 50`).all(playerId);
  // Error-rate trend: analysed games, oldest first.
  const trend = db.prepare(`
    SELECT g.ended_at t, s.choices, s.eq_lost, g.vs_robot
    FROM seats s JOIN games g ON g.id = s.game_id
    WHERE s.player_id = ? AND s.choices > 0 ORDER BY g.ended_at DESC LIMIT 200`).all(playerId).reverse();
  return { people: block(false), robots: block(true), headToHead: h2h, trend };
}

// The player's games, newest first (for the history list).
export function playerGames(playerId, { limit = 50, before = Infinity } = {}) {
  if (!db) return [];
  const rows = db.prepare(`
    SELECT g.id, g.ended_at, g.n_players, g.vs_robot, g.cube, g.report_gz IS NOT NULL analysed,
           me.seat, me.won, me.points, me.aggro, me.choices, me.eq_lost
    FROM seats me JOIN games g ON g.id = me.game_id
    WHERE me.player_id = ? AND g.ended_at < ? ORDER BY g.ended_at DESC LIMIT ?`).all(playerId, Number.isFinite(before) ? before : 9e15, Math.min(limit, 200));
  const opp = db.prepare('SELECT seat, name, color, is_robot FROM seats WHERE game_id = ? ORDER BY seat');
  return rows.map(r => ({
    id: r.id, endedAt: r.ended_at, players: r.n_players, vsRobot: !!r.vs_robot, cube: !!r.cube, analysed: !!r.analysed,
    seat: r.seat, won: !!r.won, points: r.points, aggro: !!r.aggro,
    errorRate: r.choices ? r.eq_lost / r.choices : null,
    seats: opp.all(r.id).map(s => ({ name: s.name, color: s.color, isRobot: !!s.is_robot })),
  }));
}

// May this player see this game? (They played in it.)
export function playedIn(playerId, gameId) {
  if (!db) return false;
  return !!db.prepare('SELECT 1 FROM seats WHERE game_id = ? AND player_id = ?').get(gameId, playerId);
}
