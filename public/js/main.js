// main.js — UI controller, screen management, game event handling

import { connect, on, send, setReconnectInfo } from './socket.js';
import { init as initBoard, drawBoard, resize as resizeBoard,
         hitTestMarble, highlightSpaces, getColors } from './board.js';

// ---- State ----
let myPlayerIndex = null;
let myName = null;
let roomId = null;
let gameState = null;
let pendingMoves = [];        // moves selected but not yet submitted
let selectedMarble = null;    // { playerIndex, marbleId }
let legalMovesCache = null;   // legal moves for current interaction

const COLORS = ['#f0c040','#f07820','#e040c0','#e8e8e8','#40c040','#4080f0'];
const COLOR_NAMES = ['yellow','orange','pink','white','green','blue'];

// ---- Screen management ----
function show(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

// ---- DOM refs ----
const $ = id => document.getElementById(id);

// ---- Landing ----
$('btn-create').addEventListener('click', () => {
  if (!validateName()) return;
  show('screen-create');
});
$('btn-join').addEventListener('click', () => {
  if (!validateName()) return;
  show('screen-join');
});
function validateName() {
  const n = $('landing-name').value.trim();
  if (!n) { $('landing-name').focus(); return false; }
  myName = n;
  return true;
}

// ---- Create ----
$('btn-create-confirm').addEventListener('click', () => {
  const n = parseInt($('create-count').value, 10);
  if (n < 2 || n > 6) return;
  connect();
  on('open', () => {}); // connect is sync on first call; ws ready after
  send({ action: 'createRoom', name: myName, totalPlayers: n });
});
$('btn-create-back').addEventListener('click', () => show('screen-landing'));

// ---- Join ----
$('btn-join-confirm').addEventListener('click', () => {
  const code = $('join-code').value.trim().toUpperCase();
  if (code.length !== 4) return;
  connect();
  send({ action: 'joinRoom', code, name: myName });
});
$('btn-join-back').addEventListener('click', () => show('screen-landing'));

// ---- Lobby ----
$('btn-add-robot').addEventListener('click', () => send({ action: 'addRobot' }));
$('btn-start').addEventListener('click', () => send({ action: 'startGame' }));

// ---- Roll ----
$('btn-roll').addEventListener('click', () => send({ action: 'roll' }));

// ---- Canvas click (marble selection & move) ----
$('board-canvas').addEventListener('click', onCanvasClick);

// ---- Play again ----
$('btn-play-again').addEventListener('click', () => show('screen-landing'));

// ---- Socket events ----

on('error', ({ message }) => {
  alert(message);
});

on('roomCreated', ({ roomId: rid, code }) => {
  roomId = rid;
  myPlayerIndex = 0;
  setReconnectInfo({ roomId: rid, playerIndex: 0, name: myName });
  $('lobby-code').textContent = code;
  $('host-controls').style.display = 'flex';
  $('lobby-wait-msg').style.display = 'none';
  renderLobbySlots([{ index: 0, name: myName, color: COLOR_NAMES[0], isRobot: false, filled: true }]);
  show('screen-lobby');
});

on('joinedRoom', ({ roomId: rid, playerIndex, lobbyState }) => {
  roomId = rid;
  myPlayerIndex = playerIndex;
  setReconnectInfo({ roomId: rid, playerIndex, name: myName });
  $('lobby-code').textContent = lobbyState.code;
  $('host-controls').style.display = 'none';
  $('lobby-wait-msg').style.display = 'block';
  renderLobbySlots(lobbyState.slots);
  show('screen-lobby');
});

on('playerJoined', ({ playerIndex, name, color, isRobot }) => {
  const li = $(`slot-${playerIndex}`);
  if (li) {
    li.querySelector('.slot-name').textContent = name + (isRobot ? ' 🤖' : '');
  }
});

on('playerLeft', ({ playerIndex }) => {
  const li = $(`slot-${playerIndex}`);
  if (li) li.querySelector('.slot-name').textContent = '(empty)';
});

on('gameStarted', ({ gameState: gs }) => {
  gameState = gs;
  show('screen-game');
  const canvas = $('board-canvas');
  initBoard(canvas);
  renderSidebar();
  drawBoard(gameState);
  if (isMyTurn()) enableRoll();
});

on('rolled', ({ playerIndex, dice }) => {
  gameState.dice = dice;
  gameState.diceUsed = [false, false];
  gameState.phase = 'AWAITING_MOVE';
  renderDice(dice);
  log(`${playerName(playerIndex)} rolled ${dice[0]} & ${dice[1]}`);
  $('btn-roll').disabled = true;
  if (isMyTurn()) {
    // Show possible moves via marble clicking
  }
});

on('marbleMoved', ({ playerIndex, marbleId, from, to }) => {
  const marble = gameState.players[playerIndex].marbles[marbleId];
  Object.assign(marble, to);
  drawBoard(gameState);
  log(`${playerName(playerIndex)} moved marble`);
});

on('marbleBumped', ({ ownerIndex, marbleId, from }) => {
  const marble = gameState.players[ownerIndex].marbles[marbleId];
  marble.zone = 'base';
  marble.space = null;
  marble.slot = null;
  drawBoard(gameState);
  log(`${playerName(ownerIndex)}'s marble was bumped!`);
});

on('turnChanged', ({ playerIndex }) => {
  gameState.turnIndex = playerIndex;
  gameState.phase = 'IN_TURN';
  gameState.dice = null;
  gameState.diceUsed = [false, false];
  renderSidebar();
  renderDice(null);
  if (isMyTurn()) enableRoll();
  else $('btn-roll').disabled = true;
});

on('extraRoll', ({ playerIndex }) => {
  gameState.phase = 'EXTRA_ROLL';
  log(`${playerName(playerIndex)} gets an extra roll!`);
  if (isMyTurn()) enableRoll();
});

on('gameOver', ({ winnerIndex }) => {
  gameState.phase = 'GAME_OVER';
  const name = playerName(winnerIndex);
  $('winner-msg').textContent = `${name} wins!`;
  show('screen-gameover');
});

on('playerDisconnected', ({ playerIndex, timeoutMs }) => {
  log(`${playerName(playerIndex)} disconnected (${timeoutMs / 1000}s to reconnect)`);
});

on('robotTookOver', ({ playerIndex }) => {
  log(`Robot took over for ${playerName(playerIndex)}`);
});

on('reconnected', ({ gameState: gs }) => {
  gameState = gs;
  show('screen-game');
  const canvas = $('board-canvas');
  initBoard(canvas);
  renderSidebar();
  drawBoard(gameState);
});

// ---- Canvas interaction ----

function onCanvasClick(e) {
  if (!gameState || !isMyTurn() || gameState.phase !== 'AWAITING_MOVE') return;

  const rect = e.target.getBoundingClientRect();
  const cx = e.clientX - rect.left;
  const cy = e.clientY - rect.top;

  // Check if clicking a highlight (destination)
  if (legalMovesCache && selectedMarble) {
    const dest = hitTestDestination(cx, cy, legalMovesCache);
    if (dest) {
      submitMove(dest);
      return;
    }
  }

  // Check if clicking a marble
  const hit = hitTestMarble(gameState, cx, cy);
  if (!hit || hit.playerIndex !== myPlayerIndex) return;

  selectedMarble = hit;
  legalMovesCache = computeLegalDestinations(hit);
  drawBoard(gameState);
  highlightSpaces(legalMovesCache.map(m => moveToSpace(m)));
}

function computeLegalDestinations(marble) {
  // For both unused dice, find moves for this marble
  const moves = [];
  for (let dieIdx = 0; dieIdx < 2; dieIdx++) {
    if (gameState.diceUsed[dieIdx]) continue;
    // Request legal moves from server by sending an inquiry...
    // Actually we don't have a server-side legal move query endpoint.
    // We'll just let the server validate on submit.
    // For highlighting purposes, collect plausible destinations.
  }
  return moves; // highlighting is best-effort; server still validates
}

function moveToSpace(move) {
  if (move.toZone === 'track') return { zone: 'track', space: move.toSpace };
  if (move.toZone === 'home')  return { zone: 'home', playerIndex: myPlayerIndex, slot: move.toSlot };
  if (move.type === 'enterCenter' || move.type === 'exitCenter') return { zone: 'center' };
  return null;
}

function hitTestDestination(cx, cy, moves) {
  // Simple: not implemented yet — returns null (server will validate on submit)
  return null;
}

function submitMove(move) {
  send({ action: 'move', move });
  selectedMarble = null;
  legalMovesCache = null;
}

// ---- Render helpers ----

function renderLobbySlots(slots) {
  const ul = $('lobby-slots');
  ul.innerHTML = '';
  for (const slot of slots) {
    const li = document.createElement('li');
    li.id = `slot-${slot.index}`;
    const dot = document.createElement('span');
    dot.className = 'slot-dot';
    dot.style.background = COLORS[slot.index];
    const name = document.createElement('span');
    name.className = 'slot-name';
    name.textContent = slot.filled ? slot.name + (slot.isRobot ? ' 🤖' : '') : '(empty)';
    li.appendChild(dot);
    li.appendChild(name);
    ul.appendChild(li);
  }
}

function renderSidebar() {
  if (!gameState) return;
  const list = $('player-list');
  list.innerHTML = '';
  for (const p of gameState.players) {
    const row = document.createElement('div');
    row.className = 'player-row' + (p.index === gameState.turnIndex ? ' active-turn' : '');
    const dot = document.createElement('span');
    dot.className = 'player-dot';
    dot.style.background = COLORS[p.index];
    const label = document.createElement('span');
    label.textContent = p.name + (p.isRobot ? ' 🤖' : '');
    row.appendChild(dot);
    row.appendChild(label);
    list.appendChild(row);
  }
  const banner = $('turn-banner');
  banner.textContent = isMyTurn() ? 'Your turn' : `${playerName(gameState.turnIndex)}'s turn`;
  banner.style.color = isMyTurn() ? '#f0c040' : '#aaa';
}

function renderDice(dice) {
  for (let i = 0; i < 2; i++) {
    const el = $(`die-${i}`);
    el.textContent = dice ? dice[i] : '–';
    el.classList.toggle('used', !!(gameState?.diceUsed?.[i]));
  }
}

function enableRoll() {
  $('btn-roll').disabled = false;
  $('turn-banner').textContent = 'Your turn — Roll!';
  $('turn-banner').style.color = '#f0c040';
}

function isMyTurn() {
  return gameState && gameState.turnIndex === myPlayerIndex;
}

function playerName(index) {
  return gameState?.players?.[index]?.name ?? `Player ${index + 1}`;
}

function log(msg) {
  const el = $('game-log');
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.textContent = msg;
  el.appendChild(entry);
  el.scrollTop = el.scrollHeight;
}

// ---- Canvas resize ----
window.addEventListener('resize', () => {
  resizeBoard();
  if (gameState) drawBoard(gameState);
});

// ---- Initial connect on load ----
// Connection is deferred until user takes action (create/join)
