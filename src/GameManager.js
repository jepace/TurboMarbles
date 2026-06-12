// GameManager.js — room registry, session tracking, disconnect timers

import { randomBytes } from 'crypto';
import {
  createGame, rollDice, allLegalMoves, applyMove,
  earnsExtraRoll, nextTurn, startExtraRoll, PLAYER_CONFIG, ARM_MAP,
  MARBLES_PER_PLAYER,
} from './GameEngine.js';
import { robotTakeTurn } from './RobotPlayer.js';

const DISCONNECT_TIMEOUT_MS  = 2 * 60 * 1000; // 2 minutes
const ROBOT_TURN_DELAY_MS    = 800;            // brief pause so it feels natural
const MAX_TOTAL_ROOMS        = 200;            // global cap — prevents memory exhaustion
const MAX_ROOMS_PER_WS       = 3;             // per-connection cap
export const config = { skipTurnDelayMs: 1500 }; // show dice before auto-advancing a skipped turn

const rooms = new Map();    // roomId → Room
const sessions = new Map(); // wsId → { roomId, playerIndex }

function genCode() {
  // 32 printable chars; Math.random() excluded — use crypto PRNG so room codes
  // cannot be predicted even if an attacker observes many codes from the same process.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(4);
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

function genId() {
  // 128-bit token — unguessable even with knowledge of other tokens.
  return randomBytes(16).toString('hex');
}

// ---------- Room structure ----------
// {
//   id, code, hostId,
//   slots: [{ index, playerId|null, name, color, isRobot, ws|null }],
//   totalPlayers,
//   state: 'lobby' | 'playing' | 'finished',
//   game: GameEngine state | null,
//   disconnectTimers: Map<playerIndex, timer>,  // human reconnect grace timers
//   robotTurnTimer: TimeoutId | null,           // pending robot-move setTimeout handle
// }

export function createRoom(hostWs, hostName, totalPlayers, hostColor) {
  if (rooms.size >= MAX_TOTAL_ROOMS) return { error: 'Server is full' };
  hostWs._roomsCreated = (hostWs._roomsCreated ?? 0) + 1;
  if (hostWs._roomsCreated > MAX_ROOMS_PER_WS) return { error: 'Room limit reached' };

  const roomId = genId();
  let code;
  do { code = genCode(); } while ([...rooms.values()].some(r => r.code === code));

  const hostId = genId();
  sessions.set(hostWs._id, { roomId, playerIndex: 0 });

  const armMap = ARM_MAP[totalPlayers] ?? Array.from({ length: totalPlayers }, (_, i) => i);

  // Reorder so host's chosen arm (by color) is first
  const hostArmIndex = PLAYER_CONFIG.findIndex(c => c.color === hostColor);
  let orderedArmMap;
  if (hostArmIndex >= 0 && armMap.includes(hostArmIndex)) {
    orderedArmMap = [hostArmIndex, ...armMap.filter(a => a !== hostArmIndex)];
  } else {
    orderedArmMap = armMap;  // fallback: no change
  }

  const slots = Array.from({ length: totalPlayers }, (_, i) => ({
    index: i,
    playerId: i === 0 ? hostId : null,
    name: i === 0 ? hostName : null,
    color: PLAYER_CONFIG[orderedArmMap[i]].color,  // arm-mapped color so lobby matches game
    armIndex: orderedArmMap[i],
    isRobot: false,
    ws: i === 0 ? hostWs : null,
  }));

  const room = {
    id: roomId, code, hostId,
    slots, totalPlayers,
    state: 'lobby',
    game: null,
    disconnectTimers: new Map(),
    robotTurnTimer: null,
  };
  rooms.set(roomId, room);

  // Return the hostId as reconnectToken so the host can authenticate reconnects.
  // The client must store this and send it back in any 'reconnect' action.
  return { roomId, code, reconnectToken: hostId, color: slots[0].color, totalPlayers,
    slots: slots.map(s => ({ index: s.index, name: s.name, color: s.color, isRobot: s.isRobot, filled: !!s.playerId })) };
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

  // Return playerId as reconnectToken so the client can re-authenticate after
  // a disconnect.  The client must store this securely and send it back on
  // 'reconnect'.  Using a name-only check would allow impersonation.
  return { roomId: room.id, playerIndex: slot.index, lobbyState: lobbySnapshot(room), reconnectToken: playerId };
}

export function addRobot(ws, roomId) {
  const room = rooms.get(roomId);
  if (!room || room.state !== 'lobby') return { error: 'Invalid room' };
  if (!isHost(ws, room)) return { error: 'Only host can add robots' };

  const slot = room.slots.find(s => !s.playerId && !s.isRobot);
  if (!slot) return { error: 'No empty slots' };

  slot.isRobot = true;
  const robotNumber = room.slots.filter(s => s.isRobot).length;
  slot.name = `Robot ${robotNumber}`;
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

export function removeRobot(ws, roomId, playerIndex) {
  const room = rooms.get(roomId);
  if (!room || room.state !== 'lobby') return { error: 'Invalid room' };
  if (!isHost(ws, room)) return { error: 'Only host can remove robots' };
  const slot = room.slots[playerIndex];
  if (!slot || !slot.isRobot) return { error: 'Not a robot slot' };
  slot.isRobot = false;
  slot.name = null;
  slot.playerId = null;
  broadcast(room, { event: 'playerLeft', playerIndex });
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

  room.game = createGame(players, room.slots.map(s => s.armIndex));
  room.state = 'playing';

  broadcast(room, { event: 'gameStarted', gameState: publicState(room) });
  scheduleCurrentTurn(room);
  return { ok: true };
}

// ---------- Shared roll helper ----------

// Performs a dice roll and transitions game to AWAITING_MOVE.
// Called by both human handleRoll() and doRobotTurn() so roll logic stays in one place.
function performRoll(game) {
  const dice = rollDice();
  game.dice = dice;
  game.diceUsed = [false, false];
  game.phase = 'AWAITING_MOVE';
  game._humanMadeMove = false;
  game._committed = false; // guard: reject undo after commitTurn fires
  // Snapshot marble positions for undo support
  game._rollSnapshot = game.players.map(p => p.marbles.map(m => ({ ...m })));
  game._undoStack = []; // reset undo stack on new roll
  return dice;
}

// ---------- In-game actions ----------

export function handleRoll(ws, roomId) {
  const room = rooms.get(roomId);
  if (!room || room.state !== 'playing') return;
  const { game } = room;

  // Only allow rolling during IN_TURN (start of turn) or EXTRA_ROLL (earned by rolling a 6).
  // Phase flow: IN_TURN → (roll) → AWAITING_MOVE → (all dice used) → IN_TURN or EXTRA_ROLL
  if (game.phase !== 'IN_TURN' && game.phase !== 'EXTRA_ROLL') return;

  // Only the current turn's player may roll.
  const sess = sessions.get(ws._id);
  if (!sess || sess.playerIndex !== game.turnIndex) return;

  // Guard: if dice are already set the player has already rolled this turn.
  // Without this check a client could re-roll to fish for a better result.
  if (game.dice) return;

  const dice = performRoll(game);
  // Compute legal moves and include in the event so clients can highlight destinations.
  const moves = allLegalMoves(game, game.turnIndex);
  broadcast(room, { event: 'rolled', playerIndex: game.turnIndex, dice, moves });
  // Auto-forfeit and advance turn if this roll leaves no legal moves (e.g. all marbles
  // in base with a 3+4 roll).  No-op when at least one die has available moves.
  advanceTurnIfDone(room);
}

export function handleMove(ws, roomId, move) {
  const room = rooms.get(roomId);
  if (!room || room.state !== 'playing') return;
  const { game } = room;

  // Moves are only accepted after the player has rolled (AWAITING_MOVE).
  if (game.phase !== 'AWAITING_MOVE') return;

  // Only the current turn's player may move.
  const sess = sessions.get(ws._id);
  if (!sess || sess.playerIndex !== game.turnIndex) return;

  // Validate the move against the legal set before applying it.
  // Illegal moves are reported back to the sender only (not broadcast).
  const result = tryApplyMove(room, game.turnIndex, move);
  if (result.error) {
    console.warn(`[game] illegal move room=${roomId} player=${sess.playerIndex} move=${JSON.stringify(move)} error=${result.error}`);
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

  // Validate dieIndex is exactly 0 or 1 — reject strings, undefined, out-of-range.
  const idx = Number(dieIndex);
  if (idx !== 0 && idx !== 1) return;

  // A player may only forfeit a die when there are genuinely no legal moves for it.
  // This prevents using forfeit as a way to skip a die that has valid plays.
  const legal = allLegalMoves(game, game.turnIndex);
  if (legal[idx] && legal[idx].length > 0) {
    sendTo(ws, { event: 'error', code: 'ILLEGAL_FORFEIT', message: 'Legal moves exist' });
    return;
  }

  game.diceUsed[idx] = true;
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
    // Remove from lobby immediately — slot becomes available for another player
    slot.playerId = null;
    slot.name = null;
    broadcast(room, { event: 'playerLeft', playerIndex: sess.playerIndex });
    cleanupIfAbandoned(room); // delete the room if no humans remain
    return;
  }

  // In-game: give the player DISCONNECT_TIMEOUT_MS to reconnect before handing
  // their slot to a robot.
  broadcast(room, { event: 'playerDisconnected', playerIndex: sess.playerIndex, timeoutMs: DISCONNECT_TIMEOUT_MS });

  const timer = setTimeout(() => {
    room.disconnectTimers.delete(sess.playerIndex);
    slot.isRobot = true;
    broadcast(room, { event: 'robotTookOver', playerIndex: sess.playerIndex });

    // If this takeover leaves no humans in the game, nobody is watching — clean up.
    if (cleanupIfAbandoned(room)) return;

    // If it's currently this player's turn, schedule the robot to move.
    if (room.game && room.game.turnIndex === sess.playerIndex) {
      scheduleCurrentTurn(room);
    }
  }, DISCONNECT_TIMEOUT_MS);

  room.disconnectTimers.set(sess.playerIndex, timer);
}

export function handleReconnect(ws, roomId, playerIndex, reconnectToken) {
  const room = rooms.get(roomId);
  if (!room || room.state !== 'playing') return { error: 'Invalid room' };

  const pi = Number(playerIndex);
  if (!Number.isInteger(pi) || pi < 0 || pi >= room.slots.length) return { error: 'Invalid player index' };
  const slot = room.slots[pi];
  if (!slot || slot.isRobot) return { error: 'Slot not available' };

  // Validate using the playerId issued at join time, not just the player name.
  // A name-only check would allow any client who knows the name to hijack the slot.
  if (!reconnectToken || slot.playerId !== reconnectToken) return { error: 'Invalid token' };

  // Cancel disconnect timer — the player made it back in time
  const timer = room.disconnectTimers.get(playerIndex);
  if (timer) { clearTimeout(timer); room.disconnectTimers.delete(playerIndex); }

  slot.ws = ws;
  sessions.set(ws._id, { roomId, playerIndex });

  sendTo(ws, { event: 'reconnected', gameState: publicState(room) });
  broadcast(room, { event: 'playerReconnected', playerIndex }, ws);
  return { ok: true };
}

// ---------- Room lifecycle ----------

// Returns the number of human (non-robot) players that have been assigned a slot.
// Robots and empty slots don't count.
function humanCount(room) {
  return room.slots.filter(s => s.playerId && !s.isRobot).length;
}

// Delete the room if no human players remain.
// Called after any event that could reduce the human count to zero:
//   - a human leaves the lobby
//   - a human's disconnect timer fires (robot takeover) and they were the last human
// Cancels all pending timers before deleting so nothing fires against a dead room.
// Returns true if the room was deleted.
function cleanupIfAbandoned(room) {
  if (humanCount(room) > 0) return false;
  if (room.robotTurnTimer) { clearTimeout(room.robotTurnTimer); room.robotTurnTimer = null; }
  for (const t of room.disconnectTimers.values()) clearTimeout(t);
  rooms.delete(room.id);
  return true;
}

// ---------- Internal helpers ----------

// Basic shape validation for incoming move objects.
// Catches obviously malformed messages before they reach the legal-set lookup.
function validateMoveShape(move) {
  if (!move || typeof move !== 'object') return 'Move must be an object';
  const idx = Number(move.dieIndex);
  if (idx !== 0 && idx !== 1) return 'dieIndex must be 0 or 1';
  const mid = Number(move.marbleId);
  if (!Number.isInteger(mid) || mid < 0 || mid > 3) return 'marbleId must be 0–3';
  if (move.toSpace !== undefined) {
    const sp = Number(move.toSpace);
    if (!Number.isInteger(sp) || sp < 1 || sp > 84) return 'toSpace must be 1–84';
  }
  if (move.toSlot !== undefined) {
    const sl = Number(move.toSlot);
    if (!Number.isInteger(sl) || sl < 1 || sl > 4) return 'toSlot must be 1–4';
  }
  return null; // valid
}

// Validate `move` against the computed legal set, then apply it.
// We re-derive legal moves server-side so clients cannot send arbitrary moves.
// For moveStar moves the client must specify toZone+toSpace (or toSlot) because
// multiple star-track destinations may share the same type/marbleId/dieIndex.
function tryApplyMove(room, playerIndex, move) {
  const { game } = room;

  // Reject obviously malformed move objects before touching game state.
  const shapeError = validateMoveShape(move);
  if (shapeError) return { error: shapeError };

  const idx = Number(move.dieIndex); // already validated as 0 or 1 by validateMoveShape

  const legal = allLegalMoves(game, playerIndex);
  const validForDie = (legal[idx] || []);
  const matched = validForDie.find(m =>
    m.type === move.type &&
    m.marbleId === move.marbleId &&
    m.dieIndex === idx &&
    (move.toStar  === undefined || m.toStar  === move.toStar)  &&
    (move.toZone  === undefined || m.toZone  === move.toZone)  &&
    (move.toSpace === undefined || m.toSpace === move.toSpace) &&
    (move.toSlot  === undefined || m.toSlot  === move.toSlot)
  );
  if (!matched) return { error: 'Move not in legal set' };

  // Save state before move for undo support (LIFO: last move undone first)
  game._undoStack.push({
    marbles: game.players.map(p => p.marbles.map(m => ({ ...m }))),
    diceUsed: [...game.diceUsed],
  });

  const events = applyMove(game, playerIndex, matched);
  events.forEach(ev => broadcast(room, ev));
  game._humanMadeMove = true;

  if (game.phase === 'GAME_OVER') {
    room.state = 'finished';
    return { ok: true };
  }

  advanceTurnIfDone(room);

  // If the same player still has moves left, send them updated legal moves so they
  // can highlight valid destinations for the remaining die.
  if (game.phase === 'AWAITING_MOVE' && game.turnIndex === playerIndex) {
    const ws = room.slots[playerIndex]?.ws;
    const moves = allLegalMoves(game, playerIndex);
    sendTo(ws, { event: 'legalMoves', moves, diceUsed: game.diceUsed });
  }

  return { ok: true };
}

// Called after every move or forfeit. When both dice are consumed:
//   - For robots: immediately advance turn or award extra roll.
//   - For humans who made a move: broadcast readyToCommit (wait for explicit commit).
//   - For humans who made no move (all dice forfeited): auto-advance + log turn skip.
function advanceTurnIfDone(room) {
  const { game } = room;

  // Auto-forfeit remaining dice that have no legal moves, but ONLY when the other die
  // is also consumed or empty. This prevents eagerly forfeiting die=2 when die=6 hasn't
  // been used yet — using die=6 first might open up die=2 moves.
  if (!game.diceUsed[0] || !game.diceUsed[1]) {
    const legal = allLegalMoves(game, game.turnIndex);
    for (let i = 0; i < 2; i++) {
      if (!game.diceUsed[i] && (!legal[i] || legal[i].length === 0)) {
        const j = 1 - i;
        if (game.diceUsed[j] || !legal[j] || legal[j].length === 0) {
          game.diceUsed[i] = true;
          broadcast(room, { event: 'dieForfeit', dieIndex: i });
        }
      }
    }
  }

  if (game.diceUsed[0] && game.diceUsed[1]) {
    const slot = room.slots[game.turnIndex];
    const isRobot = slot?.isRobot ?? false;
    if (!isRobot && game._humanMadeMove) {
      // Human made at least one move — wait for explicit commit before advancing turn
      broadcast(room, { event: 'readyToCommit', playerIndex: game.turnIndex });
    } else {
      // Robot, or human with no legal moves at all — auto-advance
      if (!isRobot && !game._humanMadeMove) {
        // Human turn with zero legal moves: show dice briefly before advancing
        broadcast(room, { event: 'turnSkipped', playerIndex: game.turnIndex });
        if (config.skipTurnDelayMs > 0) {
          setTimeout(() => commitTurn(room), config.skipTurnDelayMs);
        } else {
          commitTurn(room);
        }
      } else {
        commitTurn(room);
      }
    }
  }
}

// Advance to the next turn (extra roll or next player). Called by commitTurn and robots.
function commitTurn(room) {
  const { game } = room;
  game._committed = true; // prevent undo from popping the stack after turn has advanced
  if (earnsExtraRoll(game.dice)) {
    startExtraRoll(game);
    broadcast(room, { event: 'extraRoll', playerIndex: game.turnIndex });
  } else {
    nextTurn(game);
    broadcast(room, { event: 'turnChanged', playerIndex: game.turnIndex });
  }
  scheduleCurrentTurn(room);
}

function scheduleCurrentTurn(room) {
  const { game } = room;
  if (!game || game.phase === 'GAME_OVER') return;

  // Cancel any previously scheduled robot timer.  Without this, rapid phase
  // transitions (e.g. extra-roll chains) could stack multiple pending timers
  // causing the robot to take several moves in quick succession.
  if (room.robotTurnTimer) {
    clearTimeout(room.robotTurnTimer);
    room.robotTurnTimer = null;
  }

  const slot = room.slots[game.turnIndex];
  if (slot.isRobot) {
    room.robotTurnTimer = setTimeout(() => {
      room.robotTurnTimer = null;
      doRobotTurn(room);
    }, ROBOT_TURN_DELAY_MS);
  }
  // Human turn: nothing to schedule — wait for client to send 'roll'
}

function doRobotTurn(room) {
  const { game } = room;
  if (!game || game.phase === 'GAME_OVER') return;

  // Roll using the shared helper (same logic path as a human roll)
  if (game.phase === 'IN_TURN' || game.phase === 'EXTRA_ROLL') {
    const dice = performRoll(game);
    broadcast(room, { event: 'rolled', playerIndex: game.turnIndex, dice });
  }

  // robotTakeTurn calls applyCallback for each die it uses.
  // null callback means no legal move found — the die is already forfeited inside
  // robotTakeTurn; we just broadcast the events for any moves that were made.
  robotTakeTurn(game, game.turnIndex, (move) => {
    if (move) {
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
      try {
        slot.ws.send(data);
      } catch (err) {
        // Closed sockets are expected; anything else is a real error worth logging.
        if (slot.ws.readyState === 1) {
          console.warn(`[ws] send error slot=${slot.index} event=${msg.event}`, err.message);
        }
      }
    }
  }
}

function sendTo(ws, msg) {
  if (ws && ws.readyState === 1) {
    try {
      ws.send(JSON.stringify(msg));
    } catch (err) {
      if (ws.readyState === 1) {
        console.warn(`[ws] sendTo error event=${msg.event}`, err.message);
      }
    }
  }
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

// Undo the last move (one die at a time, LIFO).
export function handleUndo(ws, roomId) {
  const room = rooms.get(roomId);
  if (!room || room.state !== 'playing') return;
  const { game } = room;
  if (game.phase !== 'AWAITING_MOVE') return;

  // Explicit guard: once commitTurn() has fired the turn cannot be undone.
  // (The phase check above catches this too, but _committed makes the intent explicit.)
  if (game._committed) return;

  const sess = sessions.get(ws._id);
  if (!sess || sess.playerIndex !== game.turnIndex) return;

  // Pop the last move's pre-state from undo stack
  if (!game._undoStack || game._undoStack.length === 0) return;

  const snapshot = game._undoStack.pop();

  // Restore marble positions and diceUsed
  game.players.forEach((p, pi) => {
    for (let mi = 0; mi < MARBLES_PER_PLAYER; mi++) {
      Object.assign(p.marbles[mi], snapshot.marbles[pi][mi]);
    }
  });
  game.diceUsed = snapshot.diceUsed;
  game._humanMadeMove = game._undoStack.length > 0; // no moves if stack empty

  // Re-broadcast full game state so all clients see the restored positions
  const legalMoves = allLegalMoves(game, game.turnIndex);
  broadcast(room, { event: 'undone', gameState: publicState(room) });
  sendTo(ws, { event: 'legalMoves', moves: legalMoves, diceUsed: game.diceUsed });
}

// Explicit turn commit — advance turn after human player has used their dice.
export function handleCommit(ws, roomId) {
  const room = rooms.get(roomId);
  if (!room || room.state !== 'playing') return;
  const { game } = room;
  if (game.phase !== 'AWAITING_MOVE') return;

  const sess = sessions.get(ws._id);
  if (!sess || sess.playerIndex !== game.turnIndex) return;

  // Both dice must be consumed before committing
  if (!game.diceUsed[0] || !game.diceUsed[1]) return;

  commitTurn(room);
}

// For unit testing only — resets all module-level state between test cases.
export function _reset() {
  rooms.clear();
  sessions.clear();
}
