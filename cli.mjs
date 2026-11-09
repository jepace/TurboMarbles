#!/usr/bin/env node
// cli.mjs — TurboMarbles terminal client
// Usage: node cli.mjs [ws://localhost:3000]

import WebSocket  from 'ws';
import * as rl_   from 'readline';
import { fileURLToPath } from 'url';
import { PLAYER_CONFIG, ARM_MAP, ARM_COLORS, ALL_STARS, countdown, armOf } from './public/js/constants.js';

// ===== SECTION 1: CONFIG & CONSTANTS =====

const WS_URL = process.argv[2] ?? 'ws://localhost:3000';

// PLAYER_CONFIG entries don't carry a single-char initial — derive one for display.
const PLAYER_INITIAL = Object.fromEntries(
  PLAYER_CONFIG.map(p => [p.color, p.color[0].toUpperCase()])
);

// ===== SECTION 2: WEBSOCKET LAYER =====

let ws = null;
const _handlers = {};   // event → Set<fn>

function _dispatch(event, data) {
  const fns = _handlers[event];
  if (fns) for (const fn of [...fns]) fn(data);
}

export function on(event, fn) {
  if (!_handlers[event]) _handlers[event] = new Set();
  _handlers[event].add(fn);
}
export function off(event, fn) {
  _handlers[event]?.delete(fn);
}
function once(event) {
  return new Promise(resolve => {
    const fn = data => { off(event, fn); resolve(data); };
    on(event, fn);
  });
}
/** Race multiple events; cancels all losing listeners. */
function raceOnce(...events) {
  return new Promise(resolve => {
    const fns = events.map(event => {
      const fn = data => {
        fns.forEach(([ev, f]) => off(ev, f));
        resolve({ _event: event, ...data });
      };
      on(event, fn);
      return [event, fn];
    });
  });
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connectWs(url) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(url);
    ws.on('open',    () => resolve());
    ws.on('error',   err => reject(err));
    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      _dispatch(msg.event, msg);
    });
    ws.on('close', () => _dispatch('_close', {}));
  });
}

// ===== SECTION 3: READLINE / PRINT HELPERS =====

const rl = rl_.createInterface({ input: process.stdin, output: process.stdout });
rl.on('close', () => process.exit(0));

let _currentPrompt = '';

function ask(prompt) {
  _currentPrompt = prompt;
  return new Promise(resolve => {
    rl.question(prompt, ans => {
      _currentPrompt = '';
      resolve(ans.trim());
    });
  });
}

/** Print a line safely even while ask() is waiting for input. */
function print(msg) {
  if (_currentPrompt) {
    process.stdout.write('\r\x1b[K');
    console.log(msg);
    process.stdout.write(_currentPrompt);
  } else {
    console.log(msg);
  }
}

function hr() { print('─'.repeat(60)); }

// ===== SECTION 4: BOARD STATE DISPLAY =====

// Geometry constants (unitless, same as board.js with W=1)
const STAR_RING = 0.18;                  // radius of the inner star-track ring
const COL_OFF   = STAR_RING / 2;         // perp offset of U columns from arm axis
const COL_TOP   = COL_OFF * Math.sqrt(3); // along-axis coord of star row (row 1)
const R_OUTER   = 0.40;                  // bottom row of each U (row 6)
const ROW_STEP  = (R_OUTER - COL_TOP) / 5;
const BASE_R    = 0.46;                  // base row radius (outside the U)
const BASE_G    = 0.044;                 // spacing between base slots
const ASTEP      = (2 * Math.PI) / 6;

// Grid dimensions — each space cell is CELL wide chars.
// Requires ~140-column terminal. CELL=3: "NN*" (2-digit num + star/space).
const GRID_ROWS = 42;
const GRID_COLS = 140;
const CELL      = 3;

/** Convert unit-space (x,y) in roughly [-0.55,0.55] to grid (row, col).
 *  No aspect-ratio compression — the geometry proportions work at this scale. */
function toGrid(x, y) {
  const col = Math.round((x + 0.55) / 1.10 * (GRID_COLS - CELL));
  const row = Math.round((y + 0.55) / 1.10 * (GRID_ROWS - 1));
  return {
    row: Math.max(0, Math.min(GRID_ROWS - 1, row)),
    col: Math.max(0, Math.min(GRID_COLS - CELL, col)),
  };
}

function armAngle(a) { return a * ASTEP + Math.PI / 2; }

/** Build Map<key,{row,col}> for all spaces. Called once and cached.
 *
 *  Each arm is a wide U (see board-drawing in the repo root): a 5-space bottom
 *  row at R_OUTER, a left column rising to this arm's own star (base+8), and a
 *  right column descending from the PREVIOUS arm's star (prev+8). Stars sit on
 *  the boundary rays between arms at radius STAR_RING and are shared by both
 *  adjacent arms; the home corridor runs up the arm axis between the columns.
 */
export function buildSpaceGrid() {
  const m = new Map();

  for (let arm = 0; arm < 6; arm++) {
    const ang = armAngle(arm);
    const dx  = Math.cos(ang), dy = Math.sin(ang);   // axis unit vec
    const px  = -Math.sin(ang), py = Math.cos(ang);  // perp unit vec
    const base = arm * 14;
    const prev = ((arm + 5) % 6) * 14;

    // Helper: place point at (along-axis r, perp offset p) for this arm.
    // Positive p = left-column side (toward the next arm clockwise).
    function place(key, r, p) {
      m.set(key, toGrid(dx * r + px * p, dy * r + py * p));
    }
    // Along-axis coordinate of column row k (1 = star row … 6 = bottom row)
    const rowR = (k) => COL_TOP + ROW_STEP * (k - 1);

    // Bottom row of this arm's U: [base+3][base+2][base+1][prev+14][prev+13]
    place('t:' + (base + 1), R_OUTER, 0);            // start, on the arm axis
    place('t:' + (base + 2), R_OUTER, COL_OFF / 2);
    place('t:' + (base + 3), R_OUTER, COL_OFF);      // corner, bottom of left column

    // Left column rises to this arm's own star (rows 5 → 2)
    for (let i = 0; i < 4; i++) place('t:' + (base + 4 + i), rowR(5 - i), COL_OFF);

    // Star (row 1): on the boundary ray shared with the next arm's right column
    place('t:' + (base + 8), COL_TOP, COL_OFF);

    // Right column of this U descends from the PREVIOUS arm's star (rows 2 → 6)
    for (let i = 0; i < 4; i++) place('t:' + (prev + 9 + i), rowR(2 + i), -COL_OFF);
    place('t:' + (prev + 13), R_OUTER, -COL_OFF);    // corner, bottom of right column
    place('t:' + (prev + 14), R_OUTER, -COL_OFF / 2); // home entry, next to start

    // Home corridor: on the arm axis, aligned with column rows 4 (H1) … 1 (H4)
    for (let s = 1; s <= 4; s++) place('h:' + arm + ':' + s, rowR(5 - s), 0);

    // Base slots 0-3 in a 1×4 row outside the bottom edge; slot 0 on the
    // left from the player's seat (positive perp), matching B1…B4
    for (let mi = 0; mi < 4; mi++) {
      place('b:' + arm + ':' + mi, BASE_R, (1.5 - mi) * BASE_G);
    }
  }

  // Center hub
  m.set('c', toGrid(0, 0));

  return m;
}

const _spaceGrid = buildSpaceGrid();

// ---- Lookup helpers ----

function findMarbleAtTrack(gameState, space) {
  for (let pi = 0; pi < gameState.players.length; pi++) {
    const p = gameState.players[pi];
    for (let mi = 0; mi < p.marbles.length; mi++) {
      const m = p.marbles[mi];
      if (m.zone === 'track' && m.space === space) return { playerIndex: pi, marbleId: mi };
    }
  }
  return null;
}
function findMarbleAtHome(gameState, armIndex, slot) {
  // armIndex matches playerIndex (player i uses arm assigned to them)
  // The player's arm is stored in the game as player.color matching PLAYER_CONFIG[armIndex]
  // We look up by playerIndex matching armIndex
  for (let pi = 0; pi < gameState.players.length; pi++) {
    const p = gameState.players[pi];
    // find which arm this player occupies
    const armIdx = PLAYER_CONFIG.findIndex(c => c.color === p.color);
    if (armIdx !== armIndex) continue;
    for (let mi = 0; mi < p.marbles.length; mi++) {
      const m = p.marbles[mi];
      if (m.zone === 'home' && m.slot === slot) return { playerIndex: pi, marbleId: mi };
    }
  }
  return null;
}
function findMarbleAtBase(gameState, armIndex, slotIndex) {
  // Count marbles in base for this player; slotIndex is just visual placement
  for (let pi = 0; pi < gameState.players.length; pi++) {
    const p = gameState.players[pi];
    const armIdx = PLAYER_CONFIG.findIndex(c => c.color === p.color);
    if (armIdx !== armIndex) continue;
    const baseMarbles = p.marbles.filter(m => m.zone === 'base');
    return baseMarbles[slotIndex] ? { playerIndex: pi, marbleId: baseMarbles[slotIndex].id } : null;
  }
  return null;
}
function findMarbleAtCenter(gameState) {
  for (let pi = 0; pi < gameState.players.length; pi++) {
    const p = gameState.players[pi];
    for (let mi = 0; mi < p.marbles.length; mi++) {
      if (p.marbles[mi].zone === 'center') return { playerIndex: pi, marbleId: mi };
    }
  }
  return null;
}

function marbleInitial(playerIndex, gameState) {
  const color = gameState.players[playerIndex].color;
  return PLAYER_INITIAL[color] ?? '?';
}
function marbleLabel(playerIndex, marbleId, gameState) {
  return marbleInitial(playerIndex, gameState) + (marbleId + 1);
}

/** Draw the full ASCII board. */
function drawBoardAscii(gameState) {
  // Build empty char grid
  const grid = Array.from({ length: GRID_ROWS }, () => new Array(GRID_COLS).fill(' '));

  function putCell(row, col, s) {
    // write exactly CELL chars starting at col
    const padded = s.slice(0, CELL).padEnd(CELL, ' ');
    for (let i = 0; i < CELL && col + i < GRID_COLS; i++) {
      grid[row][col + i] = padded[i];
    }
  }

  // Track spaces 1–84. Cell format (CELL=3): "NN*" or "NN " or "AB*" or "AB "
  for (let sp = 1; sp <= 84; sp++) {
    const pos = _spaceGrid.get('t:' + sp);
    if (!pos) continue;
    const hit    = findMarbleAtTrack(gameState, sp);
    const isStar = ALL_STARS.has(sp);
    const label  = hit
      ? marbleLabel(hit.playerIndex, hit.marbleId, gameState) + (isStar ? '*' : ' ')
      : String(sp).padStart(2, ' ') + (isStar ? '*' : ' ');
    putCell(pos.row, pos.col, label);
  }

  // Home slots — "HN " or marble label
  for (let arm = 0; arm < 6; arm++) {
    for (let s = 1; s <= 4; s++) {
      const pos = _spaceGrid.get('h:' + arm + ':' + s);
      if (!pos) continue;
      const hit = findMarbleAtHome(gameState, arm, s);
      putCell(pos.row, pos.col, hit
        ? marbleLabel(hit.playerIndex, hit.marbleId, gameState) + ' '
        : 'H' + s + ' ');
    }
  }

  // Base slots — show occupied marbles; empty slots just show a dot
  for (let arm = 0; arm < 6; arm++) {
    let baseMarbles = [];
    let playerIdx = -1;
    for (let pi = 0; pi < gameState.players.length; pi++) {
      const p = gameState.players[pi];
      if (PLAYER_CONFIG.findIndex(c => c.color === p.color) !== arm) continue;
      playerIdx = pi;
      baseMarbles = p.marbles
        .map((m, mi) => ({ m, mi }))
        .filter(({ m }) => m.zone === 'base');
    }
    for (let slot = 0; slot < 4; slot++) {
      const pos = _spaceGrid.get('b:' + arm + ':' + slot);
      if (!pos) continue;
      const entry = baseMarbles[slot];
      putCell(pos.row, pos.col, entry && playerIdx >= 0
        ? marbleLabel(playerIdx, entry.mi, gameState) + ' '
        : '·  ');
    }
  }

  // Center hub
  {
    const pos = _spaceGrid.get('c');
    if (pos) {
      const hit = findMarbleAtCenter(gameState);
      putCell(pos.row, pos.col, hit
        ? marbleLabel(hit.playerIndex, hit.marbleId, gameState) + ' '
        : 'CS ');
    }
  }

  // Print board
  const turnPlayer = gameState.players[gameState.turnIndex];
  console.log(`\nTurn: ${turnPlayer.name} (${turnPlayer.color})` +
    (gameState.dice ? `  Dice: ${gameState.dice[0]}${gameState.diceUsed[0] ? '✓' : ''} ${gameState.dice[1]}${gameState.diceUsed[1] ? '✓' : ''}` : ''));
  for (const row of grid) console.log(row.join(''));
}

// ---- Simple text helpers (for event log lines) ----

// Squares are shown in a player's own numbers: the countdown to their home
// entry (backgammon style). arm = that player's arm (default: blue).
const sq = (space, arm = 0) => String(countdown(arm, space) + 1);
function describeMarble(m, arm = 0) {
  if (m.zone === 'base')   return 'base';
  if (m.zone === 'track')  return sq(m.space, arm);
  if (m.zone === 'home')   return `home slot ${m.slot}`;
  if (m.zone === 'center') return 'center hub';
  return '?';
}
function locStr(loc, arm = 0) {
  if (!loc) return '?';
  if (loc.zone === 'base')   return 'base';
  if (loc.zone === 'center') return 'center hub';
  if (loc.zone === 'home')   return `home slot ${loc.slot}`;
  if (loc.zone === 'track')  return sq(loc.space, arm);
  return '?';
}

// ===== SECTION 5: MOVE DESCRIPTION FORMATTING =====

export function describeMove(move, dice, arm = 0) {
  const spaceName = s => sq(s, arm);
  const dieVal = dice ? dice[move.dieIndex] : '?';
  const dieTag = `[die ${move.dieIndex + 1}=${dieVal}]`;

  let dest;
  switch (move.type) {
    case 'exitBase':
      dest = `Exit base → ${spaceName(move.toSpace)} (start)`;
      break;
    case 'move':
      if (move.toZone === 'home') {
        dest = `Move → home slot ${move.toSlot}`;
      } else {
        dest = `Move → ${spaceName(move.toSpace)}`;
      }
      break;
    case 'moveHome':
      dest = `Advance in home → slot ${move.toSlot}`;
      break;
    case 'enterCenter':
      if (move.starsPath && move.starsPath.length > 0) {
        dest = `Star track (${move.starsPath.map(spaceName).join('→')}) → center hub`;
      } else {
        dest = `Enter center hub`;
      }
      break;
    case 'exitCenter': {
      dest = `Exit hub → ${spaceName(move.toSpace)}`;
      break;
    }
    case 'moveStar': {
      const path = (move.starsPath ?? []).map(spaceName).join('→');
      const pathStr = path ? ` (${path})` : '';
      if (move.toZone === 'home') {
        dest = `Star track${pathStr} → home slot ${move.toSlot}`;
      } else {
        dest = `Star track${pathStr} → ${spaceName(move.toSpace)}`;
      }
      break;
    }
    default:
      dest = `${move.type} → ${move.toZone}`;
  }

  return `${dieTag} ${dest}`;
}

// ===== SECTION 6: GAME LOOP =====

let gameState      = null;
let myPlayerIndex  = null;
const myArm = () => Math.max(0, armOf(gameState?.players?.[myPlayerIndex]?.color ?? ''));
let reconnectInfo  = null;

function nameOf(index) {
  return gameState?.players[index]?.name ?? `Player ${index + 1}`;
}

// ---- Spectator event registration ----

function registerSpectatorEvents() {
  on('playerJoined', ({ playerIndex, name, color, isRobot }) => {
    print(`  ${name} (${color})${isRobot ? ' [robot]' : ''} joined as player ${playerIndex + 1}`);
  });
  on('playerLeft', ({ playerIndex }) => {
    print(`  Player ${playerIndex + 1} left.`);
  });
  on('turnChanged', ({ playerIndex }) => {
    print(`--- ${nameOf(playerIndex)}'s turn ---`);
  });
  on('extraRoll', ({ playerIndex }) => {
    print(`  ${nameOf(playerIndex)} rolled a 6 — extra roll!`);
  });
  on('marbleMoved', ({ playerIndex, marbleId, from, to }) => {
    const mArm = armOf(gameState?.players?.[playerIndex]?.color ?? '');
    print(`  ${nameOf(playerIndex)} moved marble #${marbleId + 1}: ${locStr(from, mArm)} → ${locStr(to, mArm)}`);
  });
  on('marbleBumped', ({ ownerIndex, marbleId }) => {
    print(`  ** ${nameOf(ownerIndex)}'s marble #${marbleId + 1} was bumped back to base! **`);
  });
  on('dieForfeit', ({ dieIndex }) => {
    print(`  Die ${dieIndex + 1} forfeited (no legal moves).`);
  });
  on('turnSkipped', ({ playerIndex }) => {
    print(`  ${nameOf(playerIndex)}'s turn skipped — no legal moves.`);
  });
  on('playerDisconnected', ({ playerIndex, timeoutMs }) => {
    print(`  ${nameOf(playerIndex)} disconnected (${Math.round(timeoutMs / 1000)}s to reconnect).`);
  });
  on('robotTookOver', ({ playerIndex }) => {
    print(`  Robot took over for ${nameOf(playerIndex)}.`);
  });
  on('playerReconnected', ({ playerIndex }) => {
    print(`  ${nameOf(playerIndex)} reconnected.`);
  });
  on('error', ({ message }) => {
    print(`  [server error] ${message}`);
  });
}

// ---- Lobby ----

async function lobbyFlow() {
  const action = await ask('Create or join a room? [c/j]: ');
  if (action.toLowerCase() === 'c') {
    await createFlow();
  } else {
    await joinFlow();
  }
  console.log('\nWaiting for game to start…');
  const { gameState: gs } = await once('gameStarted');
  await gameLoop(gs);
}

async function createFlow() {
  const name = await ask('Your name: ');
  let count;
  while (true) {
    const raw = await ask('Total players (2–6): ');
    count = parseInt(raw, 10);
    if (count >= 2 && count <= 6) break;
    console.log('  Please enter a number from 2 to 6.');
  }

  const arms      = ARM_MAP[count] ?? [0];
  const available = arms.map(a => ARM_COLORS[a]);
  console.log('Color options: ' + available.join(', '));
  let color;
  while (true) {
    color = (await ask('Your color: ')).toLowerCase();
    if (available.includes(color)) break;
    console.log(`  Choose one of: ${available.join(', ')}`);
  }

  send({ action: 'createRoom', name, totalPlayers: count, hostColor: color });
  const res = await raceOnce('roomCreated', 'error');
  if (res._event === 'error') { console.log('Error: ' + res.message); process.exit(1); }

  const { roomId, code, reconnectToken } = res;
  reconnectInfo  = { roomId, playerIndex: 0, reconnectToken };
  myPlayerIndex  = 0;

  console.log('\n╔══════════════════════╗');
  console.log(`║  ROOM CODE:  ${code}  ║`);
  console.log('╚══════════════════════╝\n');

  registerSpectatorEvents();

  while (true) {
    const cmd = (await ask('Add a robot, or start? [r=robot / s=start]: ')).toLowerCase();
    if (cmd === 'r') {
      send({ action: 'addRobot' });
      await new Promise(r => setTimeout(r, 100)); // brief pause for playerJoined echo
    } else if (cmd === 's') {
      break;
    }
  }
  send({ action: 'startGame' });
}

async function joinFlow() {
  const name = await ask('Your name: ');
  const code = (await ask('Room code: ')).toUpperCase().trim();

  send({ action: 'joinRoom', code, name });
  const res = await raceOnce('joinedRoom', 'error');
  if (res._event === 'error') { console.log('Error: ' + res.message); process.exit(1); }

  const { roomId, playerIndex, reconnectToken } = res;
  reconnectInfo = { roomId, playerIndex, reconnectToken };
  myPlayerIndex = playerIndex;

  const slot = res.lobbyState?.slots?.[playerIndex];
  console.log(`\nJoined as player ${playerIndex + 1}${slot ? ` (${slot.color})` : ''}.`);
  registerSpectatorEvents();
}

// ---- Reconnect ----

on('_close', async () => {
  if (!reconnectInfo) return;
  print('\n[Connection lost — reconnecting in 2s…]');
  await new Promise(r => setTimeout(r, 2000));
  try {
    await connectWs(WS_URL);
    send({ action: 'reconnect', ...reconnectInfo });
    const res = await raceOnce('reconnected', 'error');
    if (res._event === 'reconnected') {
      gameState = res.gameState;
      print('[Reconnected!]');
      drawBoardAscii(gameState);
    } else {
      print('[Reconnect failed: ' + res.message + ']');
      process.exit(1);
    }
  } catch (e) {
    print('[Reconnect error: ' + e.message + ']');
    process.exit(1);
  }
});

// ---- Main game loop ----

async function gameLoop(initialState) {
  gameState = initialState;
  drawBoardAscii(gameState);

  // Persistent state-sync handlers (fire for all players)
  on('marbleMoved', ({ playerIndex, marbleId, to }) => {
    const marble = gameState.players[playerIndex]?.marbles[marbleId];
    if (marble) Object.assign(marble, to);
    // Only redraw immediately for the human player's own moves; other players'
    // moves are shown at the next turn boundary to avoid flooding the terminal.
    if (playerIndex === myPlayerIndex && gameState) drawBoardAscii(gameState);
  });
  on('marbleBumped', ({ ownerIndex, marbleId }) => {
    const marble = gameState.players[ownerIndex]?.marbles[marbleId];
    if (marble) { marble.zone = 'base'; marble.space = null; marble.slot = null; marble.starEligible = false; }
  });
  on('turnChanged', ({ playerIndex }) => {
    gameState.turnIndex = playerIndex;
    gameState.phase     = 'IN_TURN';
    gameState.dice      = null;
    // Redraw once at turn boundary so the human always sees the latest board.
    if (gameState) drawBoardAscii(gameState);
    gameState.diceUsed  = [false, false];
  });
  on('extraRoll', ({ playerIndex }) => {
    gameState.phase = 'EXTRA_ROLL';
  });
  on('undone', ({ gameState: gs }) => {
    gameState = gs;
    drawBoardAscii(gameState);
  });

  // Wrap game-over check around the main loop
  let gameOver = false;
  on('gameOver', ({ winnerIndex }) => {
    gameOver = true;
    console.log(`\n🏆  Game over! ${nameOf(winnerIndex)} wins!\n`);
    rl.close();
  });

  while (!gameOver) {
    // Wait for our turn (or game over)
    await waitForMyTurn(() => gameOver);
    if (gameOver) break;

    const over = await takeTurn();
    if (over) break;
  }
}

async function waitForMyTurn(isOver) {
  if (isOver?.()) return;
  const alreadyMyTurn =
    gameState.turnIndex === myPlayerIndex &&
    (gameState.phase === 'IN_TURN' || gameState.phase === 'EXTRA_ROLL');
  if (alreadyMyTurn) return;

  await new Promise(resolve => {
    function check({ playerIndex }) {
      if (playerIndex === myPlayerIndex) {
        off('turnChanged', check);
        off('extraRoll',   check);
        resolve();
      }
    }
    on('turnChanged', check);
    on('extraRoll',   check);
  });
}

async function takeTurn() {
  await ask('\n[Enter to roll…] ');
  send({ action: 'roll' });

  const rolled = await once('rolled');
  gameState.dice     = rolled.dice;
  gameState.diceUsed = [false, false];
  gameState.phase    = 'AWAITING_MOVE';
  console.log(`You rolled: ${rolled.dice[0]} and ${rolled.dice[1]}`);
  drawBoardAscii(gameState);

  let legalMoves = rolled.moves;

  // Move phase — repeat until readyToCommit or game over
  let commitReady = false;
  while (!commitReady) {
    const result = await pickAndSendMove(legalMoves);

    if (result === 'gameOver') return true;
    if (result === 'noop') {
      // No moves — wait for server to auto-forfeit
      const next = await raceOnce('dieForfeit', 'legalMoves', 'readyToCommit', 'gameOver');
      if (next._event === 'gameOver')      return true;
      if (next._event === 'readyToCommit') { commitReady = true; break; }
      if (next._event === 'dieForfeit')    { gameState.diceUsed[next.dieIndex] = true; }
      if (next._event === 'legalMoves')    { legalMoves = next.moves; gameState.diceUsed = next.diceUsed; }
      continue;
    }
    if (result === 'undo') {
      // Undo was sent; wait for 'undone' (spectator handler updates gameState)
      const undoneMsg = await once('undone');
      legalMoves = {};  // will be replaced by legalMoves event after undo
      const next = await once('legalMoves');
      legalMoves = next.moves;
      gameState.diceUsed = next.diceUsed;
      continue;
    }

    // A move was sent — wait for next event
    const next = await raceOnce('legalMoves', 'readyToCommit', 'gameOver', 'dieForfeit');
    if (next._event === 'gameOver')      return true;
    if (next._event === 'readyToCommit') { commitReady = true; break; }
    if (next._event === 'dieForfeit')    {
      gameState.diceUsed[next.dieIndex] = true;
      // Another event might follow
      const next2 = await raceOnce('legalMoves', 'readyToCommit', 'gameOver');
      if (next2._event === 'gameOver')      return true;
      if (next2._event === 'readyToCommit') { commitReady = true; break; }
      if (next2._event === 'legalMoves')    { legalMoves = next2.moves; gameState.diceUsed = next2.diceUsed; }
    }
    if (next._event === 'legalMoves') {
      legalMoves = next.moves;
      gameState.diceUsed = next.diceUsed;
    }
  }

  // Both dice used — commit or undo
  while (true) {
    const res = await commitOrUndo();
    if (res === 'committed') return false;
    if (res === 'undone') {
      // After undo, server sends legalMoves
      const next = await once('legalMoves');
      legalMoves = next.moves;
      gameState.diceUsed = next.diceUsed;
      // Re-enter move phase
      commitReady = false;
      while (!commitReady) {
        const result = await pickAndSendMove(legalMoves);
        if (result === 'gameOver') return true;
        if (result === 'undo') {
          await once('undone');
          const nm = await once('legalMoves');
          legalMoves = nm.moves;
          gameState.diceUsed = nm.diceUsed;
          continue;
        }
        const n = await raceOnce('legalMoves', 'readyToCommit', 'gameOver', 'dieForfeit');
        if (n._event === 'gameOver')      return true;
        if (n._event === 'readyToCommit') { commitReady = true; break; }
        if (n._event === 'legalMoves')    { legalMoves = n.moves; gameState.diceUsed = n.diceUsed; }
      }
      continue;
    }
  }
}

async function pickAndSendMove(legalMoves) {
  const myPlayer = gameState.players[myPlayerIndex];

  // Gather marbles that have moves on any unused die
  const marblesWithMoves = [];
  for (let mi = 0; mi < myPlayer.marbles.length; mi++) {
    const movesForMarble = [];
    for (let d = 0; d < 2; d++) {
      if (gameState.diceUsed[d]) continue;
      for (const mv of (legalMoves[d] ?? [])) {
        if (mv.marbleId === mi) movesForMarble.push(mv);
      }
    }
    if (movesForMarble.length > 0) marblesWithMoves.push({ marbleId: mi, moves: movesForMarble });
  }

  if (marblesWithMoves.length === 0) return 'noop';

  // --- Pick marble ---
  console.log('\nMarbles you can move:');
  for (let i = 0; i < marblesWithMoves.length; i++) {
    const { marbleId } = marblesWithMoves[i];
    const marble       = myPlayer.marbles[marbleId];
    console.log(`  ${i + 1}) Marble #${marbleId + 1} at ${describeMarble(marble, myArm())}`);
  }
  console.log('  u) Undo last move');
  console.log('  q) Quit');

  let chosen;
  while (true) {
    const inp = (await ask('Choose marble [1–N / u / q]: ')).toLowerCase();
    if (inp === 'q') { rl.close(); process.exit(0); }
    if (inp === 'u') { send({ action: 'undo' }); return 'undo'; }
    const n = parseInt(inp, 10);
    if (n >= 1 && n <= marblesWithMoves.length) { chosen = marblesWithMoves[n - 1]; break; }
    console.log('  Invalid — try again.');
  }

  // --- Pick destination ---
  const { marbleId, moves } = chosen;
  const marble = myPlayer.marbles[marbleId];
  console.log(`\nMarble #${marbleId + 1} (at ${describeMarble(marble, myArm())}) destinations:`);
  for (let i = 0; i < moves.length; i++) {
    console.log(`  ${i + 1}) ${describeMove(moves[i], gameState.dice, myArm())}`);
  }
  console.log('  b) Back');

  while (true) {
    const inp = (await ask('Choose destination [1–N / b]: ')).toLowerCase();
    if (inp === 'b') return await pickAndSendMove(legalMoves); // recurse back
    const n = parseInt(inp, 10);
    if (n >= 1 && n <= moves.length) {
      send({ action: 'move', move: moves[n - 1] });
      return 'moved';
    }
    console.log('  Invalid — try again.');
  }
}

async function commitOrUndo() {
  const inp = (await ask('Both dice used. [c]ommit or [u]ndo? ')).toLowerCase();
  if (inp === 'c') { send({ action: 'commit' }); return 'committed'; }
  if (inp === 'u') { send({ action: 'undo' }); await once('undone'); return 'undone'; }
  return await commitOrUndo(); // re-prompt on bad input
}

// ===== SECTION 7: ENTRY POINT =====

async function main() {
  console.log(`Connecting to ${WS_URL}…`);
  try {
    await connectWs(WS_URL);
  } catch (e) {
    console.error('Could not connect:', e.message);
    process.exit(1);
  }
  console.log('Connected.\n');
  await lobbyFlow();
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}
