import express from 'express';
import helmet from 'helmet';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  createRoom, joinRoom, isWatcher, addRobot, removeRobot, startGame,
  handleRoll, handleMove, handleForfeitDie,
  handleDisconnect, handleReconnect, getRoomByWs, roomCodeOf, seatAccountOf, serverSnapshot,
  handleUndo, handleCommit, handleAnalyzeGame,
  handleDouble, handleTake, handleDrop, handleRematch, handleQuit, handleChat, handleSwapSeats, handleResign, handleResignAnswer, handleAnalyzeDeeper, handlePlayOutAll, handleAnalyzeDeeperCube, handleAnalyzeMatch,
  storedGameReport,
} from './GameManager.js';
import { handleAccountAction, ACCOUNT_ACTIONS, accountDisconnected } from './Accounts.js';

// The last server errors, for the admin page.
const recentErrors = [];
const origError = console.error.bind(console);
console.error = (...args) => {
  if (!/ExperimentalWarning|--trace-warnings/.test(String(args[0]))) recentErrors.push({ at: Date.now(), text: args.map(a => (a instanceof Error ? a.stack ?? a.message : typeof a === 'string' ? a : JSON.stringify(a))).join(' ').slice(0, 500) });
  if (recentErrors.length > 100) recentErrors.shift();
  origError(...args);
};
import { openStore, isNameTaken } from './Store.js';

openStore();

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT   = process.env.PORT   || 8080;
const HOST   = process.env.HOST   || '0.0.0.0';
// Set ORIGIN to your public URL (e.g. https://example.com) to enable origin
// checking.  Leave unset to allow all origins (dev / LAN use).
const ORIGIN = process.env.ORIGIN || null;
// Set TRUST_PROXY=1 when running behind a reverse proxy that appends the real
// client address to X-Forwarded-For (nginx's $proxy_add_x_forwarded_for).
// Otherwise every client appears to come from the proxy's address.
const TRUST_PROXY = /^(1|yes|true)$/i.test(process.env.TRUST_PROXY ?? '');

const MAX_CONN_PER_IP   = 20; // a household behind NAT with several tabs fits easily
const MAX_FAILED_JOINS  = 10; // per connection, to slow room-code guessing

function clientIp(req) {
  if (TRUST_PROXY) {
    const xff = req.headers['x-forwarded-for'];
    // The proxy appends the address it saw, so the LAST entry is trustworthy.
    if (typeof xff === 'string' && xff) return xff.split(',').pop().trim();
  }
  return req.socket.remoteAddress ?? 'unknown';
}

// Player names: printable characters only (no control/format characters, so
// names can't inject terminal escape sequences into CLI clients), trimmed,
// max 20. Returns '' if nothing usable is left.
function cleanName(name) {
  if (typeof name !== 'string') return '';
  return name.replace(/[\p{C}]/gu, '').trim().slice(0, 20);
}

// The name a connection plays under: a signed-in player always plays as
// their account name; a guest may use any name that isn't a registered
// player's (so nobody can pose as someone else). null = name taken.
function playName(ws, raw) {
  if (ws._player) return ws._player.name;
  const name = cleanName(raw);
  if (name && isNameTaken(name)) return null;
  return name;
}

// Which finished game of the room an analysis action is about (match play);
// undefined = the latest.
const gameNum = msg => (Number.isInteger(msg.game) && msg.game >= 1 && msg.game <= 500 ? msg.game : undefined);

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

const app = express();
app.disable('x-powered-by');
app.use(helmet());



// Page code must never be stale after a deploy: browsers revalidate every time
// (a quick 304 when unchanged).
app.use(express.static(join(__dirname, '..', 'public'), {
  setHeaders: (res, path) => { if (/\.(html|js|css)$/.test(path)) res.setHeader('Cache-Control', 'no-cache'); },
}));

const server = createServer(app);

// ---- WebSocket server -------------------------------------------------------

const wss = new WebSocketServer({
  server,
  // Hard cap on incoming message size — prevents single-connection memory exhaustion.
  maxPayload: 4 * 1024, // 4 KB; no valid game message approaches this
  // Reject connections whose Origin header doesn't match the configured URL.
  verifyClient: ({ req }) => {
    if (!ORIGIN) return true; // dev: allow all
    const origin = req.headers.origin;
    return origin === ORIGIN;
  },
});

// Ping-pong to detect and reap dead / stale connections.
// Browsers and NAT gateways drop idle TCP connections silently; without this,
// zombie sockets accumulate until the process runs out of file descriptors.
const PING_INTERVAL_MS = 30_000;
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws._alive) {
      ws.terminate();
      continue;
    }
    ws._alive = false;
    ws.ping();
  }
}, PING_INTERVAL_MS);

let nextWsId = 1;
const connPerIp = new Map(); // ip → open connection count

wss.on('connection', (ws, req) => {
  ws._id    = String(nextWsId++);
  ws._alive = true; // initialise for ping-pong

  const ip = clientIp(req);
  ws._ip = ip;
  const count = (connPerIp.get(ip) ?? 0) + 1;
  if (count > MAX_CONN_PER_IP) {
    ws.close(1013, 'Too many connections');
    return;
  }
  connPerIp.set(ip, count);
  ws.once('close', () => {
    const n = (connPerIp.get(ip) ?? 1) - 1;
    if (n <= 0) connPerIp.delete(ip); else connPerIp.set(ip, n);
  });

  // Per-connection rate limiting: token-bucket, refills every second.
  ws._msgCount       = 0;
  ws._msgWindowStart = Date.now();

  // connect is not logged individually — noise at scale; errors/disconnects are.

  ws.on('pong', () => { ws._alive = true; });

  ws.on('message', (raw) => {
    // Rate limit: max 30 messages per second per connection.
    const now = Date.now();
    if (now - ws._msgWindowStart > 1000) {
      ws._msgCount       = 0;
      ws._msgWindowStart = now;
    }
    if (++ws._msgCount > 30) {
      console.warn(`[ws] rate-limit id=${ws._id} — terminating`);
      ws.terminate();
      return;
    }

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!isPlainObject(msg)) return;
    // Last line of defence: a bug reachable from client input must not take
    // the whole server (and every game on it) down.
    try {
      dispatch(ws, msg);
    } catch (err) {
      console.error(`[ws] handler error id=${ws._id} action=${String(msg.action).slice(0, 32)}`, err);
      send(ws, { event: 'error', code: 'SERVER_ERROR', message: 'Something went wrong' });
    }
  });

  ws.on('close', (_code) => {
    leaveQuickMatch(ws);
    handleDisconnect(ws);
    accountDisconnected(ws);
  });
  ws.on('error', (err) => {
    console.error(`[ws] error    id=${ws._id}`, err.message);
    ws.terminate();
  });
});

// ---- Message dispatch -------------------------------------------------------

// ---- Quick match: players waiting for the same kind of game are put in a
// room together, and the game starts at once.
const quickQueues = new Map();     // 'players:matchTo:cube' → [{ ws, name }]
function leaveQuickMatch(ws) {
  for (const [k, q] of quickQueues) {
    const i = q.findIndex(e => e.ws === ws);
    if (i >= 0) { q.splice(i, 1); if (!q.length) quickQueues.delete(k); }
  }
}
function quickMatch(ws, name, n, matchTo, cube) {
  leaveQuickMatch(ws);
  const key = `${n}:${matchTo}:${cube ? 1 : 0}`;
  const q = (quickQueues.get(key) ?? []).filter(e => e.ws.readyState === 1);
  q.push({ ws, name });
  quickQueues.set(key, q);
  if (q.length < n) {
    for (const e of q) send(e.ws, { event: 'quickMatchWaiting', waiting: q.length, need: n });
    return;
  }
  const group = q.splice(0, n);
  if (!q.length) quickQueues.delete(key);
  const [host, ...rest] = group;
  const room = createRoom(host.ws, host.name, n, undefined, { cube, matchTo });
  if (room.error) { for (const e of group) send(e.ws, { event: 'error', code: 'CREATE_FAILED', message: room.error }); return; }
  host.ws._room = room.code;
  send(host.ws, { event: 'roomCreated', ...room });
  for (const e of rest) {
    const j = joinRoom(e.ws, room.code, e.name);
    if (j.error) continue;
    e.ws._room = j.code;
    send(e.ws, { event: 'joinedRoom', ...j });
  }
  for (const e of group) send(e.ws, { event: 'quickMatchFound' });
  startGame(host.ws, room.roomId);
}

const KNOWN_ACTIONS = new Set([
  ...ACCOUNT_ACTIONS,
  'createRoom', 'joinRoom', 'addRobot', 'removeRobot', 'startGame',
  'roll', 'move', 'forfeitDie', 'undo', 'commit', 'reconnect', 'analyzeGame',
  'double', 'take', 'drop', 'rematch', 'quit', 'chat', 'swapSeats', 'quickMatch', 'quickMatchCancel', 'resign', 'resignAnswer', 'analyzeDeeper', 'playOutAll', 'analyzeDeeperCube', 'analyzeMatch',
]);

const WATCHER_BLOCKED = new Set(['roll', 'move', 'forfeitDie', 'undo', 'commit', 'double', 'take', 'drop', 'resign', 'resignAnswer', 'rematch', 'swapSeats', 'addRobot', 'removeRobot']);

function dispatch(ws, msg) {
  if (!KNOWN_ACTIONS.has(msg.action)) {
    send(ws, { event: 'error', code: 'UNKNOWN_ACTION' });
    return;
  }

  if (ACCOUNT_ACTIONS.has(msg.action)) {
    return handleAccountAction(ws, msg, { send, cleanName, roomCodeOf, seatAccount: seatAccountOf,
      serverStatus: () => ({ ...serverSnapshot(), uptimeMin: Math.round(process.uptime() / 60), memoryMB: Math.round(process.memoryUsage().rss / 1e6), errors: recentErrors.slice(-30) }),
      onOpenGame: (w, g) => send(w, { event: 'storedGame',
        game: { id: g.id, endedAt: g.endedAt, cube: g.cube, seats: g.seats, winnerSeat: g.winnerSeat },
        report: storedGameReport(g) }) });
  }

  // A watch-mode viewer only watches: no acting for the robot in their seat.
  if (WATCHER_BLOCKED.has(msg.action) && isWatcher(ws)) return;

  switch (msg.action) {
    case 'createRoom': {
      const name = playName(ws, msg.name);
      if (name === null) return send(ws, { event: 'error', code: 'NAME_TAKEN', message: 'That name belongs to a registered player. Choose another, or sign in.' });
      if (!name || msg.totalPlayers === undefined) return send(ws, { event: 'error', code: 'MISSING_FIELDS', message: 'Missing fields' });
      const n = Number(msg.totalPlayers);
      if (!Number.isInteger(n) || n < 2 || n > 6) return send(ws, { event: 'error', code: 'INVALID_PLAYER_COUNT', message: 'Players must be 2-6' });
      const hostColor = typeof msg.hostColor === 'string' ? msg.hostColor : undefined;
      const matchTo = Number.isInteger(msg.matchTo) && msg.matchTo >= 1 && msg.matchTo <= 25 ? msg.matchTo : 0;
      const watch = msg.watch === true;
      const result = createRoom(ws, name, n, hostColor, { cube: msg.cube === true, matchTo: watch ? 0 : matchTo, watch });
      if (result.error) return send(ws, { event: 'error', code: 'CREATE_FAILED', message: result.error });
      ws._room = result.code;
      send(ws, { event: 'roomCreated', ...result });
      if (watch) startGame(ws, result.roomId);
      break;
    }

    case 'joinRoom': {
      const name = playName(ws, msg.name);
      if (name === null) return send(ws, { event: 'error', code: 'NAME_TAKEN', message: 'That name belongs to a registered player. Choose another, or sign in.' });
      const code = typeof msg.code === 'string' ? msg.code.toUpperCase().trim().slice(0, 16) : '';
      if (!code || !name) return send(ws, { event: 'error', code: 'MISSING_FIELDS', message: 'Missing fields' });
      const result = joinRoom(ws, code, name);
      if (result.error) {
        ws._failedJoins = (ws._failedJoins ?? 0) + 1;
        if (ws._failedJoins > MAX_FAILED_JOINS) { ws.terminate(); return; }
        return send(ws, { event: 'error', code: 'JOIN_FAILED', message: result.error });
      }
      ws._room = result.code;
      send(ws, { event: 'joinedRoom', ...result });
      break;
    }

    case 'addRobot': {
      const roomId = getRoomByWs(ws);
      if (!roomId) return;
      const result = addRobot(ws, roomId);
      if (result.error) send(ws, { event: 'error', code: 'ADD_ROBOT_FAILED', message: result.error });
      break;
    }

    case 'removeRobot': {
      const roomId = getRoomByWs(ws);
      if (!roomId) return;
      const result = removeRobot(ws, roomId, msg.playerIndex);
      if (result?.error) send(ws, { event: 'error', code: 'REMOVE_ROBOT_FAILED', message: result.error });
      break;
    }

    case 'startGame': {
      const roomId = getRoomByWs(ws);
      if (!roomId) return;
      const result = startGame(ws, roomId);
      if (result.error) send(ws, { event: 'error', code: 'START_FAILED', message: result.error });
      break;
    }

    case 'double':
    case 'take':
    case 'drop': {
      const roomId = getRoomByWs(ws);
      if (!roomId) return;
      ({ double: handleDouble, take: handleTake, drop: handleDrop })[msg.action](ws, roomId);
      break;
    }

    case 'resign': {
      const roomId = getRoomByWs(ws);
      if (roomId) handleResign(ws, roomId, msg.mult);
      return;
    }
    case 'resignAnswer': {
      const roomId = getRoomByWs(ws);
      if (roomId) handleResignAnswer(ws, roomId, msg.accept === true);
      return;
    }
    case 'swapSeats': {
      const roomId = getRoomByWs(ws);
      if (roomId) handleSwapSeats(ws, roomId, msg.a, msg.b);
      return;
    }
    case 'chat': {
      const roomId = getRoomByWs(ws);
      if (roomId) handleChat(ws, roomId, msg.text);
      return;
    }
    case 'quickMatch': {
      const name = playName(ws, msg.name);
      if (name === null) return send(ws, { event: 'error', code: 'NAME_TAKEN', message: 'That name belongs to a registered player. Choose another, or sign in.' });
      if (!name) return send(ws, { event: 'error', code: 'MISSING_FIELDS', message: 'Missing fields' });
      const n = Number(msg.players);
      if (!Number.isInteger(n) || n < 2 || n > 6) return send(ws, { event: 'error', code: 'INVALID_PLAYER_COUNT', message: 'Players must be 2-6' });
      const matchTo = n === 2 && Number.isInteger(msg.matchTo) && msg.matchTo >= 1 && msg.matchTo <= 25 ? msg.matchTo : 0;
      const cube = n === 2 && (matchTo ? matchTo >= 2 : msg.cube === true);
      return quickMatch(ws, name, n, matchTo, cube);
    }
    case 'quickMatchCancel':
      leaveQuickMatch(ws);
      return send(ws, { event: 'quickMatchCancelled' });
    case 'quit': {
      const roomId = getRoomByWs(ws);
      if (roomId) handleQuit(ws, roomId);
      return;
    }
    case 'rematch': {
      const roomId = getRoomByWs(ws);
      if (!roomId) return;
      const result = handleRematch(ws, roomId);
      if (result?.error) send(ws, { event: 'error', code: 'REMATCH_FAILED', message: result.error });
      break;
    }

    case 'roll': {
      const roomId = getRoomByWs(ws);
      if (!roomId) return;
      handleRoll(ws, roomId);
      break;
    }

    case 'move': {
      const roomId = getRoomByWs(ws);
      if (!roomId) return;
      handleMove(ws, roomId, msg.move);
      break;
    }

    case 'forfeitDie': {
      const roomId = getRoomByWs(ws);
      if (!roomId) return;
      handleForfeitDie(ws, roomId, msg.dieIndex);
      break;
    }

    case 'undo': {
      const roomId = getRoomByWs(ws);
      if (!roomId) return;
      handleUndo(ws, roomId);
      break;
    }

    case 'commit': {
      const roomId = getRoomByWs(ws);
      if (!roomId) return;
      handleCommit(ws, roomId);
      break;
    }

    case 'analyzeDeeper': {
      const roomId = getRoomByWs(ws);
      if (!roomId) return;
      const idx = Number(msg.idx);
      if (!Number.isInteger(idx) || idx < 0 || idx > 10000) return send(ws, { event: 'error', code: 'MISSING_FIELDS', message: 'Bad decision index' });
      handleAnalyzeDeeper(ws, roomId, idx, gameNum(msg));
      break;
    }

    case 'analyzeDeeperCube': {
      const roomId = getRoomByWs(ws);
      const i = Number(msg.i);
      if (roomId && Number.isInteger(i) && i >= 0 && i < 1000) handleAnalyzeDeeperCube(ws, roomId, i, gameNum(msg));
      break;
    }

    case 'analyzeMatch': {
      const roomId = getRoomByWs(ws);
      if (roomId) handleAnalyzeMatch(ws, roomId);
      break;
    }

    case 'playOutAll': {
      const roomId = getRoomByWs(ws);
      if (roomId) handlePlayOutAll(ws, roomId, gameNum(msg));
      break;
    }

    case 'analyzeGame': {
      const roomId = getRoomByWs(ws);
      if (!roomId) return;
      handleAnalyzeGame(ws, roomId, gameNum(msg));
      break;
    }

    case 'reconnect': {
      const { roomId, playerIndex, reconnectToken } = msg;
      if (typeof roomId !== 'string' || typeof reconnectToken !== 'string') {
        return send(ws, { event: 'error', code: 'RECONNECT_FAILED', message: 'Invalid reconnect' });
      }
      ws._room = roomId;
      const result = handleReconnect(ws, roomId, playerIndex, reconnectToken);
      if (result && result.error) send(ws, { event: 'error', code: result.error === 'GONE' ? 'GAME_GONE' : 'RECONNECT_FAILED', message: result.error === 'GONE' ? 'That game is no longer on the server.' : result.error });
      break;
    }
  }
}

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

server.listen(PORT, HOST, () => {
  const addr = server.address();
  console.log(`TurboMarbles listening on http://${addr.address}:${addr.port}`);
});
