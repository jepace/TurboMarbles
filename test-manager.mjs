// Unit tests for src/GameManager.js — room lifecycle, move validation, disconnect handling.
// Run with: node test-manager.mjs

import {
  createRoom, joinRoom, addRobot, startGame,
  handleRoll, handleMove, handleForfeitDie,
  handleDisconnect, handleReconnect, getRoomByWs,
  _reset,
} from './src/GameManager.js';

// ---- Harness ----------------------------------------------------------------

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else       { console.error(`  ✗ ${label}`); failed++; }
}
function describe(label, fn) { console.log(`\n${label}`); fn(); }

// ---- Mock WebSocket ---------------------------------------------------------

let _wsId = 1;
function mockWs() {
  const ws = {
    _id: String(_wsId++),
    readyState: 1,
    sent: [],
    send(data) { this.sent.push(JSON.parse(data)); },
    last() { return this.sent[this.sent.length - 1]; },
    find(event) { return this.sent.filter(m => m.event === event); },
  };
  return ws;
}

function setup() { _reset(); }

// ---- createRoom -------------------------------------------------------------

describe('createRoom', () => {
  setup();
  const host = mockWs();
  const result = createRoom(host, 'Alice', 3);

  assert(typeof result.roomId === 'string' && result.roomId.length > 0, 'returns roomId');
  assert(typeof result.code === 'string' && result.code.length === 4, 'returns 4-char code');
  assert(typeof result.reconnectToken === 'string', 'returns reconnectToken');
  assert(getRoomByWs(host) === result.roomId, 'host session registered');
});

// ---- joinRoom ---------------------------------------------------------------

describe('joinRoom — success', () => {
  setup();
  const host = mockWs();
  const { code } = createRoom(host, 'Alice', 2);
  const guest = mockWs();
  const result = joinRoom(guest, code, 'Bob');

  assert(!result.error, 'no error');
  assert(result.playerIndex === 1, 'assigned slot 1');
  assert(typeof result.reconnectToken === 'string', 'gets reconnectToken');
  assert(result.lobbyState.slots[1].name === 'Bob', 'Bob appears in lobbyState');
  assert(getRoomByWs(guest) === result.roomId, 'guest session registered');
});

describe('joinRoom — broadcasts playerJoined to host, not to joiner', () => {
  setup();
  const host = mockWs();
  const { code } = createRoom(host, 'Alice', 3);
  const guest = mockWs();
  joinRoom(guest, code, 'Bob');

  assert(host.find('playerJoined').length === 1, 'host receives playerJoined');
  assert(guest.find('playerJoined').length === 0, 'joiner does not receive playerJoined');
});

describe('joinRoom — invalid code', () => {
  setup();
  const guest = mockWs();
  const result = joinRoom(guest, 'ZZZZ', 'Bob');
  assert(result.error === 'Room not found or already started', 'correct error for bad code');
});

describe('joinRoom — full room', () => {
  setup();
  const host = mockWs();
  const { code } = createRoom(host, 'Alice', 2);
  joinRoom(mockWs(), code, 'Bob');
  const result = joinRoom(mockWs(), code, 'Charlie');
  assert(result.error === 'Room is full', 'full room error');
});

// ---- addRobot ---------------------------------------------------------------

describe('addRobot — only host can add', () => {
  setup();
  const host = mockWs();
  const { code, roomId } = createRoom(host, 'Alice', 3);
  const guest = mockWs();
  joinRoom(guest, code, 'Bob');
  const result = addRobot(guest, roomId);
  assert(result.error === 'Only host can add robots', 'non-host rejected');
});

describe('addRobot — host adds robot to empty slot', () => {
  setup();
  const host = mockWs();
  const { code, roomId } = createRoom(host, 'Alice', 3);
  joinRoom(mockWs(), code, 'Bob');
  const result = addRobot(host, roomId);
  assert(!result.error, 'no error');
  assert(host.find('playerJoined').some(m => m.isRobot), 'playerJoined broadcast with isRobot=true');
});

// ---- startGame --------------------------------------------------------------

describe('startGame — unfilled slots blocked', () => {
  setup();
  const host = mockWs();
  const { roomId } = createRoom(host, 'Alice', 3);
  const result = startGame(host, roomId);
  assert(result.error === 'Unfilled slots remain', 'cannot start with empty slots');
});

describe('startGame — success with robots', () => {
  setup();
  const host = mockWs();
  const { roomId } = createRoom(host, 'Alice', 2);
  addRobot(host, roomId);
  const result = startGame(host, roomId);
  assert(!result.error, 'no error');
  assert(host.find('gameStarted').length === 1, 'gameStarted event sent');
  const gs = host.find('gameStarted')[0].gameState;
  assert(gs.players.length === 2, 'correct player count');
});

// ---- handleRoll / handleMove guards -----------------------------------------

describe('handleRoll — only current player can roll', () => {
  setup();
  const host = mockWs();
  const { roomId } = createRoom(host, 'Alice', 2);
  addRobot(host, roomId);
  startGame(host, roomId);

  // Clear sent to track only new messages
  host.sent = [];

  // Attempt roll as a fake ws that has no session
  const stranger = mockWs();
  handleRoll(stranger, roomId);
  assert(host.find('rolled').length === 0, 'stranger cannot trigger roll');
});

describe('handleMove — rejects invalid dieIndex', () => {
  setup();
  const host = mockWs();
  const { roomId } = createRoom(host, 'Alice', 2);
  addRobot(host, roomId);
  startGame(host, roomId);

  // Must roll first so phase becomes AWAITING_MOVE; host is player 0 (goes first)
  handleRoll(host, roomId);
  host.sent = [];

  handleMove(host, roomId, { type: 'move', marbleId: 0, dieIndex: 99 });
  const errors = host.find('error');
  assert(errors.some(e => e.code === 'ILLEGAL_MOVE'), 'invalid dieIndex rejected with ILLEGAL_MOVE');
});

describe('handleMove — rejects illegal move type', () => {
  setup();
  const host = mockWs();
  const { roomId } = createRoom(host, 'Alice', 2);
  addRobot(host, roomId);
  startGame(host, roomId);

  // Roll manually: set game into IN_TURN, trigger roll
  host.sent = [];
  handleRoll(host, roomId);

  // Now try a bogus move
  handleMove(host, roomId, { type: 'teleport', marbleId: 0, dieIndex: 0 });
  assert(host.find('error').some(e => e.code === 'ILLEGAL_MOVE'), 'bogus move type rejected');
});

// ---- handleForfeitDie -------------------------------------------------------

describe('handleForfeitDie — rejects out-of-range dieIndex', () => {
  setup();
  const host = mockWs();
  const { roomId } = createRoom(host, 'Alice', 2);
  addRobot(host, roomId);
  startGame(host, roomId);
  handleRoll(host, roomId);
  host.sent = [];

  handleForfeitDie(host, roomId, 5);
  // Should silently no-op (no error event, no crash)
  assert(true, 'invalid dieIndex does not crash');
  // Turn should not have advanced (no turnChanged or extraRoll)
  assert(host.find('turnChanged').length === 0, 'turn did not advance');
});

// ---- handleReconnect --------------------------------------------------------

describe('handleReconnect — valid token restores session', () => {
  setup();
  const host = mockWs();
  const { code, roomId, reconnectToken } = createRoom(host, 'Alice', 2);
  addRobot(host, roomId);
  startGame(host, roomId);

  // Simulate disconnect + reconnect
  handleDisconnect(host);
  const newWs = mockWs();
  const result = handleReconnect(newWs, roomId, 0, reconnectToken);
  assert(!result.error, 'valid token accepted');
  assert(newWs.find('reconnected').length === 1, 'reconnected event sent');
  assert(getRoomByWs(newWs) === roomId, 'new session registered');
});

describe('handleReconnect — wrong token rejected', () => {
  setup();
  const host = mockWs();
  const { roomId, reconnectToken } = createRoom(host, 'Alice', 2);
  addRobot(host, roomId);
  startGame(host, roomId);
  handleDisconnect(host);

  const newWs = mockWs();
  const result = handleReconnect(newWs, roomId, 0, 'wrong-token');
  assert(result.error === 'Invalid token', 'bad token rejected');
  assert(newWs.find('reconnected').length === 0, 'reconnected not sent');
});

describe('handleReconnect — null token rejected', () => {
  setup();
  const host = mockWs();
  const { roomId } = createRoom(host, 'Alice', 2);
  addRobot(host, roomId);
  startGame(host, roomId);
  handleDisconnect(host);

  const newWs = mockWs();
  const result = handleReconnect(newWs, roomId, 0, null);
  assert(result.error === 'Invalid token', 'null token rejected');
});

describe('handleReconnect — cancels disconnect timer', () => {
  setup();
  const host = mockWs();
  const { roomId, reconnectToken } = createRoom(host, 'Alice', 2);
  addRobot(host, roomId);
  startGame(host, roomId);

  // Capture timer created during disconnect
  let timerCancelled = false;
  const origClear = global.clearTimeout;
  global.clearTimeout = (id) => { if (id) timerCancelled = true; origClear(id); };

  handleDisconnect(host);
  handleReconnect(mockWs(), roomId, 0, reconnectToken);

  global.clearTimeout = origClear;
  assert(timerCancelled, 'disconnect timer cleared on reconnect');
});

// ---- handleDisconnect — lobby cleanup ---------------------------------------

describe('handleDisconnect — lobby: slot freed, broadcast sent', () => {
  setup();
  const host = mockWs();
  const { code } = createRoom(host, 'Alice', 3);
  const guest = mockWs();
  joinRoom(guest, code, 'Bob');
  host.sent = [];
  handleDisconnect(guest);
  assert(host.find('playerLeft').length === 1, 'playerLeft broadcast to host');
  assert(host.find('playerLeft')[0].playerIndex === 1, 'correct playerIndex');
});

describe('handleDisconnect — unknown ws is no-op', () => {
  setup();
  const stranger = mockWs();
  let threw = false;
  try { handleDisconnect(stranger); } catch { threw = true; }
  assert(!threw, 'unknown ws does not crash');
});

// ---- Summary ----------------------------------------------------------------

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
