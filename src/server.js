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
  handleUndo, handleCommit,
} from './GameManager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT   = process.env.PORT   || 8080;
const HOST   = process.env.HOST   || '0.0.0.0';
// Set ORIGIN to your public URL (e.g. https://example.com) to enable origin
// checking.  Leave unset to allow all origins (dev / LAN use).
const ORIGIN = process.env.ORIGIN || null;

const app = express();
app.disable('x-powered-by');
app.use(helmet());

// Request logging
app.use((req, _res, next) => {
  console.log(`[http] ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
  next();
});

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

wss.on('connection', (ws, req) => {
  ws._id    = String(nextWsId++);
  ws._alive = true; // initialise for ping-pong

  // Per-connection rate limiting: token-bucket, refills every second.
  ws._msgCount       = 0;
  ws._msgWindowStart = Date.now();

  console.log(`[ws] connect  id=${ws._id} from ${req.socket.remoteAddress}`);

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
    const room = ws._room ? ` room=${ws._room}` : '';
    console.log(`[ws] message  id=${ws._id}${room} action=${msg.action}`);
    dispatch(ws, msg);
  });

  ws.on('close', (code) => {
    console.log(`[ws] close    id=${ws._id} code=${code}`);
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
  'roll', 'move', 'forfeitDie', 'undo', 'commit', 'reconnect',
]);

function dispatch(ws, msg) {
  if (!KNOWN_ACTIONS.has(msg.action)) {
    send(ws, { event: 'error', code: 'UNKNOWN_ACTION' });
    return;
  }

  switch (msg.action) {
    case 'createRoom': {
      const { name, totalPlayers, hostColor } = msg;
      if (!name || !totalPlayers) return send(ws, { event: 'error', code: 'MISSING_FIELDS', message: 'Missing fields' });
      const n = parseInt(totalPlayers, 10);
      if (n < 2 || n > 6) return send(ws, { event: 'error', code: 'INVALID_PLAYER_COUNT', message: 'Players must be 2-6' });
      const result = createRoom(ws, name.trim().slice(0, 20), n, hostColor);
      if (result.error) return send(ws, { event: 'error', code: 'CREATE_FAILED', message: result.error });
      ws._room = result.code;
      send(ws, { event: 'roomCreated', ...result });
      break;
    }

    case 'joinRoom': {
      const { code, name } = msg;
      if (!code || !name) return send(ws, { event: 'error', code: 'MISSING_FIELDS', message: 'Missing fields' });
      const result = joinRoom(ws, code.toUpperCase().trim(), name.trim().slice(0, 20));
      if (result.error) return send(ws, { event: 'error', code: 'JOIN_FAILED', message: result.error });
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

    case 'reconnect': {
      const { roomId, playerIndex, reconnectToken } = msg;
      if (roomId) ws._room = roomId;
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
