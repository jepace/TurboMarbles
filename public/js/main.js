// main.js — UI controller, screen management, game event handling

import { connect, on, send, setReconnectInfo } from './socket.js';
import { init as initBoard, drawBoard, resize as resizeBoard,
         hitTestMarble, highlightSpaces, highlightMarbleAt, getSpacePosition,
         setMarbleOverride, clearMarbleOverride,
         setAnimatingMarble, clearAnimatingMarble } from './board.js';
import { ARM_MAP, ARM_COLORS } from './constants.js';

// ---- State ----
let myPlayerIndex = null;
let myName = null;
let roomId = null;
let gameState = null;
let selectedMarble = null;      // { playerIndex, marbleId } currently selected
let legalMovesCache = null;     // { 0: [...], 1: [...] } from server after roll
let selectedMarbleMoves = [];   // filtered moves for selectedMarble (for highlighting)
let commitPending = false;      // true when readyToCommit received, waiting for Commit click

// ---- Per-turn move log accumulation (for backgammon notation) ----
let turnNumber    = 0;    // increments each turnChanged; set to 1 on gameStarted
let turnLogMoves  = [];   // [{ marbleId, path: [str,...], bumped }] for current turn
let turnLogDice   = null; // [die0, die1] rolled this turn
let turnLogPlayer = null; // playerIndex for current turn
let lastBumpedAt  = null; // zone-descriptor set by marbleBumped, consumed by marbleMoved

// Maps color name (from gameState / lobbyState) to hex — ARM_MAP means player 1 in
// a 2-player game uses 'white' not 'orange', so we can't index COLORS by player index.
const COLOR_MAP = {
  yellow: '#f5d000', orange: '#ff7800', pink: '#e8208c',
  white:  '#e0e0e0', green:  '#44bb44', blue: '#2288f0',
};

// ARM_MAP and ARM_COLORS imported from ./constants.js

let selectedHostColor = 'blue';

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
function updateColorPicker(n) {
  const el = $('create-colors');
  if (!el) return;
  const arms = ARM_MAP[n] ?? [0];
  el.innerHTML = '';
  for (const arm of arms) {
    const color = ARM_COLORS[arm];
    const swatch = document.createElement('button');
    swatch.className = 'color-swatch' + (color === selectedHostColor ? ' selected' : '');
    swatch.style.background = COLOR_MAP[color];
    swatch.title = color;
    swatch.dataset.color = color;
    swatch.addEventListener('click', e => {
      e.preventDefault();
      selectedHostColor = color;
      updateColorPicker(n);
    });
    el.appendChild(swatch);
  }
  // If current selectedHostColor not in available arms, reset to first
  const available = arms.map(a => ARM_COLORS[a]);
  if (!available.includes(selectedHostColor)) {
    selectedHostColor = available[0];
    updateColorPicker(n);
  }
}

$('btn-create-confirm').addEventListener('click', () => {
  const n = parseInt($('create-count').value, 10);
  if (n < 2 || n > 6) return;
  connect();
  send({ action: 'createRoom', name: myName, totalPlayers: n, hostColor: selectedHostColor });
});
$('btn-create-back').addEventListener('click', () => show('screen-landing'));
// Enter on player-count field → confirm create
$('create-count').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-create-confirm').click(); });
$('create-count').addEventListener('input', () => {
  const n = parseInt($('create-count').value, 10);
  if (n >= 2 && n <= 6) updateColorPicker(n);
});
updateColorPicker(4); // initialize with default

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
$('btn-copy-code').addEventListener('click', () => {
  const code = $('lobby-code').textContent;
  navigator.clipboard.writeText(code).then(() => {
    const btn = $('btn-copy-code');
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = '⧉'; }, 1500);
  });
});

// ---- Roll ----
$('btn-roll').addEventListener('click', doRoll);

function doRoll() {
  if ($('btn-roll').disabled) return;
  send({ action: 'roll' });
  $('die-0').classList.add('rolling');
  $('die-1').classList.add('rolling');
  setTimeout(() => { $('die-0').classList.remove('rolling'); $('die-1').classList.remove('rolling'); }, 500);
}

// ---- Commit / Undo ----
$('btn-commit').addEventListener('click', doCommit);
$('btn-undo').addEventListener('click', doUndo);

function doCommit() {
  send({ action: 'commit' });
  commitPending = false;
  $('btn-commit').style.display = 'none';
  $('btn-undo').style.display   = 'none';
}

function doUndo() {
  send({ action: 'undo' });
  commitPending = false;
  $('btn-commit').style.display = 'none';
  $('btn-undo').style.display   = 'none';
  legalMovesCache = null;
  selectedMarble = null;
  selectedMarbleMoves = [];
}

// Undo available after any move; Commit only when both dice are used.
function setUndoVisible(visible)   { $('btn-undo').style.display   = visible ? 'inline-flex' : 'none'; }
function setCommitVisible(visible) { $('btn-commit').style.display  = visible ? 'inline-flex' : 'none'; }

// ---- [Enter] key — create/start/roll/commit shortcuts ----
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  // Don't fire if user is typing in an input/textarea
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  // Create screen: Enter confirms
  if ($('screen-create').classList.contains('active')) {
    $('btn-create-confirm').click(); return;
  }
  // Lobby: host can Enter to start
  if ($('screen-lobby').classList.contains('active')) {
    if ($('host-controls').style.display !== 'none') $('btn-start').click();
    return;
  }
  // Game: roll or commit
  if (!gameState) return;
  if (commitPending && isMyTurn()) {
    doCommit();
  } else if (!$('btn-roll').disabled && isMyTurn()) {
    doRoll();
  }
});

// ---- Play again ----
$('btn-play-again').addEventListener('click', () => {
  $('win-overlay').style.display = 'none';
  show('screen-landing');
});

// ---- Canvas click (marble selection & move) ----
$('board-canvas').addEventListener('click', onCanvasClick);

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
  const iAmHost = ($('host-controls').style.display !== 'none');
  const li = $(`slot-${playerIndex}`);
  if (!li) return;
  li.querySelector('.slot-name').textContent = name + (isRobot ? ' 🤖' : '');
  if (isRobot && iAmHost && !li.querySelector('.btn-remove-robot')) {
    const del = document.createElement('button');
    del.className = 'btn-remove-robot';
    del.textContent = '×';
    del.title = 'Remove robot';
    del.addEventListener('click', () => send({ action: 'removeRobot', playerIndex }));
    li.appendChild(del);
  }
});

on('playerLeft', ({ playerIndex }) => {
  const li = $(`slot-${playerIndex}`);
  if (!li) return;
  li.querySelector('.slot-name').textContent = '(empty)';
  const del = li.querySelector('.btn-remove-robot');
  if (del) del.remove();
});

on('gameStarted', ({ gameState: gs }) => {
  gameState = gs;
  show('screen-game');
  initBoard($('board-canvas'));
  setCommitVisible(false); setUndoVisible(false);
  commitPending = false;
  turnNumber = 1;
  renderSidebar();
  drawBoard(gameState);
  if (isMyTurn()) enableRoll();
});

on('rolled', ({ playerIndex, dice, moves }) => {
  gameState.dice = dice;
  gameState.diceUsed = [false, false];
  gameState.phase = 'AWAITING_MOVE';
  legalMovesCache = moves ?? null;
  selectedMarble = null;
  selectedMarbleMoves = [];
  commitPending = false;
  setCommitVisible(false); setUndoVisible(false);
  renderDice(dice);
  $('btn-roll').disabled = true;

  // Capture dice for backgammon notation (extra roll starts a fresh move list)
  if (turnLogPlayer !== playerIndex) {
    turnLogMoves  = [];
    turnLogPlayer = playerIndex;
  }
  turnLogDice = dice;

  const isMe = playerIndex === myPlayerIndex;
  if (isMe) {
    const totalMoves = Object.values(legalMovesCache ?? {}).reduce((s, a) => s + a.length, 0);
    setHint(totalMoves === 0 ? '' : 'Click one of your marbles to see where it can move.');
  } else {
    setHint('');
  }
});

// Server sends updated legal moves after the player uses one die (so remaining
// die destinations can be highlighted correctly).
on('legalMoves', ({ moves, diceUsed }) => {
  legalMovesCache = moves;
  if (diceUsed && gameState) {
    gameState.diceUsed = diceUsed;
    renderDice(gameState.dice);
    // Show Undo as soon as any die has been used
    if (isMyTurn() && (diceUsed[0] || diceUsed[1])) {
      setUndoVisible(true);
    }
  }
  selectedMarble = null;
  selectedMarbleMoves = [];
  drawBoard(gameState);
  if (isMyTurn()) setHint('Click a marble to choose your next move.');
});

on('marbleMoved', ({ playerIndex, marbleId, from, to, path }) => {
  const marble = gameState.players[playerIndex].marbles[marbleId];

  // Capture from-position before updating state (for animation start point)
  const fromPos = getSpacePosition(zoneToSpace(from, playerIndex));

  // Update game state immediately so the board renders correctly after animation
  Object.assign(marble, to);
  selectedMarble = null;
  selectedMarbleMoves = [];

  // Accumulate move for backgammon notation; merge consecutive same-marble moves
  const bumped  = lastBumpedAt !== null;
  lastBumpedAt  = null;
  const fromStr = locNotation(from);
  const toStr   = locNotation(to);
  const last    = turnLogMoves[turnLogMoves.length - 1];
  if (last && last.marbleId === marbleId && last.path[last.path.length - 1] === fromStr) {
    last.path.push(toStr);
    last.bumped = last.bumped || bumped;
  } else {
    turnLogMoves.push({ marbleId, path: [fromStr, toStr], bumped });
  }

  // Build canvas waypoints from server path
  const waypoints = (path ?? []).map(loc => getSpacePosition(zoneToSpace(loc, playerIndex))).filter(Boolean);

  // Always ensure at least the final position is animated to
  const toPos = getSpacePosition(zoneToSpace(to, playerIndex));
  if (waypoints.length === 0 && toPos) waypoints.push(toPos);

  if (fromPos && waypoints.length > 0) {
    animateMarblePath(playerIndex, marbleId, fromPos, waypoints);
  } else {
    drawBoard(gameState);
  }
});

on('marbleBumped', ({ ownerIndex, marbleId, from }) => {
  const marble = gameState.players[ownerIndex].marbles[marbleId];
  // Record where the bump happened so marbleMoved can annotate the move with '*'
  lastBumpedAt = from;
  marble.zone = 'base';
  marble.space = null;
  marble.slot = null;
  marble.starEligible = false;
  drawBoard(gameState);
});

on('turnChanged', ({ playerIndex }) => {
  flushTurnLog();
  turnNumber++;
  gameState.turnIndex = playerIndex;
  gameState.phase = 'IN_TURN';
  gameState.dice = null;
  gameState.diceUsed = [false, false];
  legalMovesCache = null;
  selectedMarble = null;
  selectedMarbleMoves = [];
  commitPending = false;
  turnLogPlayer = null;
  setCommitVisible(false); setUndoVisible(false);
  setHint('');
  renderSidebar();
  renderDice(null);
  if (isMyTurn()) {
    enableRoll();
  } else {
    $('btn-roll').disabled = true;
  }
});

on('extraRoll', ({ playerIndex }) => {
  flushTurnLog();
  gameState.phase = 'EXTRA_ROLL';
  commitPending = false;
  // Start fresh move accumulation for the extra roll
  turnLogMoves = [];
  setCommitVisible(false); setUndoVisible(false);
  if (playerIndex === myPlayerIndex) {
    enableRoll();
  }
});

on('dieForfeit', ({ dieIndex }) => {
  if (gameState?.diceUsed) gameState.diceUsed[dieIndex] = true;
  renderDice(gameState?.dice);
});

on('turnSkipped', ({ playerIndex }) => {
  flushTurnLog();
  turnLogPlayer = null;
});

on('readyToCommit', ({ playerIndex }) => {
  if (playerIndex !== myPlayerIndex) return;
  commitPending = true;
  setCommitVisible(true);
  setUndoVisible(true);
  setHint('Both dice used. Commit your turn or Undo to try again.');
});

on('undone', ({ gameState: gs }) => {
  gameState = gs;
  selectedMarble = null;
  selectedMarbleMoves = [];
  commitPending = false;
  setCommitVisible(false); setUndoVisible(false);
  renderDice(gameState.dice);
  drawBoard(gameState);
  if (isMyTurn()) setHint('Undone. Click a marble to make your moves.');
});

on('gameOver', ({ winnerIndex }) => {
  flushTurnLog();
  turnLogPlayer = null;
  gameState.phase = 'GAME_OVER';
  const name = playerName(winnerIndex);
  $('winner-msg').textContent = `${name} wins! 🎉`;
  $('win-overlay').style.display = 'flex';
  // Board stays visible — no screen switch
  log(`🏆 ${name} wins the game!`);
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
  setCommitVisible(false); setUndoVisible(false);
  commitPending = false;
  renderSidebar();
  drawBoard(gameState);
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

  // Clicking a marble selects it — or deselects if clicking the already-selected marble.
  const hit = hitTestMarble(gameState, cx, cy);
  if (!hit || hit.playerIndex !== myPlayerIndex) {
    selectedMarble = null;
    selectedMarbleMoves = [];
    drawBoard(gameState);
    if (isMyTurn() && gameState.phase === 'AWAITING_MOVE') {
      setHint('Click one of your marbles to see where it can move.');
    }
    return;
  }

  // Deselect if clicking the same marble again
  if (selectedMarble && selectedMarble.marbleId === hit.marbleId) {
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

// Converts a zone/space descriptor from a marbleMoved event to a space descriptor for board
function zoneToSpace(loc, playerIndex) {
  if (!loc) return null;
  if (loc.zone === 'center') return { zone: 'center' };
  if (loc.zone === 'track')  return { zone: 'track', space: loc.space };
  if (loc.zone === 'home')   return { zone: 'home', playerIndex, slot: loc.slot };
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

// ---- Marble animation ----

// Animate a marble through a sequence of canvas-coordinate waypoints.
// Each step uses smoothstep easing; total duration scales with step count
// so short moves feel snappy and long moves stay readable.
function animateMarblePath(playerIndex, marbleId, fromPos, waypoints) {
  if (!waypoints || waypoints.length === 0) {
    drawBoard(gameState);
    return;
  }

  const STEP_MS = 120;  // ms per intermediate space
  const MIN_MS  = 200;  // minimum step duration (for single-step moves)
  const stepDuration = Math.max(MIN_MS, STEP_MS * (waypoints.length <= 1 ? 1 : 1));

  let step = 0;
  let prevPos = fromPos;

  setAnimatingMarble(playerIndex, marbleId);

  function animateToNext() {
    if (step >= waypoints.length) {
      clearMarbleOverride(playerIndex, marbleId);
      clearAnimatingMarble();
      drawBoard(gameState);
      return;
    }
    const targetPos = waypoints[step++];
    const startPos  = prevPos;
    const start     = performance.now();

    function frame(now) {
      const t    = Math.min((now - start) / stepDuration, 1);
      const ease = t * t * (3 - 2 * t); // smoothstep
      setMarbleOverride(playerIndex, marbleId, {
        x: startPos.x + (targetPos.x - startPos.x) * ease,
        y: startPos.y + (targetPos.y - startPos.y) * ease,
      });
      drawBoard(gameState);
      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        prevPos = targetPos;
        animateToNext();
      }
    }
    requestAnimationFrame(frame);
  }

  animateToNext();
}

// ---- Backgammon-style notation helpers ----

// Convert a zone-descriptor { zone, space?, slot? } to a notation string.
function locNotation(loc) {
  if (!loc) return '?';
  if (loc.zone === 'base')   return 'bar';
  if (loc.zone === 'center') return 'hub';
  if (loc.zone === 'home')   return `h${loc.slot}`;
  if (loc.zone === 'track')  return String(loc.space);
  return '?';
}

// Emit accumulated moves for the current turn as a single numbered log line.
function flushTurnLog() {
  if (!turnLogDice) return;
  const name     = playerName(turnLogPlayer ?? gameState?.turnIndex);
  const diceStr  = `${turnLogDice[0]}-${turnLogDice[1]}`;
  const movesStr = turnLogMoves.length
    ? turnLogMoves.map(m => `${m.path.join('/')}${m.bumped ? '*' : ''}`).join(' ')
    : '--';
  log(`${turnNumber}. ${name}: ${diceStr}: ${movesStr}`);
  turnLogMoves = [];
  turnLogDice  = null;
}

// ---- Render helpers ----

function renderLobbySlots(slots) {
  const ul = $('lobby-slots');
  const iAmHost = ($('host-controls').style.display !== 'none');
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
    if (slot.isRobot && iAmHost) {
      const del = document.createElement('button');
      del.className = 'btn-remove-robot';
      del.textContent = '×';
      del.title = 'Remove robot';
      del.addEventListener('click', () => send({ action: 'removeRobot', playerIndex: slot.index }));
      li.appendChild(del);
    }
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
  $('turn-banner').textContent = 'Your turn — Roll! (Enter)';
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
