import express from 'express';
import helmet from 'helmet';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  createRoom, joinRoom, addRobot, removeRobot, startGame,
  handleRoll, handleMove, handleForfeitDie,
  handleDisconnect, handleReconnect, getRoomByWs,
  handleUndo, handleCommit, handleAnalyzeGame,
} from './GameManager.js';

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

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

const app = express();
app.disable('x-powered-by');
app.use(helmet());



app.use(express.static(join(__dirname, '..', 'public')));

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
    handleDisconnect(ws);
  });
  ws.on('error', (err) => {
    console.error(`[ws] error    id=${ws._id}`, err.message);
    ws.terminate();
  });
});

// ---- Message dispatch -------------------------------------------------------

const KNOWN_ACTIONS = new Set([
  'createRoom', 'joinRoom', 'addRobot', 'removeRobot', 'startGame',
  'roll', 'move', 'forfeitDie', 'undo', 'commit', 'reconnect', 'analyzeGame',
]);

function dispatch(ws, msg) {
  if (!KNOWN_ACTIONS.has(msg.action)) {
    send(ws, { event: 'error', code: 'UNKNOWN_ACTION' });
    return;
  }

  switch (msg.action) {
    case 'createRoom': {
      const name = cleanName(msg.name);
      if (!name || msg.totalPlayers === undefined) return send(ws, { event: 'error', code: 'MISSING_FIELDS', message: 'Missing fields' });
      const n = Number(msg.totalPlayers);
      if (!Number.isInteger(n) || n < 2 || n > 6) return send(ws, { event: 'error', code: 'INVALID_PLAYER_COUNT', message: 'Players must be 2-6' });
      const hostColor = typeof msg.hostColor === 'string' ? msg.hostColor : undefined;
      const result = createRoom(ws, name, n, hostColor);
      if (result.error) return send(ws, { event: 'error', code: 'CREATE_FAILED', message: result.error });
      ws._room = result.code;
      send(ws, { event: 'roomCreated', ...result });
      break;
    }

    case 'joinRoom': {
      const name = cleanName(msg.name);
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

    case 'analyzeGame': {
      const roomId = getRoomByWs(ws);
      if (!roomId) return;
      handleAnalyzeGame(ws, roomId);
      break;
    }

    case 'reconnect': {
      const { roomId, playerIndex, reconnectToken } = msg;
      if (typeof roomId !== 'string' || typeof reconnectToken !== 'string') {
        return send(ws, { event: 'error', code: 'RECONNECT_FAILED', message: 'Invalid reconnect' });
      }
      ws._room = roomId;
      const result = handleReconnect(ws, roomId, playerIndex, reconnectToken);
      if (result && result.error) send(ws, { event: 'error', code: 'RECONNECT_FAILED', message: result.error });
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
