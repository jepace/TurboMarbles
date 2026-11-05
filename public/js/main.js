// main.js — UI controller, screen management, game event handling

import { connect, on, send, setReconnectInfo } from './socket.js';
import { init as initBoard, drawBoard, resize as resizeBoard,
         hitTestMarble, highlightSpaces, highlightMarbleAt, getSpacePosition,
         setMarbleOverride, clearMarbleOverride,
         setAnimatingMarble, clearAnimatingMarble,
         getBasePosition, clearAllMarbleOverrides, spaceAt } from './board.js';
import { ARM_MAP, ARM_COLORS, PLAYER_CONFIG, spaceName } from './constants.js';
import { playBonk, playClick, playHomeChime } from './sounds.js';

// ---- State ----
let myPlayerIndex = null;
let myName = null;
let roomId = null;
let gameState = null;
let selectedMarble = null;      // { playerIndex, marbleId } currently selected
let legalMovesCache = null;     // { 0: [...], 1: [...] } from server after roll
let selectedMarbleMoves = [];   // filtered moves for selectedMarble (for highlighting)
let selectedDie = null;         // 0 or 1 — player-locked die; null means auto
let commitPending = false;      // true when readyToCommit received, waiting for Commit click

// ---- Per-turn move log accumulation (for backgammon notation) ----
let turnNumber    = 0;    // increments each turnChanged; set to 1 on gameStarted
let turnLogMoves  = [];   // [{ marbleId, path: [str,...], bumped }] for current turn
let turnLogDice   = null; // [die0, die1] rolled this turn
let turnLogPlayer = null; // playerIndex for current turn
let pendingFeedback = null; // { text, cls } — robot comparison for my roll, logged with it

// ---- Player options (remembered in this browser) ----
// Move feedback: after committing a roll, show how the robot would have played it.
// Post-game analysis: offer the "Analyze Game" button when a game ends.
const settings = { feedback: true, analysis: true };
try {
  const saved = JSON.parse(localStorage.getItem('tm.settings') ?? '{}');
  if (typeof saved.feedback === 'boolean') settings.feedback = saved.feedback;
  if (typeof saved.analysis === 'boolean') settings.analysis = saved.analysis;
} catch { /* storage unavailable: use defaults */ }
function saveSettings() {
  try { localStorage.setItem('tm.settings', JSON.stringify(settings)); } catch { /* ignore */ }
}
// Bumps seen since the last marbleMoved. The server emits marbleBumped right
// before the attacker's marbleMoved, so we stash them here and the very next
// marbleMoved enqueues their fly-home tweens (after the attacker's). Purely an
// event-correlation handoff — never held across animations.
let bumpHandoff   = []; // [{ ownerIndex, marbleId, fromPos }]
let lastAnimEnd   = null; // { playerIndex, marbleId } — last marble whose tween just finished

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
  const n = parseInt($('create-count').value, 10);
  updateColorPicker(n >= 2 && n <= 6 ? n : 4);
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
  if (!code) return; // the server validates the code itself
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

for (let i = 0; i < 2; i++) {
  $(`die-${i}`).addEventListener('click', () => {
    if (!isMyTurn() || gameState?.phase !== 'AWAITING_MOVE') return;
    if (gameState?.diceUsed?.[i]) return;
    selectedDie = (selectedDie === i) ? null : i;
    selectedMarbleMoves = selectedMarble ? computeLegalDestinations(selectedMarble) : [];
    renderDice(gameState.dice);
    if (selectedMarble) {
      highlightSpaces(selectedMarbleMoves.map(moveToSpace).filter(Boolean));
      drawBoard(gameState);
    }
  });
}

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
$('btn-skip').addEventListener('click', doSkipDie);

function doSkipDie() {
  const i = skippableDieIndex();
  if (i < 0) return;
  send({ action: 'forfeitDie', dieIndex: i });
  $('btn-skip').style.display = 'none';
}

function doCommit() {
  send({ action: 'commit' });
  commitPending = false;
  $('btn-commit').style.display = 'none';
  $('btn-undo').style.display   = 'none';
  $('btn-skip').style.display   = 'none';
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

// The first unused die whose ONLY legal moves are optional (e.g. the pass-home
// "go around the board again" choice). Such a die can be voluntarily skipped
// rather than forcing the player to loop the track. Returns the die index or -1.
function skippableDieIndex() {
  if (!isMyTurn() || !legalMovesCache || commitPending) return -1;
  const used = gameState?.diceUsed ?? [false, false];
  // Mirrors the server: no skipping while the other die still has a mandatory
  // move, since playing it first might give this die one.
  const mandatory = i => !used[i] && (legalMovesCache[i] ?? []).some(m => !m.optional);
  for (let i = 0; i < 2; i++) {
    if (used[i]) continue;
    const moves = legalMovesCache[i] ?? [];
    if (moves.length > 0 && moves.every(m => m.optional) && !mandatory(1 - i)) return i;
  }
  return -1;
}

// Show the Skip Die button only when the active player has a die whose sole
// remaining option is to go around the board again.
function updateSkipButton() {
  $('btn-skip').style.display = skippableDieIndex() >= 0 ? 'inline-flex' : 'none';
}

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

// ---- In-game [-] key — Skip Die (next to Enter on the number pad) ----
// The lobby's own "-" (remove a robot) only acts on the lobby screen.
document.addEventListener('keydown', e => {
  if (e.key !== '-') return;
  if (!$('screen-game').classList.contains('active')) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if ($('btn-skip').style.display === 'none') return; // nothing to skip right now
  e.preventDefault();
  doSkipDie();
});

// ---- Lobby [+]/[-] keys — host adds/removes a robot ----
document.addEventListener('keydown', e => {
  // "=" is an undocumented alias for "+" so adding robots doesn't require Shift.
  if (e.key !== '+' && e.key !== '=' && e.key !== '-') return;
  // Only in the waiting room, and only the host (host-controls visible)
  if (!$('screen-lobby').classList.contains('active')) return;
  if ($('host-controls').style.display === 'none') return;
  // Don't fire while typing in an input/textarea
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  if (e.key === '+' || e.key === '=') {
    if (!$('btn-add-robot').disabled) send({ action: 'addRobot' });
  } else {
    // Remove the highest-index robot currently in a slot
    const items = [...document.querySelectorAll('#lobby-slots li')];
    for (let i = items.length - 1; i >= 0; i--) {
      const nameEl = items[i].querySelector('.slot-name');
      if (nameEl && nameEl.textContent.includes('🤖')) {
        const playerIndex = Number(items[i].id.replace('slot-', ''));
        send({ action: 'removeRobot', playerIndex });
        break;
      }
    }
  }
  e.preventDefault();
});

// ---- Play again ----
$('btn-play-again').addEventListener('click', () => {
  $('win-overlay').style.display = 'none';
  show('screen-landing');
});

// ---- Copy log ----
// Plain-text move log, with a header naming each player's color, so a finished
// game can be pasted somewhere for review.
function moveLogText() {
  const players = (gameState?.players ?? [])
    .map(p => `  ${p.name} (${p.color})`)
    .join('\n');
  const lines = [...$('game-log').children].map(el => el.textContent);
  return [
    `TurboMarbles game log — ${new Date().toISOString()}`,
    'Players:',
    players,
    '',
    ...lines,
    '',
  ].join('\n');
}

$('btn-copy-log').addEventListener('click', async () => {
  const btn  = $('btn-copy-log');
  const text = moveLogText();
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied ✓';
  } catch {
    // Clipboard unavailable (e.g. non-HTTPS origin) — fall back to a download.
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = `turbomarbles-log-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
    btn.textContent = 'Downloaded ✓';
  }
  setTimeout(() => { btn.textContent = 'Copy Log'; }, 2000);
});

// ---- Canvas click (marble selection & move) ----
$('board-canvas').addEventListener('click', onCanvasClick);

// ---- Square names on hover ----
// Shows e.g. "B↓3 · 3 before Blue's home entry" next to the cursor.
const armName = a => ARM_COLORS[a][0].toUpperCase() + ARM_COLORS[a].slice(1);
function describeSquare(hit) {
  if (hit.kind === 'hub')  return ['hub', 'centre hub — leave with a 1'];
  if (hit.kind === 'base') return ['base', `${armName(hit.arm)}'s base`];
  if (hit.kind === 'home') return [`h${hit.slot}`, `${armName(hit.arm)}'s home, slot ${hit.slot}`];
  const name = spaceName(hit.space);
  const arm = PLAYER_CONFIG.findIndex(c => c.start === hit.space || c.homeEntry === hit.space || c.star === hit.space);
  if (arm !== -1) {
    const c = PLAYER_CONFIG[arm];
    if (c.start === hit.space)     return [name, `${armName(arm)}'s start`];
    if (c.homeEntry === hit.space) return [name, `${armName(arm)}'s home entry`];
    return [name, `${armName(arm)}'s star — star track`];
  }
  const owner = 'BPOYGW'.indexOf(name[0]);
  const n = Number(name.slice(2));
  return name[1] === '\u2193'
    ? [name, `${n} before ${armName(owner)}'s home entry`]
    : [name, `${n - 1} after ${armName(owner)}'s start`];
}
$('board-canvas').addEventListener('mousemove', e => {
  const canvas = e.currentTarget, tip = $('board-tip');
  const rect = canvas.getBoundingClientRect();
  const hit = spaceAt((e.clientX - rect.left) * canvas.width / rect.width,
                      (e.clientY - rect.top) * canvas.height / rect.height);
  if (!hit) { tip.style.display = 'none'; return; }
  const [name, what] = describeSquare(hit);
  tip.replaceChildren();
  const b = document.createElement('b'); b.textContent = name;
  tip.append(b, what);
  const area = $('board-area').getBoundingClientRect();
  tip.style.left = `${e.clientX - area.left + 14}px`;
  tip.style.top  = `${e.clientY - area.top + 14}px`;
  tip.style.display = 'block';
});
$('board-canvas').addEventListener('mouseleave', () => { $('board-tip').style.display = 'none'; });

// ---- Socket events ----

on('error', ({ code, message }) => {
  if (code && code.startsWith('ANALYSIS')) resetAnalyzeButton();
  alert(message);
});

// ---- Move feedback (robot comparison after each committed roll) ----
on('moveFeedback', fb => {
  if (fb.playerIndex !== myPlayerIndex || !settings.feedback) return;
  // A forced roll was played the only way it could be — the robot agrees.
  if (fb.forced) { pendingFeedback = { text: '✓ Robot agrees', cls: 'agree' }; return; }
  let text = fb.robotAgrees ? '✓ Robot agrees' : `Robot would play ${fb.robotMoves}`;
  if (fb.endgame) {
    text += fb.endgame.best ? ' · exact: best play'
      : ` · exact: costs +${fb.endgame.cost.toFixed(2)} turns (best ${fb.endgame.bestMoves})`;
  }
  const good = fb.robotAgrees && (!fb.endgame || fb.endgame.best);
  pendingFeedback = { text, cls: good ? 'agree' : 'differ' };
});

// ---- Post-game analysis ----
function resetAnalyzeButton() {
  const btn = $('btn-analyze');
  btn.disabled = false;
  btn.textContent = 'Analyze Game';
}
$('btn-analyze').addEventListener('click', () => {
  const btn = $('btn-analyze');
  btn.disabled = true;
  btn.textContent = 'Analyzing…';
  send({ action: 'analyzeGame' });
});
on('analysisProgress', ({ done, total }) => {
  $('btn-analyze').textContent = `Analyzing… ${done}/${total}`;
});
on('analysisResult', ({ items }) => {
  const btn = $('btn-analyze');
  btn.textContent = 'Analyzed';
  const box = $('analysis');
  box.replaceChildren();
  box.style.display = 'flex';
  const line = (text, cls) => { const d = document.createElement('div'); d.textContent = text; if (cls) d.className = cls; box.appendChild(d); return d; };
  if (!items.length) { line('No moves to analyse — every roll was forced.', 'muted'); return; }
  const pct = p => `${Math.round(100 * p)}%`;
  const mistakes = items.filter(i => i.mistake).sort((a, b) => b.loss - a.loss);
  const lost = mistakes.reduce((s, i) => s + i.loss, 0);
  line(`${items.length} decisions analysed · ${mistakes.length} clear mistake${mistakes.length === 1 ? '' : 's'}` +
       (mistakes.length ? ` · ${Math.round(100 * lost)} win-rate points lost` : ''), 'summary');
  for (const m of mistakes) {
    line(`Turn ${m.turn} (${m.dice.join('-')}): you played ${m.played} — ${pct(m.playedWin)} to win. ` +
         `Better: ${m.best} — ${pct(m.bestWin)} (−${Math.round(100 * m.loss)} pts).`, 'mistake');
  }
  line(mistakes.length ? 'Every other decision was as good as the best option.' : 'Every decision was as good as the best option.', 'muted');
  line('Win rates come from playing each option out hundreds of times with robot-level play.', 'muted');
});

// ---- Options checkboxes ----
$('opt-feedback').checked = settings.feedback;
$('opt-analysis').checked = settings.analysis;
$('opt-feedback').addEventListener('change', e => { settings.feedback = e.target.checked; saveSettings(); });
$('opt-analysis').addEventListener('change', e => {
  settings.analysis = e.target.checked; saveSettings();
  $('btn-analyze').style.display = settings.analysis ? '' : 'none';
});

on('roomCreated', ({ roomId: rid, code, reconnectToken, color, totalPlayers, slots }) => {
  roomId = rid;
  myPlayerIndex = 0;
  setReconnectInfo({ roomId: rid, playerIndex: 0, reconnectToken });
  $('lobby-code').textContent = code;
  $('lobby-size').textContent = `${totalPlayers} players`;
  $('host-controls').style.display = 'flex';
  $('lobby-wait-msg').style.display = 'none';
  renderLobbySlots(slots ?? [{ index: 0, name: myName, color: color ?? 'yellow', isRobot: false, filled: true }]);
  updateStartButton();
  show('screen-lobby');
});

on('joinedRoom', ({ roomId: rid, playerIndex, lobbyState, reconnectToken }) => {
  roomId = rid;
  myPlayerIndex = playerIndex;
  setReconnectInfo({ roomId: rid, playerIndex, reconnectToken });
  $('lobby-code').textContent = lobbyState.code;
  $('lobby-size').textContent = `${lobbyState.totalPlayers} players`;
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
  if (iAmHost) updateStartButton();
});

on('playerLeft', ({ playerIndex }) => {
  const li = $(`slot-${playerIndex}`);
  if (!li) return;
  li.querySelector('.slot-name').textContent = '(empty)';
  const del = li.querySelector('.btn-remove-robot');
  if (del) del.remove();
  if ($('host-controls').style.display !== 'none') updateStartButton();
});

function updateStartButton() {
  const empty = document.querySelectorAll('#lobby-slots .slot-name');
  const waiting = [...empty].filter(el => el.textContent === '(empty)').length;
  const btn = $('btn-start');
  btn.disabled = waiting > 0;
  btn.title = waiting > 0 ? `Waiting for ${waiting} more player${waiting > 1 ? 's' : ''}…` : '';
}

on('gameStarted', ({ gameState: gs }) => {
  gameState = gs;
  pendingFeedback = null;
  resetAnalyzeButton();
  $('analysis').replaceChildren();
  $('analysis').style.display = 'none';
  show('screen-game');
  initBoard($('board-canvas'));
  setCommitVisible(false); setUndoVisible(false);
  commitPending = false;
  // Fresh game: drop everything left over from a previous game in this tab.
  $('game-log').replaceChildren();
  turnNumber    = 1;
  turnLogMoves  = [];
  turnLogDice   = null;
  turnLogPlayer = null;
  resetAnimations();
  renderSidebar();
  renderDice(null, gameState.players[gameState.turnIndex]?.color);
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
  renderDice(dice, gameState.players[playerIndex]?.color);
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
  updateSkipButton();
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
  updateSkipButton();
});

on('marbleMoved', ({ playerIndex, marbleId, from, to, path }) => {
  const marble = gameState.players[playerIndex].marbles[marbleId];

  // Capture from-position before updating state (for the tween start point).
  // A base has one slot per marble, so leaving base starts from this marble's
  // own slot (zoneToSpace has no single position for "base").
  const fromPos = from.zone === 'base'
    ? getBasePosition(playerIndex, marbleId)
    : getSpacePosition(zoneToSpace(from, playerIndex));

  // Update game state immediately — render is always driven by authoritative state
  Object.assign(marble, to);
  const chime = to.zone === 'home' && from.zone !== 'home';
  selectedMarble = null;
  selectedMarbleMoves = [];

  // Consume any bumps the server reported just before this move (this is the
  // attacker that caused them). They fly home after the attacker arrives.
  const victims = bumpHandoff;
  bumpHandoff = [];
  const bumped = victims.length > 0;

  // Accumulate move for backgammon notation; merge consecutive same-marble moves.
  // Bump spaces are marked with * inline (e.g. "28/29*/30") using the victim's
  // zone location so the asterisk lands on the right space, not the final one.
  const bumpLocs = new Set(victims.map(v => locNotation(v.loc)));
  const fromStr = locNotation(from);
  const toStr   = locNotation(to) + (bumpLocs.has(locNotation(to)) ? '*' : '');
  const last    = turnLogMoves[turnLogMoves.length - 1];
  if (last && last.marbleId === marbleId) {
    // Strip any trailing * from the previous segment's last entry to compare cleanly
    const prevLast = last.path[last.path.length - 1].replace('*', '');
    if (prevLast === fromStr) {
      last.path.push(toStr);
    } else {
      turnLogMoves.push({ marbleId, path: [fromStr, toStr] });
    }
  } else {
    turnLogMoves.push({ marbleId, path: [fromStr, toStr] });
  }

  // Build canvas waypoints from server path
  const waypoints = (path ?? []).map(loc => getSpacePosition(zoneToSpace(loc, playerIndex))).filter(Boolean);
  const toPos = getSpacePosition(zoneToSpace(to, playerIndex));
  if (waypoints.length === 0 && toPos) waypoints.push(toPos);

  // The attacker's sound plays when it ARRIVES (tween end): bonk if it bumped,
  // else the home chime. (A move can't both bump and enter home.)
  const sound = bumped ? 'bonk' : (chime ? 'chime' : null);

  if (fromPos && waypoints.length > 0) {
    enqueueTween({ playerIndex, marbleId, fromPos, waypoints, sound });
  } else {
    // No animatable path (e.g. exiting base): just play the sound and render.
    if (sound === 'bonk') playBonk();
    else if (sound === 'chime') playHomeChime();
    drawBoard(gameState);
  }

  // After the attacker, send each bumped marble flying home.
  for (const v of victims) {
    const basePos = getBasePosition(v.ownerIndex, v.marbleId);
    if (v.fromPos && basePos) {
      enqueueTween({ playerIndex: v.ownerIndex, marbleId: v.marbleId,
                     fromPos: v.fromPos, waypoints: [basePos], sound: null });
    } else {
      clearMarbleOverride(v.ownerIndex, v.marbleId); // nowhere to fly from — just clear
    }
  }
  if (!animationRunning) drawBoard(gameState);
});

on('marbleBumped', ({ ownerIndex, marbleId, from }) => {
  const marble = gameState.players[ownerIndex].marbles[marbleId];

  // Capture the pre-bump position so the marble lingers there (via override)
  // until the attacker arrives and its fly-home tween takes over.
  const fromPos = getSpacePosition(zoneToSpace(from, ownerIndex));

  marble.zone = 'base';
  marble.space = null;
  marble.slot = null;
  marble.starEligible = false;

  // Cancel any queued tween for this marble — it's going home now
  const idx = animationQueue.findIndex(a => a.playerIndex === ownerIndex && a.marbleId === marbleId);
  if (idx !== -1) animationQueue.splice(idx, 1);

  if (fromPos) setMarbleOverride(ownerIndex, marbleId, fromPos);
  else         clearMarbleOverride(ownerIndex, marbleId);
  bumpHandoff.push({ ownerIndex, marbleId, fromPos, loc: from });
});

on('turnChanged', ({ playerIndex }) => {
  flushTurnLog();
  turnNumber++;
  gameState.turnIndex = playerIndex;
  gameState.phase = 'IN_TURN';
  gameState.dice = null;
  gameState.diceUsed = [false, false];
  legalMovesCache = null;
  selectedDie = null;
  selectedMarble = null;
  selectedMarbleMoves = [];
  commitPending = false;
  turnLogPlayer = null;
  setCommitVisible(false); setUndoVisible(false);
  updateSkipButton();
  setHint('');
  renderSidebar();
  renderDice(null, gameState.players[playerIndex]?.color);
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
  updateSkipButton();
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
  updateSkipButton();
});

on('undone', ({ gameState: gs }) => {
  gameState = gs;
  selectedMarble = null;
  selectedMarbleMoves = [];
  commitPending = false;
  // Clear any in-flight animations and overrides — server state is authoritative
  resetAnimations();
  // Undo reverts exactly one move (LIFO), so drop only that move from the log.
  popLastLoggedMove();
  setCommitVisible(false); setUndoVisible(false);
  renderDice(gameState.dice);
  drawBoard(gameState);
  if (isMyTurn()) setHint('Undone. Click a marble to make your moves.');
  updateSkipButton();
});

on('gameOver', ({ winnerIndex }) => {
  flushTurnLog();
  turnLogPlayer = null;
  gameState.phase = 'GAME_OVER';
  const name = playerName(winnerIndex);
  $('winner-msg').textContent = `${name} wins! 🎉`;
  $('btn-analyze').style.display = settings.analysis ? '' : 'none';
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
  legalMovesCache = null;
  selectedMarble = null;
  selectedMarbleMoves = [];
  resetAnimations();
  renderSidebar();
  renderDice(gameState.dice, gameState.players[gameState.turnIndex]?.color);
  // Restore the controls for whatever point of the turn we came back to. The
  // server follows up with legalMoves (mid-roll) or readyToCommit as needed.
  const canRoll = isMyTurn() && !gameState.dice
    && (gameState.phase === 'IN_TURN' || gameState.phase === 'EXTRA_ROLL');
  if (canRoll) enableRoll(); else $('btn-roll').disabled = true;
  updateSkipButton();
  drawBoard(gameState);
});

on('hostChanged', ({ playerIndex }) => {
  if (playerIndex !== myPlayerIndex) return;
  // The previous host left the lobby; this player can now add robots and start.
  $('host-controls').style.display = 'flex';
  $('lobby-wait-msg').style.display = 'none';
  // Re-render so robot slots get their remove buttons.
  const slots = [...document.querySelectorAll('#lobby-slots li')].map(li => {
    const text = li.querySelector('.slot-name').textContent;
    return {
      index: Number(li.id.replace('slot-', '')),
      name: text.replace(/ 🤖$/, ''),
      color: li.dataset.color,
      isRobot: text.endsWith('🤖'),
      filled: text !== '(empty)',
    };
  });
  renderLobbySlots(slots);
  updateStartButton();
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
  const dice = selectedDie !== null ? [selectedDie] : [0, 1];
  for (const i of dice) {
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
  selectedDie = null;
}

// ---- Marble animation ----

const animationQueue = [];
let   animationRunning = false;

// Stimulus-response animation: each tween is a self-contained
//   { playerIndex, marbleId, fromPos, waypoints, sound }
// processed serially. Invariant: a marble's override exists ONLY while its tween
// is running and is ALWAYS cleared when the tween ends — so nothing is ever left
// stranded on the board. `sound` ('bonk' | 'chime' | null) plays at the tween's
// end, so it lands exactly when the marble arrives.
function enqueueTween(tween) {
  if (!tween.waypoints || tween.waypoints.length === 0) return;
  animationQueue.push(tween);
  pinQueuedMarbles();
  if (!animationRunning) runNextAnimation();
}

// The marble whose tween is currently playing (its override is set per frame).
let runningMarble = null;

// Game state jumps to a marble's final position as soon as the server's event
// arrives, but its tween may be waiting behind others (e.g. a robot's extra-
// roll chain sends moves faster than they animate). Pin every marble that has
// a queued tween at the start of its FIRST queued tween, so it waits visibly
// where it is instead of appearing at the end, then snapping back when its
// tween starts. Covers a marble whose second move is still queued after its
// first finished.
function pinQueuedMarbles() {
  const seen = new Set();
  for (const tw of animationQueue) {
    const key = `${tw.playerIndex}:${tw.marbleId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (runningMarble && runningMarble.playerIndex === tw.playerIndex
        && runningMarble.marbleId === tw.marbleId) continue;
    setMarbleOverride(tw.playerIndex, tw.marbleId, tw.fromPos);
  }
}

// Bumped by resetAnimations(). A running tween checks it on every frame and
// stops if it changed, so an undo / reconnect / new game mid-animation can't
// leave an old tween drawing a marble in a stale place or running a second
// queue-drain loop alongside a new one.
let animationGen = 0;

function resetAnimations() {
  animationGen++;
  animationQueue.length = 0;
  animationRunning = false;
  runningMarble = null;
  bumpHandoff = [];
  lastAnimEnd = null;
  clearAnimatingMarble();
  clearAllMarbleOverrides();
}

function runNextAnimation() {
  if (animationQueue.length === 0) {
    animationRunning = false;
    runningMarble = null;
    lastAnimEnd = null;
    return;
  }
  animationRunning = true;
  const gen = animationGen;
  const stale = () => gen !== animationGen;
  const { playerIndex, marbleId, fromPos, waypoints, sound } = animationQueue.shift();
  runningMarble = { playerIndex, marbleId };

  // Normal pace, or faster when moves are piling up behind this one, so the
  // board doesn't fall far behind the server (and the log) on long turns.
  const behind   = animationQueue.length >= 2;
  const STEP_MS  = behind ? 110 : 200; // per-waypoint duration
  const PAUSE_MS = behind ? 180 : 350; // beat between two consecutive moves of the same marble

  // Pause a beat when the same marble moves again (both dice on one marble) so a
  // bonk/landing on the prior move is legible before it sets off again.
  const samePrev = lastAnimEnd
    && lastAnimEnd.playerIndex === playerIndex
    && lastAnimEnd.marbleId === marbleId;

  let step = 0;
  let prevPos = fromPos;

  setAnimatingMarble(playerIndex, marbleId);
  // Pin at the start position so the marble doesn't flash at its (already-updated)
  // destination during the pause or before the first frame.
  setMarbleOverride(playerIndex, marbleId, fromPos);
  if (samePrev) drawBoard(gameState);

  function finish() {
    clearMarbleOverride(playerIndex, marbleId);
    clearAnimatingMarble();
    runningMarble = null;
    lastAnimEnd = { playerIndex, marbleId };
    if (sound === 'bonk') playBonk();
    else if (sound === 'chime') playHomeChime();
    // Re-pin anything still waiting — including this marble, if it has another
    // move queued — before drawing, so nothing shows at its final position early.
    pinQueuedMarbles();
    drawBoard(gameState);
    runNextAnimation();
  }

  function animateToNext() {
    if (stale()) return;
    if (step >= waypoints.length) { finish(); return; }
    const targetPos = waypoints[step++];
    const startPos  = prevPos;
    const start     = performance.now();

    function frame(now) {
      if (stale()) return;
      const t    = Math.min((now - start) / STEP_MS, 1);
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

  if (samePrev) setTimeout(animateToNext, PAUSE_MS);
  else animateToNext();
}

// ---- Backgammon-style notation helpers ----

// Convert a zone-descriptor { zone, space?, slot? } to a notation string.
function locNotation(loc) {
  if (!loc) return '?';
  if (loc.zone === 'base')   return 'base';
  if (loc.zone === 'center') return 'hub';
  if (loc.zone === 'home')   return `h${loc.slot}`;
  if (loc.zone === 'track')  return spaceName(loc.space);   // e.g. B3, B★, W−2
  return '?';
}

// Remove the most recent move from this turn's notation (used by undo).
// Consecutive moves of one marble share an entry ("4/9/12"), so dropping the
// last move either shortens that path or removes the entry.
function popLastLoggedMove() {
  const last = turnLogMoves[turnLogMoves.length - 1];
  if (!last) return;
  if (last.path.length > 2) last.path.pop();
  else turnLogMoves.pop();
}

// Emit accumulated moves for the current turn as a single numbered log line.
function flushTurnLog() {
  if (!turnLogDice) return;
  const pi      = turnLogPlayer ?? gameState?.turnIndex;
  const name    = playerName(pi);
  const color   = gameState?.players[pi]?.color ?? null;
  const diceStr = `${turnLogDice[0]}-${turnLogDice[1]}`;
  const movesStr = turnLogMoves.length
    ? turnLogMoves.map(m => m.path.join('/')).join(' ')
    : '--';
  log(`${turnNumber}. ${name}: ${diceStr}: ${movesStr}`, color);
  // Feedback lines start with "↳", so tools/replay.mjs ignores them in a copied log.
  if (pendingFeedback && pi === myPlayerIndex) log(`↳ ${pendingFeedback.text}`, null, `log-feedback ${pendingFeedback.cls}`);
  pendingFeedback = null;
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
    li.dataset.color = slot.color;
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

function renderDice(dice, color) {
  for (let i = 0; i < 2; i++) {
    const el = $(`die-${i}`);
    el.textContent = dice ? dice[i] : '–';
    el.classList.toggle('used', !!(gameState?.diceUsed?.[i]));
    el.classList.toggle('selected-die', selectedDie === i);
    if (color !== undefined) el.style.setProperty('--die-color', color ? COLOR_MAP[color] ?? '' : '');
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

// Keep the entire game history visible. The ceiling is just a safety guard
// against pathological unbounded DOM growth, not a normal-game limit.
const LOG_MAX = 5000;
function log(msg, color, cls) {
  const el = $('game-log');
  const entry = document.createElement('div');
  entry.className = 'log-entry' + (cls ? ' ' + cls : '');
  if (color) {
    const dot = document.createElement('span');
    dot.className = 'log-dot';
    dot.style.background = COLOR_MAP[color] ?? '#888';
    entry.appendChild(dot);
  }
  entry.appendChild(document.createTextNode(msg));
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
