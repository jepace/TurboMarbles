// GameManager.js — room registry, session tracking, disconnect timers

import {
  createGame, rollDice, allLegalMoves, applyMove,
  earnsExtraRoll, nextTurn, startExtraRoll, PLAYER_CONFIG,
} from './GameEngine.js';
import { robotTakeTurn } from './RobotPlayer.js';

const DISCONNECT_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
const ROBOT_TURN_DELAY_MS   = 800;            // brief pause so it feels natural

const rooms = new Map();   // roomId → Room
const sessions = new Map(); // wsId → { roomId, playerIndex }

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function genId() {
  return Math.random().toString(36).slice(2, 10);
}

// ---------- Room structure ----------
// {
//   id, code, hostId,
//   slots: [{ index, playerId|null, name, color, isRobot, ws|null }],
//   totalPlayers,
//   state: 'lobby' | 'playing' | 'finished',
//   game: GameEngine state | null,
//   disconnectTimers: Map<playerIndex, timer>,
// }

export function createRoom(hostWs, hostName, totalPlayers) {
  const roomId = genId();
  let code;
  do { code = genCode(); } while ([...rooms.values()].some(r => r.code === code));

  const hostId = genId();
  sessions.set(hostWs._id, { roomId, playerIndex: 0 });

  const slots = Array.from({ length: totalPlayers }, (_, i) => ({
    index: i,
    playerId: i === 0 ? hostId : null,
    name: i === 0 ? hostName : null,
    color: PLAYER_CONFIG[i].color,
    isRobot: false,
    ws: i === 0 ? hostWs : null,
  }));

  const room = {
    id: roomId, code, hostId,
    slots, totalPlayers,
    state: 'lobby',
    game: null,
    disconnectTimers: new Map(),
  };
  rooms.set(roomId, room);
  return { roomId, code };
}

export function joinRoom(ws, code, playerName) {
  const room = [...rooms.values()].find(r => r.code === code && r.state === 'lobby');
  if (!room) return { error: 'Room not found or already started' };

  const slot = room.slots.find(s => !s.isRobot && !s.playerId && s.index !== 0);
  if (!slot) return { error: 'Room is full' };

  const playerId = genId();
  slot.playerId = playerId;
  slot.name = playerName;
  slot.ws = ws;
  sessions.set(ws._id, { roomId: room.id, playerIndex: slot.index });

  // Exclude the joining player — they'll get lobbyState via joinedRoom instead
  broadcast(room, {
    event: 'playerJoined',
    playerIndex: slot.index,
    name: playerName,
    color: slot.color,
  }, ws);

  return { roomId: room.id, playerIndex: slot.index, lobbyState: lobbySnapshot(room) };
}

export function addRobot(ws, roomId) {
  const room = rooms.get(roomId);
  if (!room || room.state !== 'lobby') return { error: 'Invalid room' };
  if (!isHost(ws, room)) return { error: 'Only host can add robots' };

  const slot = room.slots.find(s => !s.playerId && !s.isRobot);
  if (!slot) return { error: 'No empty slots' };

  slot.isRobot = true;
  slot.name = `Robot ${slot.index + 1}`;
  slot.playerId = 'robot-' + slot.index;

  broadcast(room, {
    event: 'playerJoined',
    playerIndex: slot.index,
    name: slot.name,
    color: slot.color,
    isRobot: true,
  });

  return { ok: true };
}

export function startGame(ws, roomId) {
  const room = rooms.get(roomId);
  if (!room || room.state !== 'lobby') return { error: 'Invalid room' };
  if (!isHost(ws, room)) return { error: 'Only host can start' };
  if (room.slots.some(s => !s.playerId && !s.isRobot)) return { error: 'Unfilled slots remain' };

  const players = room.slots.map(s => ({
    id: s.playerId,
    name: s.name,
    color: s.color,
    isRobot: s.isRobot,
  }));

  room.game = createGame(players);
  room.state = 'playing';

  broadcast(room, { event: 'gameStarted', gameState: publicState(room) });
  scheduleCurrentTurn(room);
  return { ok: true };
}

// ---------- In-game actions ----------

export function handleRoll(ws, roomId) {
  const room = rooms.get(roomId);
  if (!room || room.state !== 'playing') return;
  const { game } = room;
  if (game.phase !== 'IN_TURN' && game.phase !== 'EXTRA_ROLL') return;

  const sess = sessions.get(ws._id);
  if (!sess || sess.playerIndex !== game.turnIndex) return;

  const dice = rollDice();
  game.dice = dice;
  game.diceUsed = [false, false];
  game.phase = 'AWAITING_MOVE';

  broadcast(room, { event: 'rolled', playerIndex: game.turnIndex, dice });
}

export function handleMove(ws, roomId, move) {
  const room = rooms.get(roomId);
  if (!room || room.state !== 'playing') return;
  const { game } = room;
  if (game.phase !== 'AWAITING_MOVE') return;

  const sess = sessions.get(ws._id);
  if (!sess || sess.playerIndex !== game.turnIndex) return;

  const result = tryApplyMove(room, game.turnIndex, move);
  if (result.error) {
    sendTo(ws, { event: 'error', code: 'ILLEGAL_MOVE', message: result.error });
  }
}

export function handleForfeitDie(ws, roomId, dieIndex) {
  const room = rooms.get(roomId);
  if (!room || room.state !== 'playing') return;
  const { game } = room;
  if (game.phase !== 'AWAITING_MOVE') return;

  const sess = sessions.get(ws._id);
  if (!sess || sess.playerIndex !== game.turnIndex) return;

  // Only valid if no legal moves exist for that die
  const legal = allLegalMoves(game, game.turnIndex);
  if (legal[dieIndex] && legal[dieIndex].length > 0) {
    sendTo(ws, { event: 'error', code: 'ILLEGAL_FORFEIT', message: 'Legal moves exist' });
    return;
  }

  game.diceUsed[dieIndex] = true;
  advanceTurnIfDone(room);
}

// ---------- Disconnect handling ----------

export function handleDisconnect(ws) {
  const sess = sessions.get(ws._id);
  if (!sess) return;
  sessions.delete(ws._id);

  const room = rooms.get(sess.roomId);
  if (!room) return;

  const slot = room.slots[sess.playerIndex];
  if (!slot || slot.isRobot) return;
  slot.ws = null;

  if (room.state === 'lobby') {
    // Remove from lobby
    slot.playerId = null;
    slot.name = null;
    broadcast(room, { event: 'playerLeft', playerIndex: sess.playerIndex });
    return;
  }

  // In-game: start disconnect timer
  broadcast(room, { event: 'playerDisconnected', playerIndex: sess.playerIndex, timeoutMs: DISCONNECT_TIMEOUT_MS });

  const timer = setTimeout(() => {
    slot.isRobot = true;
    broadcast(room, { event: 'robotTookOver', playerIndex: sess.playerIndex });
    // If it's currently this player's turn, proceed with robot
    if (room.game && room.game.turnIndex === sess.playerIndex) {
      scheduleCurrentTurn(room);
    }
  }, DISCONNECT_TIMEOUT_MS);

  room.disconnectTimers.set(sess.playerIndex, timer);
}

export function handleReconnect(ws, roomId, playerIndex, playerName) {
  const room = rooms.get(roomId);
  if (!room || room.state !== 'playing') return { error: 'Invalid room' };

  const slot = room.slots[playerIndex];
  if (!slot || slot.isRobot) return { error: 'Slot not available' };
  if (slot.name !== playerName) return { error: 'Name mismatch' };

  // Cancel disconnect timer
  const timer = room.disconnectTimers.get(playerIndex);
  if (timer) { clearTimeout(timer); room.disconnectTimers.delete(playerIndex); }

  slot.ws = ws;
  sessions.set(ws._id, { roomId, playerIndex });

  sendTo(ws, { event: 'reconnected', gameState: publicState(room) });
  broadcast(room, { event: 'playerReconnected', playerIndex }, ws);
  return { ok: true };
}

// ---------- Internal helpers ----------

function tryApplyMove(room, playerIndex, move) {
  const { game } = room;
  const legal = allLegalMoves(game, playerIndex);
  const validForDie = (legal[move.dieIndex] || []);
  const matched = validForDie.find(m =>
    m.type === move.type &&
    m.marbleId === move.marbleId &&
    (move.toStar === undefined || m.toStar === move.toStar)
  );
  if (!matched) return { error: 'Move not in legal set' };

  const events = applyMove(game, playerIndex, matched);
  events.forEach(ev => broadcast(room, ev));

  if (game.phase === 'GAME_OVER') {
    room.state = 'finished';
    return { ok: true };
  }

  advanceTurnIfDone(room);
  return { ok: true };
}

function advanceTurnIfDone(room) {
  const { game } = room;
  if (game.diceUsed[0] && game.diceUsed[1]) {
    if (earnsExtraRoll(game.dice)) {
      startExtraRoll(game);
      broadcast(room, { event: 'extraRoll', playerIndex: game.turnIndex });
    } else {
      nextTurn(game);
      broadcast(room, { event: 'turnChanged', playerIndex: game.turnIndex });
    }
    scheduleCurrentTurn(room);
  }
}

function scheduleCurrentTurn(room) {
  const { game } = room;
  if (!game || game.phase === 'GAME_OVER') return;
  const slot = room.slots[game.turnIndex];
  if (slot.isRobot) {
    setTimeout(() => doRobotTurn(room), ROBOT_TURN_DELAY_MS);
  }
  // Human turn: wait for client to send 'roll'
}

function doRobotTurn(room) {
  const { game } = room;
  if (!game || game.phase === 'GAME_OVER') return;
  if (game.phase === 'IN_TURN' || game.phase === 'EXTRA_ROLL') {
    // Roll
    const dice = rollDice();
    game.dice = dice;
    game.diceUsed = [false, false];
    game.phase = 'AWAITING_MOVE';
    broadcast(room, { event: 'rolled', playerIndex: game.turnIndex, dice });
  }

  // Apply robot moves
  robotTakeTurn(game, game.turnIndex, (move) => {
    if (!move) {
      // Forfeit remaining dice
      game.diceUsed = [true, true];
    } else {
      const events = applyMove(game, game.turnIndex, move);
      events.forEach(ev => broadcast(room, ev));
    }
  });

  if (game.phase === 'GAME_OVER') { room.state = 'finished'; return; }

  advanceTurnIfDone(room);
}

function isHost(ws, room) {
  return room.slots[0].ws === ws;
}

function broadcast(room, msg, excludeWs = null) {
  const data = JSON.stringify(msg);
  for (const slot of room.slots) {
    if (slot.ws && slot.ws !== excludeWs && slot.ws.readyState === 1) {
      slot.ws.send(data);
    }
  }
}

function sendTo(ws, msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

export function getLobbyState(ws) {
  const sess = sessions.get(ws._id);
  if (!sess) return null;
  const room = rooms.get(sess.roomId);
  if (!room) return null;
  return lobbySnapshot(room);
}

function lobbySnapshot(room) {
  return {
    code: room.code,
    totalPlayers: room.totalPlayers,
    slots: room.slots.map(s => ({
      index: s.index,
      name: s.name,
      color: s.color,
      isRobot: s.isRobot,
      filled: !!s.playerId,
    })),
  };
}

function publicState(room) {
  const { game } = room;
  return {
    players: game.players.map((p, i) => ({
      index: i,
      name: room.slots[i].name,
      color: p.config.color,
      isRobot: room.slots[i].isRobot,
      marbles: p.marbles,
    })),
    turnIndex: game.turnIndex,
    phase: game.phase,
    dice: game.dice,
    diceUsed: game.diceUsed,
  };
}

export function getRoomByWs(ws) {
  const sess = sessions.get(ws._id);
  return sess ? sess.roomId : null;
}
