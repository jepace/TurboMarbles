import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import {
  createRoom, joinRoom, addRobot, startGame,
  handleRoll, handleMove, handleForfeitDie,
  handleDisconnect, handleReconnect, getRoomByWs,
  handleUndo, handleCommit,
} from './GameManager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();

// Request logging
app.use((req, _res, next) => {
  console.log(`[http] ${req.method} ${req.url} from ${req.socket.remoteAddress}`);
  next();
});

app.use(express.static(join(__dirname, '..', 'public')));

const server = createServer(app);
const wss = new WebSocketServer({ server });

let nextWsId = 1;

wss.on('connection', (ws, req) => {
  ws._id = String(nextWsId++);
  console.log(`[ws] connect  id=${ws._id} from ${req.socket.remoteAddress}`);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    console.log(`[ws] message  id=${ws._id} action=${msg.action}`);
    dispatch(ws, msg);
  });

  ws.on('close', (code, reason) => {
    console.log(`[ws] close    id=${ws._id} code=${code}`);
    handleDisconnect(ws);
  });
  ws.on('error', (err) => {
    console.error(`[ws] error    id=${ws._id}`, err.message);
    ws.terminate();
  });
});

function dispatch(ws, msg) {
  switch (msg.action) {
    case 'createRoom': {
      const { name, totalPlayers } = msg;
      if (!name || !totalPlayers) return send(ws, { event: 'error', message: 'Missing fields' });
      const n = parseInt(totalPlayers, 10);
      if (n < 2 || n > 6) return send(ws, { event: 'error', message: 'Players must be 2-6' });
      const result = createRoom(ws, name.trim().slice(0, 20), n);
      send(ws, { event: 'roomCreated', ...result });
      break;
    }

    case 'joinRoom': {
      const { code, name } = msg;
      if (!code || !name) return send(ws, { event: 'error', message: 'Missing fields' });
      const result = joinRoom(ws, code.toUpperCase().trim(), name.trim().slice(0, 20));
      if (result.error) return send(ws, { event: 'error', message: result.error });
      send(ws, { event: 'joinedRoom', ...result });
      break;
    }

    case 'addRobot': {
      const roomId = getRoomByWs(ws);
      if (!roomId) return;
      const result = addRobot(ws, roomId);
      if (result.error) send(ws, { event: 'error', message: result.error });
      break;
    }

    case 'startGame': {
      const roomId = getRoomByWs(ws);
      if (!roomId) return;
      const result = startGame(ws, roomId);
      if (result.error) send(ws, { event: 'error', message: result.error });
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
      const result = handleReconnect(ws, roomId, playerIndex, reconnectToken);
      if (result && result.error) send(ws, { event: 'error', message: result.error });
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
