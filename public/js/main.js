// main.js — UI controller, screen management, game event handling

import { connect, on, send, setReconnectInfo } from './socket.js';
import { init as initBoard, drawBoard, resize as resizeBoard,
         hitTestMarble, highlightSpaces, highlightMarbleAt, getSpacePosition } from './board.js';

// ---- State ----
let myPlayerIndex = null;
let myName = null;
let roomId = null;
let gameState = null;
let selectedMarble = null;      // { playerIndex, marbleId } currently selected
let legalMovesCache = null;     // { 0: [...], 1: [...] } from server after roll
let selectedMarbleMoves = [];   // filtered moves for selectedMarble (for highlighting)

// Maps color name (from gameState / lobbyState) to hex — ARM_MAP means player 1 in
// a 2-player game uses 'white' not 'orange', so we can't index COLORS by player index.
const COLOR_MAP = {
  yellow: '#f5d000', orange: '#ff7800', pink: '#e8208c',
  white:  '#e0e0e0', green:  '#44bb44', blue: '#2288f0',
};

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
// Enter on name field → Create Game (most common action)
$('landing-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-create').click(); });

// ---- Create ----
$('btn-create-confirm').addEventListener('click', () => {
  const n = parseInt($('create-count').value, 10);
  if (n < 2 || n > 6) return;
  connect();
  send({ action: 'createRoom', name: myName, totalPlayers: n });
});
$('btn-create-back').addEventListener('click', () => show('screen-landing'));
// Enter on player-count field → confirm create
$('create-count').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-create-confirm').click(); });

// ---- Join ----
$('btn-join-confirm').addEventListener('click', () => {
  const code = $('join-code').value.trim().toUpperCase();
  if (code.length !== 4) return;
  connect();
  send({ action: 'joinRoom', code, name: myName });
});
$('btn-join-back').addEventListener('click', () => show('screen-landing'));
// Enter on room-code field → confirm join
$('join-code').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-join-confirm').click(); });

// ---- Lobby ----
$('btn-add-robot').addEventListener('click', () => send({ action: 'addRobot' }));
$('btn-start').addEventListener('click', () => send({ action: 'startGame' }));

// ---- Roll ----
$('btn-roll').addEventListener('click', () => {
  send({ action: 'roll' });
  // Animate dice briefly
  $('die-0').classList.add('rolling');
  $('die-1').classList.add('rolling');
  setTimeout(() => { $('die-0').classList.remove('rolling'); $('die-1').classList.remove('rolling'); }, 500);
});

// ---- Canvas click (marble selection & move) ----
$('board-canvas').addEventListener('click', onCanvasClick);

// ---- Play again ----
$('btn-play-again').addEventListener('click', () => show('screen-landing'));

// ---- Socket events ----

on('error', ({ message }) => {
  alert(message);
});

on('roomCreated', ({ roomId: rid, code, reconnectToken, color }) => {
  roomId = rid;
  myPlayerIndex = 0;
  setReconnectInfo({ roomId: rid, playerIndex: 0, reconnectToken });
  $('lobby-code').textContent = code;
  $('host-controls').style.display = 'flex';
  $('lobby-wait-msg').style.display = 'none';
  renderLobbySlots([{ index: 0, name: myName, color: color ?? 'yellow', isRobot: false, filled: true }]);
  show('screen-lobby');
});

on('joinedRoom', ({ roomId: rid, playerIndex, lobbyState, reconnectToken }) => {
  roomId = rid;
  myPlayerIndex = playerIndex;
  setReconnectInfo({ roomId: rid, playerIndex, reconnectToken });
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
  initBoard($('board-canvas'));
  renderSidebar();
  drawBoard(gameState);
  log('Game started! Good luck.');
  if (isMyTurn()) { enableRoll(); log('⭐ You go first — roll the dice!'); }
  else log(`${playerName(gs.turnIndex)} goes first.`);
});

on('rolled', ({ playerIndex, dice, legalMoves }) => {
  gameState.dice = dice;
  gameState.diceUsed = [false, false];
  gameState.phase = 'AWAITING_MOVE';
  legalMovesCache = legalMoves ?? null;
  selectedMarble = null;
  selectedMarbleMoves = [];
  renderDice(dice);
  $('btn-roll').disabled = true;

  const isMe = playerIndex === myPlayerIndex;
  const d0 = dice[0], d1 = dice[1];
  const hasSix = d0 === 6 || d1 === 6;

  if (isMe) {
    log(`🎲 You rolled ${d0} and ${d1}!${hasSix ? ' (extra roll earned)' : ''}`);
    const totalMoves = Object.values(legalMoves ?? {}).reduce((s, a) => s + a.length, 0);
    if (totalMoves === 0) {
      log('No legal moves — turn skipped.');
      setHint('');
    } else {
      setHint('Click one of your marbles to see where it can move.');
    }
  } else {
    log(`${playerName(playerIndex)} rolled ${d0} and ${d1}.${hasSix ? ' (extra roll)' : ''}`);
    setHint('');
  }
});

// Server sends updated legal moves after the player uses one die (so remaining
// die destinations can be highlighted correctly).
on('legalMoves', ({ moves }) => {
  legalMovesCache = moves;
  selectedMarble = null;
  selectedMarbleMoves = [];
  drawBoard(gameState);
  if (isMyTurn()) setHint('Click a marble to choose your next move.');
});

on('marbleMoved', ({ playerIndex, marbleId, from, to }) => {
  const marble = gameState.players[playerIndex].marbles[marbleId];
  Object.assign(marble, to);
  selectedMarble = null;
  selectedMarbleMoves = [];
  drawBoard(gameState);

  const who = playerIndex === myPlayerIndex ? 'Your' : `${playerName(playerIndex)}'s`;
  const dest = to.zone === 'track' ? `space ${to.space}` :
               to.zone === 'home'  ? `home slot ${to.slot}` :
               to.zone === 'center'? 'the hub' : to.zone;
  log(`${who} marble moved to ${dest}.`);
});

on('marbleBumped', ({ ownerIndex, marbleId, from }) => {
  const marble = gameState.players[ownerIndex].marbles[marbleId];
  marble.zone = 'base';
  marble.space = null;
  marble.slot = null;
  drawBoard(gameState);
  const victim = ownerIndex === myPlayerIndex ? 'YOUR marble' : `${playerName(ownerIndex)}'s marble`;
  log(`💥 ${victim} was bumped back to base!`);
});

on('turnChanged', ({ playerIndex }) => {
  gameState.turnIndex = playerIndex;
  gameState.phase = 'IN_TURN';
  gameState.dice = null;
  gameState.diceUsed = [false, false];
  legalMovesCache = null;
  selectedMarble = null;
  selectedMarbleMoves = [];
  setHint('');
  renderSidebar();
  renderDice(null);
  if (isMyTurn()) {
    enableRoll();
    log(`⭐ It's your turn!`);
  } else {
    $('btn-roll').disabled = true;
    log(`${playerName(playerIndex)}'s turn.`);
  }
});

on('extraRoll', ({ playerIndex }) => {
  gameState.phase = 'EXTRA_ROLL';
  if (playerIndex === myPlayerIndex) {
    log('🎲 You earned an extra roll!');
    enableRoll();
  } else {
    log(`${playerName(playerIndex)} earned an extra roll.`);
  }
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
  initBoard($('board-canvas'));
  renderSidebar();
  drawBoard(gameState);
  log('Reconnected.');
});

// ---- Canvas interaction ----

function onCanvasClick(e) {
  if (!gameState || !isMyTurn() || gameState.phase !== 'AWAITING_MOVE') return;

  const canvas = $('board-canvas');
  const rect   = canvas.getBoundingClientRect();
  // Scale from CSS display coords → canvas pixel coords (important when CSS sizes differ)
  const scaleX = canvas.width  / rect.width;
  const scaleY = canvas.height / rect.height;
  const cx = (e.clientX - rect.left) * scaleX;
  const cy = (e.clientY - rect.top)  * scaleY;

  // Clicking a highlighted destination submits that move.
  if (selectedMarbleMoves.length) {
    const dest = hitTestDestination(cx, cy, selectedMarbleMoves);
    if (dest) {
      submitMove(dest);
      return;
    }
  }

  // Clicking a marble selects it and highlights its legal destinations.
  const hit = hitTestMarble(gameState, cx, cy);
  if (!hit || hit.playerIndex !== myPlayerIndex) {
    selectedMarble = null;
    selectedMarbleMoves = [];
    drawBoard(gameState);
    setHint('Click one of your marbles to see where it can move.');
    return;
  }

  selectedMarble = hit;
  selectedMarbleMoves = computeLegalDestinations(hit);
  drawBoard(gameState);

  const player = gameState.players[hit.playerIndex];
  const marble = player.marbles[hit.marbleId];
  highlightMarbleAt(marble, hit.playerIndex);
  highlightSpaces(selectedMarbleMoves.map(moveToSpace).filter(Boolean));

  if (selectedMarbleMoves.length === 0) {
    setHint('That marble has no legal moves. Try another.');
  } else {
    setHint(`${selectedMarbleMoves.length} move${selectedMarbleMoves.length > 1 ? 's' : ''} available — click a highlighted space.`);
  }
}

// Returns all legal moves for the given marble across all unused dice.
function computeLegalDestinations({ marbleId }) {
  if (!legalMovesCache) return [];
  const moves = [];
  for (let i = 0; i < 2; i++) {
    if (gameState?.diceUsed?.[i]) continue;
    for (const m of (legalMovesCache[i] ?? [])) {
      if (m.marbleId === marbleId) moves.push(m);
    }
  }
  return moves;
}

// Converts a move to a space descriptor for board highlighting / hit-testing.
// All move types now carry toZone (set by GameEngine), so this is a direct mapping.
function moveToSpace(move) {
  if (!move.toZone) return null;
  if (move.toZone === 'center') return { zone: 'center' };
  if (move.toZone === 'track')  return { zone: 'track', space: move.toSpace };
  if (move.toZone === 'home')   return { zone: 'home', playerIndex: myPlayerIndex, slot: move.toSlot };
  return null;
}

// Returns the move that the player clicked, or null.
function hitTestDestination(cx, cy, moves) {
  const R = $('board-canvas').width * 0.028;
  for (const move of moves) {
    const pos = getSpacePosition(moveToSpace(move));
    if (!pos) continue;
    const dx = cx - pos.x, dy = cy - pos.y;
    if (dx * dx + dy * dy <= R * R) return move;
  }
  return null;
}

function submitMove(move) {
  send({ action: 'move', move });
  selectedMarble = null;
  selectedMarbleMoves = [];
  legalMovesCache = null; // will be refreshed by server via 'legalMoves' event if turn continues
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
    dot.style.background = COLOR_MAP[slot.color] ?? '#888';
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
    dot.style.background = COLOR_MAP[p.color] ?? '#888';
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
  $('turn-banner').textContent = 'Your turn — Roll the dice!';
  $('turn-banner').style.color = '#f0c040';
}

function setHint(msg) {
  const el = $('move-hint');
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

function isMyTurn() {
  return gameState && gameState.turnIndex === myPlayerIndex;
}

function playerName(index) {
  return gameState?.players?.[index]?.name ?? `Player ${index + 1}`;
}

const LOG_MAX = 60;
function log(msg) {
  const el = $('game-log');
  const entry = document.createElement('div');
  entry.className = 'log-entry';
  entry.textContent = msg;
  el.appendChild(entry);
  // Prevent unbounded growth on long games
  while (el.children.length > LOG_MAX) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}

// ---- Canvas resize ----
window.addEventListener('resize', () => {
  resizeBoard();
  if (gameState) drawBoard(gameState);
});

// ---- Initial connect on load ----
// Connection is deferred until user takes action (create/join)
