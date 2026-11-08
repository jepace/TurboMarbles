// GameManager.js — room registry, session tracking, disconnect timers

import { randomBytes } from 'crypto';
import {
  createGame, rollDice, allLegalMoves, applyMove,
  earnsExtraRoll, nextTurn, startExtraRoll, PLAYER_CONFIG, ARM_MAP,
  MARBLES_PER_PLAYER, canDouble, offerDouble, takeDouble, dropDouble, twoDiceTargets, gameResult,
} from './GameEngine.js';
import { exactEstimate, shouldDouble, shouldTake } from './CubeDecision.js';
import { recordGame, saveAnalysis, storeEnabled } from './Store.js';
import { analyzeCube } from './CubeAnalysis.js';
import { pickNextRobotMove } from './RobotPlayer.js';
import { think } from './RobotThinker.js';
import { worthThinking } from './RobotRollout.js';
import { isDuel } from './DuelTable.js';
import { Worker } from 'worker_threads';
import { moveFeedback, describeRoll } from './Analysis.js';
import { availableParallelism } from 'os';

const DISCONNECT_TIMEOUT_MS  = 30 * 60 * 1000; // 30 minutes
const ROBOT_TURN_DELAY_MS    = 800;            // pause before robot's turn starts
const ROBOT_MOVE_DELAY_MS    = 600;            // pause between robot's individual moves
const MAX_TOTAL_ROOMS        = 200;            // global cap — prevents memory exhaustion
const MAX_ROOMS_PER_WS       = 3;             // per-connection cap
const LOBBY_TTL_MS           = 2 * 60 * 60 * 1000; // unstarted lobbies expire after 2 h
const ILLEGAL_LOG_INTERVAL_MS = 10_000;        // at most one illegal-move warning per socket per 10 s
const MAX_ANALYSES          = 1;              // post-game analyses running at once (CPU-heavy)
const MAX_RECORDED_ROLLS    = 400;            // per game (all players), for post-game analysis
export const config = {
  skipTurnDelayMs: 1500,  // show dice before auto-advancing a skipped turn
  initialTurnIndex: null, // null = random; set to 0 in tests to pin first player
  // Post-game analysis: playouts per option to screen all options, playouts
  // for the top `keep` options (plus the one played and the robot's) in depth,
  // and up to maxDeep for a loss that is still unclear.
  // The whole-game pass uses the instant evaluator; "Go deeper" on one
  // decision then plays it out at levels 1, 2, 3 (each replaces the last).
  analysis: { mode: 'eval', keep: 3 },
  analysisLevels: [
    { mode: 'eval', keep: 3 },                             // 0: instant (1-ply estimate)
    { screenBy: 'eval', deep: 150, keep: 3, maxDeep: 300 },// 1: checked — the best few by the estimate, yours and the robot's, played out
    { screen: 60, deep: 400, keep: 4, maxDeep: 1600 },     // 2: deep
    { screen: 120, deep: 1200, keep: 5, maxDeep: 4800 },   // 3: deepest
  ],
  analysisWorkers: 4,     // worker threads per analysis (capped at CPUs − 1)
  cubeAnalysisGames: 400, // played-out games per cube decision (when no exact table applies)
  cubeLevels: [400, 1600, 6400],   // games per cube decision: first pass, then 'Go deeper'
  // Late in the game the robot plays its options out in a background thread
  // before moving. The game never waits longer than this (ms); 0 turns it off.
  robotThinkMs: 1500,
};

const rooms = new Map();    // roomId → Room
const sessions = new Map(); // wsId → { roomId, playerIndex }

export const ROOM_CODE_LENGTH = 6;

function genCode() {
  // 32 unambiguous chars (no I/O/0/1), crypto PRNG. 256 % 32 === 0, so no bias.
  // 6 chars ≈ 1.07 billion codes — scanning for live lobbies isn't practical.
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(ROOM_CODE_LENGTH);
  return Array.from(bytes, b => chars[b % chars.length]).join('');
}

function genId() {
  // 128-bit token — unguessable even with knowledge of other tokens.
  return randomBytes(16).toString('hex');
}

// ---------- Room structure ----------
// {
//   id, code, hostIndex,
//   slots: [{ index, playerId|null, name, color, isRobot, ws|null }],
//   totalPlayers, createdAt,
//   state: 'lobby' | 'playing' | 'finished',
//   game: GameEngine state | null,
//   disconnectTimers: Map<playerIndex, timer>,  // human reconnect grace timers
//   robotTurnTimer: TimeoutId | null,           // pending robot turn-start or move timer
//   skipTimer: TimeoutId | null,                // pending auto-advance of a skipped turn
// }
//
// A socket is in at most one room at a time: createRoom / joinRoom first leave
// the socket's current room. (Previously a socket could create several rooms
// but was only tracked in the last, so the others leaked forever.)

export function createRoom(hostWs, hostName, totalPlayers, hostColor, { cube = false } = {}) {
  if (sessions.has(hostWs._id)) leaveRoom(hostWs);
  sweepStaleLobbies();
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
    accountId: i === 0 ? (hostWs._player?.id ?? null) : null,   // signed-in player's id (stats)
  }));

  const room = {
    id: roomId, code, hostIndex: 0,
    slots, totalPlayers,
    createdAt: Date.now(),
    state: 'lobby',
    game: null,
    disconnectTimers: new Map(),
    robotTurnTimer: null,
    skipTimer: null,
    analysis: null,     // post-game analysis: null | { state: 'running', waiting: Set<ws> } | { state: 'done', result }
    cube: !!cube && totalPlayers === 2,   // doubling cube (money play), two players only
    score: Array(totalPlayers).fill(0),   // money-session points across rematches (cube rooms)
    wins: Array(totalPlayers).fill(0),    // games won in this room
    gamesPlayed: 0,
  };
  rooms.set(roomId, room);

  // Return the hostId as reconnectToken so the host can authenticate reconnects.
  // The client must store this and send it back in any 'reconnect' action.
  return { roomId, code, reconnectToken: hostId, color: slots[0].color, totalPlayers, cube: room.cube,
    slots: slots.map(s => ({ index: s.index, name: s.name, color: s.color, isRobot: s.isRobot, filled: !!s.playerId })) };
}

export function joinRoom(ws, code, playerName) {
  const room = [...rooms.values()].find(r => r.code === code && r.state === 'lobby');
  if (!room) return { error: 'Room not found or already started' };

  // Leave any current room first (joining the same lobby twice from one socket
  // used to take a second seat that was never freed).
  if (sessions.has(ws._id)) leaveRoom(ws);
  if (!rooms.has(room.id)) return { error: 'Room not found or already started' };

  // Any empty human seat, including slot 0 if a departed host left it empty.
  const slot = room.slots.find(s => !s.isRobot && !s.playerId);
  if (!slot) return { error: 'Room is full' };

  const playerId = genId();
  slot.playerId = playerId;
  slot.name = playerName;
  slot.ws = ws;
  slot.accountId = ws._player?.id ?? null;
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

// Robot names: 10 female, 10 male, picked at random when a robot is added.
export const ROBOT_NAMES = [
  'Alice', 'Beatrice', 'Clara', 'Daisy', 'Eleanor', 'Fiona', 'Grace', 'Hazel', 'Ivy', 'Maggie',
  'Arthur', 'Benny', 'Charlie', 'Dexter', 'Felix', 'Gus', 'Hank', 'Oscar', 'Reggie', 'Walter',
];

export function addRobot(ws, roomId) {
  const room = rooms.get(roomId);
  if (!room || room.state !== 'lobby') return { error: 'Invalid room' };
  if (!isHost(ws, room)) return { error: 'Only host can add robots' };

  const slot = room.slots.find(s => !s.playerId && !s.isRobot);
  if (!slot) return { error: 'No empty slots' };

  // A random name nobody in the room is using (robots still show 🤖).
  const taken = new Set(room.slots.map(s => s.name?.toLowerCase()).filter(Boolean));
  const free = ROBOT_NAMES.filter(n => !taken.has(n.toLowerCase()));
  slot.isRobot = true;
  slot.name = free.length ? free[Math.floor(Math.random() * free.length)] : `Robot ${slot.index + 1}`;
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

  beginGame(room, players);
  return { ok: true };
}

function beginGame(room, players) {
  room.game = createGame(players, room.slots.map(s => s.armIndex), config.initialTurnIndex, { cube: room.cube });
  room.state = 'playing';
  room.analysis = null;
  room.robotPlan = null;
  broadcast(room, { event: 'gameStarted', gameState: publicState(room) });
  scheduleCurrentTurn(room);
}

// After a finished game, the next game of the session starts in the same room
// (same seats; robots stay robots; the money score carries over) once every
// human player has asked for it. Robots always agree.
export function handleRematch(ws, roomId) {
  const room = rooms.get(roomId);
  if (!room || room.state !== 'finished') return { error: 'No finished game' };
  const sess = sessions.get(ws._id);
  if (!sess || sess.roomId !== roomId) return { error: 'Not in this room' };
  room.rematchVotes ??= new Set();
  room.rematchVotes.add(sess.playerIndex);
  const humans = room.slots.filter(s => !s.isRobot && s.playerId).map(s => s.index);
  const waitingFor = humans.filter(i => !room.rematchVotes.has(i));
  if (waitingFor.length) {
    broadcast(room, { event: 'rematchRequested', playerIndex: sess.playerIndex,
      agreed: [...room.rematchVotes], waitingFor });
    return { ok: true, waiting: true };
  }
  room.rematchVotes = null;
  if (room.robotTurnTimer) { clearTimeout(room.robotTurnTimer); room.robotTurnTimer = null; }
  beginGame(room, room.slots.map(s => ({ id: s.playerId, name: s.name, color: s.color, isRobot: s.isRobot })));
  return { ok: true };
}

// ---------- Game over and the money score ----------

// Called once when a game ends: credit the money score (cube games) and tell
// everyone the result.
function finishGame(room) {
  const { game } = room;
  room.state = 'finished';
  if (game._finished) return;
  game._finished = true;
  room.rematchVotes = null;
  room.gamesPlayed++;
  if (game.winner != null) room.wins[game.winner]++;
  // Two-player rooms keep a money score: a win is 1 point (2 for an aggro),
  // times the cube's value when playing with the cube.
  const r = game.result ?? (room.totalPlayers === 2 && game.winner != null ? gameResult(game, game.winner) : null);
  if (r) {
    room.score[r.winner] += r.points;
    room.score.forEach((_, i) => { if (i !== r.winner) room.score[i] -= r.points; });
  }
  storeFinishedGame(room, r);
  broadcast(room, { event: 'gameResult', winnerIndex: game.winner, result: r,
    score: room.totalPlayers === 2 ? room.score.slice() : null, wins: room.wins.slice(), gamesPlayed: room.gamesPlayed });
}

// ---------- Stats: store finished games and their analyses ----------

// Store the finished game if a signed-in player took part. Games against
// robots are flagged by the store (robot seats with no account).
function storeFinishedGame(room, r) {
  if (!storeEnabled() || !room.slots.some(s => s.accountId)) return;
  const { game } = room;
  try {
    finishRollRecord(game);
    const two = room.totalPlayers === 2;
    room.storedGameId = recordGame({
      cube: !!game.cube, winnerSeat: game.winner,
      rolls: game._rolls ?? [],
      seats: room.slots.map((s, i) => {
        const c = game._cubeStats?.[i] ?? {};
        const won = game.winner === i;
        return {
          playerId: s.accountId ?? null, name: s.name ?? `Player ${i + 1}`, color: s.color,
          isRobot: !!s.isRobot && !s.accountId, won,
          points: two && r ? (won ? r.points : -r.points) : 0, aggro: !!r?.aggro,
          doubles: c.doubles, takes: c.takes, drops: c.drops,
        };
      }),
    });
  } catch (err) {
    console.error('[store] could not record game', err);
  }
}

// Per-seat numbers from an analysis report (clear errors only, as on the page).
function seatAnalysis(report) {
  return report.players.map((_, pi) => {
    const mine = report.rolls.filter(x => x.pi === pi && x.analysis);
    const bad = mine.filter(x => x.analysis.severity !== 'ok');
    return { choices: mine.length, errors: bad.filter(x => x.analysis.severity === 'error').length,
      blunders: bad.filter(x => x.analysis.severity === 'blunder').length,
      eqLost: bad.reduce((sum, x) => sum + x.analysis.loss, 0),
      ...cubeSeat(report, pi) };
  });
}
function cubeSeat(report, pi) {
  const mine = (report.cube ?? []).filter(c => c.pi === pi && c.analysis && !c.analysis.skip);
  const bad = mine.filter(c => c.analysis.severity !== 'ok');
  return { cubeDecisions: mine.length, cubeErrors: bad.filter(c => c.analysis.severity === 'error').length,
    cubeBlunders: bad.filter(c => c.analysis.severity === 'blunder').length,
    cubeEqLost: bad.reduce((sum, c) => sum + c.analysis.loss, 0) };
}
function saveRoomAnalysis(room, report) {
  if (!room.storedGameId || !storeEnabled()) return;
  try { saveAnalysis(room.storedGameId, report, seatAnalysis(report)); } catch (err) { console.error('[store] could not save analysis', err); }
}

// A stored game, for replay: its saved analysis, or a plain report built
// from its roll records.
export function storedGameReport(g) {
  if (g.report) return g.report;
  const rolls = g.rolls ?? [];
  return {
    players: g.seats.map(s => ({ name: s.name, color: s.color, isRobot: s.isRobot })),
    winner: g.winnerSeat,
    rolls: rolls.map(({ turn, pi, dice, forced, played, options, before, steps }) =>
      ({ turn, pi, dice, forced, played, options, steps, marbles: before ? before.players.map(p => p.marbles) : null })),
  };
}

// ---------- Cube decisions: recording and feedback ----------

// The position at the start of a turn, with the cube as it stands.
function cubeSnapshot(game) {
  return { ...snapshot(game), phase: 'IN_TURN', dice: null, diceUsed: [false, false], cube: structuredClone(game.cube) };
}

// Keep a cube decision for the post-game analysis, and give a human the
// robot's view of it (in-game feedback; the client shows it if move feedback
// is on). A no-double is only commented on when the robot would have doubled.
function recordCube(room, entry) {
  const { game } = room;
  game._cubeLog ??= [];
  if (game._cubeLog.length >= 400) return;
  const rollIdx = (game._rolls?.length ?? 0) + (game._pendingRoll ? 1 : 0);
  game._cubeLog.push({ ...entry, turn: game._turnNo ?? 1, rollIdx });
  const slot = room.slots[entry.pi];
  if (!slot || slot.isRobot || !slot.ws) return;
  const d = entry.kind === 'double' ? entry.pi : entry.doubler;
  // A double to a robot: the robot works out the same chances to answer it,
  // so the feedback waits for that (one estimate, and the robot's thinking
  // thread stays free for its own decision).
  if (entry.kind === 'double' && entry.action && room.slots[1 - entry.pi]?.isRobot) { game._feedbackWait = entry; return; }
  cubeEstimate(entry.state, d).then(est => { if (est) sendCubeFeedback(slot.ws, entry, est); }).catch(() => {});
}

// est: chances from the doubler's side.
function sendCubeFeedback(ws, entry, est) {
  {
    const d = entry.kind === 'double' ? entry.pi : entry.doubler;
    const owner = entry.state.cube.owner == null ? 'centre' : entry.state.cube.owner === d ? 'me' : 'opp';
    const sd = shouldDouble(est, owner);
    const v = entry.state.cube.value;
    const f = x => (v * x).toFixed(2);
    let agrees, text;
    if (entry.kind === 'double') {
      agrees = sd.double === entry.action;
      if (agrees && !entry.action) return;              // a quiet no-double: nothing to say
      text = agrees ? '✓ Robot agrees: double'
        : (entry.action ? 'Robot would not double' : 'Robot would have doubled here')
          + ` (no double ${f(sd.nd)} · double/take ${f(sd.dt)} · double/drop ${f(sd.dp)})`;
    } else {
      const takeEq = -sd.dt, dropEq = -sd.dp;
      const shouldTakeIt = takeEq > dropEq;
      agrees = shouldTakeIt === entry.action;
      text = agrees ? `✓ Robot agrees: ${entry.action ? 'take' : 'drop'}`
        : `Robot would ${shouldTakeIt ? 'take' : 'drop'} (take ${f(takeEq)} · drop ${f(dropEq)})`;
    }
    sendTo(ws, { event: 'cubeFeedback', playerIndex: entry.pi, kind: entry.kind, agrees, text, exact: !!est.exact });
  }
}

// ---------- Doubling cube ----------

const cubeStat = (game, pi) => ((game._cubeStats ??= {})[pi] ??= { doubles: 0, takes: 0, drops: 0 });
const cubeOwnerFor = (game, pi) => game.cube.owner == null ? 'centre' : game.cube.owner === pi ? 'me' : 'opp';

// Chances for player pi from the start of the current turn: exact when a duel
// table applies, else played out in the robot's thinking thread (bounded by
// config.robotThinkMs). Null when there is no estimate in time.
async function cubeEstimate(game, pi) {
  const exact = exactEstimate(game, pi);
  if (exact) return exact;
  if (!(config.robotThinkMs > 0)) return null;
  return think(snapshot(game), pi, config.robotThinkMs, 'cube');
}

export function handleDouble(ws, roomId) {
  const room = rooms.get(roomId);
  if (!room || room.state !== 'playing') return;
  const sess = sessions.get(ws._id);
  if (!sess || sess.playerIndex !== room.game.turnIndex) return;
  doubleFor(room, sess.playerIndex);
}

function doubleFor(room, pi) {
  const { game } = room;
  const before = cubeSnapshot(game);
  if (!offerDouble(game, pi)) return false;
  game._offerSnap = before;
  recordCube(room, { kind: 'double', pi, action: true, state: before });
  cubeStat(game, pi).doubles++;
  broadcast(room, { event: 'doubleOffered', playerIndex: pi, value: game.cubeOffer.value });
  const to = game.cubeOffer.to;
  if (room.slots[to]?.isRobot) robotAnswerDouble(room);
  return true;
}

export function handleTake(ws, roomId) {
  const room = rooms.get(roomId);
  if (!room || room.state !== 'playing') return;
  const sess = sessions.get(ws._id);
  if (!sess) return;
  answerDouble(room, sess.playerIndex, true);
}

export function handleDrop(ws, roomId) {
  const room = rooms.get(roomId);
  if (!room || room.state !== 'playing') return;
  const sess = sessions.get(ws._id);
  if (!sess) return;
  answerDouble(room, sess.playerIndex, false);
}

function answerDouble(room, pi, take) {
  const { game } = room;
  const offer = game.cubeOffer;
  if (offer && offer.to === pi && game._offerSnap) {
    recordCube(room, { kind: 'take', pi, action: !!take, doubler: offer.from, state: game._offerSnap });
  }
  if (take) {
    if (!takeDouble(game, pi)) return;
    cubeStat(game, pi).takes++;
    broadcast(room, { event: 'doubleTaken', playerIndex: pi, value: game.cube.value, owner: pi });
    scheduleCurrentTurn(room);         // the doubler (robot) rolls; a human doubler rolls themselves
  } else {
    if (!dropDouble(game, pi)) return;
    cubeStat(game, pi).drops++;
    broadcast(room, { event: 'doubleDropped', playerIndex: pi, winnerIndex: game.winner, result: game.result });
    finishGame(room);
  }
}

// A robot being doubled: take or drop after thinking (fallback: take).
function robotAnswerDouble(room) {
  const { game } = room;
  const offer = game.cubeOffer;
  if (!offer) return;
  const pi = offer.to;
  const started = Date.now();
  cubeEstimate(game, pi).then(est => {
    // Feedback for the human who doubled, from the same estimate.
    const fw = game._feedbackWait;
    if (fw && est && fw.pi === offer.from) {
      game._feedbackWait = null;
      const w = room.slots[fw.pi]?.ws;
      if (w) sendCubeFeedback(w, fw, { ...est, p: 1 - est.p, aggroWin: est.aggroLoss, aggroLoss: est.aggroWin });
    }
    const wait = Math.max(0, ROBOT_TURN_DELAY_MS - (Date.now() - started));
    room.robotTurnTimer = setTimeout(() => {
      room.robotTurnTimer = null;
      if (!rooms.has(room.id) || game.cubeOffer !== offer || !room.slots[pi]?.isRobot) return;
      answerDouble(room, pi, est ? shouldTake(est).take : true);
    }, wait);
  }).catch(() => answerDouble(room, pi, true));
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
  game._undoStack = []; // per-move snapshots for undo; reset on each roll
  finishRollRecord(game);
  game._afterRoll = snapshot(game); // position + dice, for move feedback and analysis
  game._rolls ??= [];
  if (game._rolls.length < MAX_RECORDED_ROLLS) {
    game._pendingRoll = { turn: game._turnNo ?? 1, pi: game.turnIndex, dice: dice.slice(), before: game._afterRoll };
  }
  return dice;
}

// Every roll of the game, kept for the post-game report: the position after
// the roll and after it was played. A roll is completed when the next roll
// happens (or the game ends), so undo and skipped dice need no special care.
function finishRollRecord(game) {
  const r = game._pendingRoll;
  if (!r) return;
  game._pendingRoll = null;
  const after = snapshot(game);
  let info;
  try { info = describeRoll(r.before, after, r.pi); } catch (err) {
    console.error('[analysis] could not record roll', err);
    return;
  }
  game._rolls.push(info.forced ? { ...r, ...info } : { ...r, ...info, after });
}

// The parts of a game the rules engine needs — no private bookkeeping fields.
function snapshot(game) {
  return structuredClone({
    players: game.players, turnIndex: game.turnIndex, phase: game.phase,
    dice: game.dice, diceUsed: game.diceUsed, winner: game.winner,
  });
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

  // Rolling at the start of a turn with the cube available = choosing not to double.
  if (canDouble(game, game.turnIndex)) recordCube(room, { kind: 'double', pi: game.turnIndex, action: false, state: cubeSnapshot(game) });

  const dice = performRoll(game);
  // Compute legal moves and include in the event so clients can highlight destinations.
  const moves = allLegalMoves(game, game.turnIndex);
  broadcast(room, { event: 'rolled', playerIndex: game.turnIndex, dice, moves, combos: twoDiceTargets(game, game.turnIndex) });
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
    // Throttled and truncated: clients control this content and rate.
    const now = Date.now();
    if (!ws._lastIllegalLog || now - ws._lastIllegalLog > ILLEGAL_LOG_INTERVAL_MS) {
      ws._lastIllegalLog = now;
      let detail;
      try { detail = JSON.stringify(move); } catch { detail = '(unserializable)'; }
      console.warn(`[game] illegal move room=${room.code} player=${sess.playerIndex} move=${String(detail).slice(0, 200)} error=${result.error}`);
    }
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
  // Already used or forfeited (e.g. a second forfeit during the skipped-turn
  // delay, which used to schedule a second turn advance).
  if (game.diceUsed[idx]) return;

  // A die may be forfeited only when it has no mandatory move AND the other
  // die (if still unused) has none either — playing the other die first could
  // open up a mandatory move for this one. Same rule as the auto-forfeit in
  // advanceTurnIfDone. Optional moves (pass home and go around) never count.
  const legal = allLegalMoves(game, game.turnIndex);
  const hasMandatory = i => !game.diceUsed[i] && (legal[i] ?? []).some(m => !m.optional);
  if (hasMandatory(idx) || hasMandatory(1 - idx)) {
    sendTo(ws, { event: 'error', code: 'ILLEGAL_FORFEIT', message: 'Mandatory moves exist' });
    return;
  }

  game.diceUsed[idx] = true;
  // Tell everyone the die was skipped so the client updates its dice state and
  // re-evaluates the Skip button for the other die (otherwise the player can be
  // stuck unable to skip a second optional-only die).
  broadcast(room, { event: 'dieForfeit', dieIndex: idx });
  advanceTurnIfDone(room);
}

// ---------- Disconnect handling ----------

export function handleDisconnect(ws) {
  leaveRoom(ws);
}

// Detach a socket from its room: on socket close, or when the socket creates or
// joins another room.
function leaveRoom(ws) {
  const sess = sessions.get(ws._id);
  if (!sess) return;
  sessions.delete(ws._id);

  const room = rooms.get(sess.roomId);
  if (!room) return;

  const slot = room.slots[sess.playerIndex];
  if (!slot || slot.isRobot) return;
  // A reconnect may already have moved this seat to a newer socket; the old
  // socket's late close must not detach the player.
  if (slot.ws !== ws) return;
  slot.ws = null;

  if (room.state === 'lobby') {
    // Remove from lobby immediately — slot becomes available for another player
    slot.playerId = null;
    slot.name = null;
    slot.accountId = null;
    broadcast(room, { event: 'playerLeft', playerIndex: sess.playerIndex });
    if (cleanupIfAbandoned(room)) return; // delete the room if no humans remain
    // Hand the host role to another human still in the lobby, so the room
    // can still be started.
    if (sess.playerIndex === room.hostIndex) {
      const next = room.slots.find(s => s.ws && !s.isRobot);
      if (next) {
        room.hostIndex = next.index;
        broadcast(room, { event: 'hostChanged', playerIndex: next.index });
      }
    }
    return;
  }

  if (room.state === 'finished') {
    // A rematch can't happen without them: tell whoever is still there.
    broadcast(room, { event: 'opponentLeft', playerIndex: sess.playerIndex });
    // Nothing left to play; drop the room once nobody is looking at it.
    if (!room.slots.some(s => s.ws)) deleteRoom(room);
    return;
  }

  // In-game: give the player DISCONNECT_TIMEOUT_MS to reconnect before handing
  // their slot to a robot.
  broadcast(room, { event: 'playerDisconnected', playerIndex: sess.playerIndex, timeoutMs: DISCONNECT_TIMEOUT_MS });

  const timer = setTimeout(() => {
    if (!rooms.has(room.id)) return;
    room.disconnectTimers.delete(sess.playerIndex);
    slot.isRobot = true;
    broadcast(room, { event: 'robotTookOver', playerIndex: sess.playerIndex });

    // If this takeover leaves no humans in the game, nobody is watching — clean up.
    if (cleanupIfAbandoned(room)) return;

    // If it's currently this player's turn, schedule the robot to move.
    if (room.game && (room.game.turnIndex === sess.playerIndex || room.game.cubeOffer?.to === sess.playerIndex)) {
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

  // This socket may be sitting in some other room; leave it first.
  const existing = sessions.get(ws._id);
  if (existing && (existing.roomId !== roomId || existing.playerIndex !== pi)) leaveRoom(ws);

  // Cancel disconnect timer — the player made it back in time
  const timer = room.disconnectTimers.get(pi);
  if (timer) { clearTimeout(timer); room.disconnectTimers.delete(pi); }

  // If the old socket hasn't been noticed as closed yet (half-dead mobile
  // connection), retire it now: drop its session so its eventual close is a
  // no-op, and close it so it can't keep sending actions.
  const old = slot.ws;
  if (old && old !== ws) {
    sessions.delete(old._id);
    try { old.terminate?.(); } catch { /* already gone */ }
  }

  slot.ws = ws;
  sessions.set(ws._id, { roomId, playerIndex: pi });

  sendTo(ws, { event: 'reconnected', gameState: publicState(room) });
  // Re-send what the player needs to act if it's their turn mid-roll.
  const { game } = room;
  if (game.turnIndex === pi && game.phase === 'AWAITING_MOVE') {
    if (game.diceUsed[0] && game.diceUsed[1]) {
      if (game._humanMadeMove) sendTo(ws, { event: 'readyToCommit', playerIndex: pi });
    } else {
      sendTo(ws, { event: 'legalMoves', moves: allLegalMoves(game, pi), diceUsed: game.diceUsed, combos: twoDiceTargets(game, pi) });
    }
  }
  broadcast(room, { event: 'playerReconnected', playerIndex: pi }, ws);
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
  deleteRoom(room);
  return true;
}

// Remove a room and everything that could still act on it: every pending
// timer, and any sessions pointing at it.
function deleteRoom(room) {
  if (room.robotTurnTimer) { clearTimeout(room.robotTurnTimer); room.robotTurnTimer = null; }
  if (room.skipTimer)      { clearTimeout(room.skipTimer);      room.skipTimer = null; }
  for (const t of room.disconnectTimers.values()) clearTimeout(t);
  room.disconnectTimers.clear();
  for (const [wsId, s] of sessions) if (s.roomId === room.id) sessions.delete(wsId);
  rooms.delete(room.id);
}

// Lobbies nobody ever started expire, so idle-but-connected sockets can't hold
// room slots forever.
function sweepStaleLobbies(now = Date.now()) {
  for (const room of [...rooms.values()]) {
    if (room.state === 'lobby' && now - room.createdAt > LOBBY_TTL_MS) {
      broadcast(room, { event: 'error', code: 'ROOM_EXPIRED', message: 'This lobby expired. Please create a new game.' });
      deleteRoom(room);
    }
  }
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
    finishGame(room);
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
          if (room.skipTimer) clearTimeout(room.skipTimer);
          room.skipTimer = setTimeout(() => {
            room.skipTimer = null;
            if (rooms.has(room.id)) commitTurn(room);
          }, config.skipTurnDelayMs);
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
  // Runs at most once per roll. Several paths can reach here for the same
  // roll (explicit commit, skipped-turn timer, robot takeover); the first one
  // advances the turn and the rest are no-ops. Without this guard a second
  // call hit earnsExtraRoll(null) and crashed the process.
  if (game.phase !== 'AWAITING_MOVE' || !game.diceUsed[0] || !game.diceUsed[1]) return;
  if (room.skipTimer) { clearTimeout(room.skipTimer); room.skipTimer = null; }
  game._committed = true; // prevent undo from popping the stack after turn has advanced
  if (earnsExtraRoll(game.dice)) {
    startExtraRoll(game);
    broadcast(room, { event: 'extraRoll', playerIndex: game.turnIndex });
  } else {
    nextTurn(game);
    game._turnNo = (game._turnNo ?? 1) + 1;   // same numbering as the client's move log
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

  if (game.phase === 'CUBE_OFFERED') {
    if (room.slots[game.cubeOffer.to]?.isRobot) robotAnswerDouble(room);
    return;
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
  if (!rooms.has(room.id) || !game || game.phase === 'GAME_OVER') return;

  // At the start of its turn (not before an extra roll), a robot with access
  // to the cube decides whether to double first. Once per turn.
  const me = game.turnIndex;
  if (canDouble(game, me) && game._cubeChecked !== (game._turnNo ?? 1)) {
    game._cubeChecked = game._turnNo ?? 1;
    cubeEstimate(game, me).then(est => {
      if (!rooms.has(room.id) || room.game !== game || game.phase !== 'IN_TURN' || game.turnIndex !== me || !room.slots[me]?.isRobot) return;
      if (est && shouldDouble(est, cubeOwnerFor(game, me)).double && doubleFor(room, me)) return;
      recordCube(room, { kind: 'double', pi: me, action: false, state: cubeSnapshot(game) });
      doRobotTurn(room);
    }).catch(() => doRobotTurn(room));
    return;
  }

  // Roll using the shared helper (same logic path as a human roll)
  if (game.phase === 'IN_TURN' || game.phase === 'EXTRA_ROLL') {
    const dice = performRoll(game);
    broadcast(room, { event: 'rolled', playerIndex: game.turnIndex, dice });
  }
  room.robotPlan = null;

  // Late in the game: think first (bounded by config.robotThinkMs; on a late
  // or failed answer the robot just plays its normal move).
  const pi = game.turnIndex;
  if (config.robotThinkMs > 0 && game.phase === 'AWAITING_MOVE' && !isDuel(game) && worthThinking(game, pi)) {
    const rollId = game._afterRoll;
    think(snapshot(game), pi, config.robotThinkMs).then(result => {
      if (!rooms.has(room.id) || room.game !== game || game._afterRoll !== rollId || game.phase !== 'AWAITING_MOVE'
        || game.turnIndex !== pi || !room.slots[pi]?.isRobot) return;
      room.robotPlan = result?.changed ? result.moves.slice() : null;
      applyNextRobotMove(room);
    });
    return;
  }

  // Apply each robot move with a delay so clients can animate them sequentially.
  applyNextRobotMove(room);
}

// The next move of the robot's thought-out plan, if it is still legal.
function nextPlannedMove(room) {
  const plan = room.robotPlan;
  if (!plan?.length) return null;
  const mv = plan.shift();
  const legal = allLegalMoves(room.game, room.game.turnIndex)[mv.dieIndex] ?? [];
  const same = legal.find(m => JSON.stringify(m) === JSON.stringify(mv));
  if (!same) { room.robotPlan = null; return null; }
  return same;
}

function applyNextRobotMove(room) {
  const { game } = room;
  if (!game || game.phase === 'GAME_OVER') { finishGame(room); return; }
  if (game.diceUsed[0] && game.diceUsed[1]) { advanceTurnIfDone(room); return; }

  // Tracked in robotTurnTimer so deleting the room cancels the chain
  // (otherwise an abandoned room's robots kept playing to the end).
  room.robotTurnTimer = setTimeout(() => {
    room.robotTurnTimer = null;
    if (!rooms.has(room.id) || game.phase !== 'AWAITING_MOVE') return;
    const chosen = nextPlannedMove(room) ?? pickNextRobotMove(game, game.turnIndex);
    if (chosen) {
      const events = applyMove(game, game.turnIndex, chosen);
      events.forEach(ev => broadcast(room, ev));
    } else {
      const dieIdx = game.diceUsed[0] ? 1 : 0;
      game.diceUsed[dieIdx] = true;
      broadcast(room, { event: 'dieForfeit', dieIndex: dieIdx });
    }
    applyNextRobotMove(room);
  }, ROBOT_MOVE_DELAY_MS);
}

function isHost(ws, room) {
  return !!ws && room.slots[room.hostIndex]?.ws === ws;
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
    hostIndex: room.hostIndex,
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
    cube: game.cube,
    cubeOffer: game.cubeOffer,
    score: room.totalPlayers === 2 ? room.score.slice() : null,
    wins: room.wins.slice(),
    gamesPlayed: room.gamesPlayed,
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
  sendTo(ws, { event: 'legalMoves', moves: legalMoves, diceUsed: game.diceUsed, combos: twoDiceTargets(game, game.turnIndex) });
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

  recordDecision(room, ws);
  commitTurn(room);
}

// After a human commits a roll: tell them how the robot would have played it
// (the client shows it if the player has move feedback turned on), and keep
// the decision for post-game analysis. A roll with only one way to play is
// reported as forced and not kept.
function recordDecision(room, ws) {
  const { game } = room;
  if (!game._afterRoll) return;
  const pi = game.turnIndex;
  let fb;
  try { fb = moveFeedback(game._afterRoll, game, pi); } catch (err) {
    console.error('[analysis] move feedback failed', err);
    return;
  }
  sendTo(ws, { event: 'moveFeedback', playerIndex: pi, ...fb });
}

// ---------- Post-game analysis ----------

let analysesRunning = 0;

// A finished game's player asks for the post-game report. Every decision of
// every player is rolled out (in worker threads, so games keep running); the
// report is cached on the room and sent to everyone who asked.
export function handleAnalyzeGame(ws, roomId) {
  const room = rooms.get(roomId);
  if (!room || room.state !== 'finished' || !room.game) return;
  const sess = sessions.get(ws._id);
  if (!sess || sess.roomId !== roomId) return;

  const a = room.analysis;
  if (a?.state === 'done') { sendTo(ws, { event: 'analysisResult', report: a.result }); return; }
  if (a?.state === 'running') { a.waiting.add(ws); return; }

  const { game } = room;
  finishRollRecord(game);
  const rolls = game._rolls ?? [];
  const decisions = rolls.map((r, idx) => ({ r, idx })).filter(x => !x.r.forced);
  const base = {
    players: room.slots.map((s, i) => ({ name: s.name, color: game.players[i]?.color, isRobot: !!s.isRobot })),
    winner: game.winner,
    rolls: rolls.map(({ turn, pi, dice, forced, played, options, before, steps }) =>
      ({ turn, pi, dice, forced, played, options, steps, marbles: before ? before.players.map(p => p.marbles) : null })),
    // Cube decisions, worked out in the background (see autoCheck).
    cube: (game._cubeLog ?? []).map((c, i) => ({ i, turn: c.turn, pi: c.pi, kind: c.kind, action: c.action, doubler: c.doubler,
      rollIdx: c.rollIdx, v: c.state.cube?.value ?? 1, marbles: c.state.players.map(p => p.marbles), analysis: null, pending: true })),
  };
  const finish = report => {
    room.analysis = { state: 'done', result: report };
    saveRoomAnalysis(room, report);
    for (const w of waiting) sendTo(w, { event: 'analysisResult', report });
  };
  const waiting = new Set([ws]);
  if (!decisions.length) {
    finish(base);
    if (base.cube.length) { analysesRunning++; autoCheck(room, base, () => { analysesRunning--; }); }
    return;
  }
  if (analysesRunning >= MAX_ANALYSES) {
    sendTo(ws, { event: 'error', code: 'ANALYSIS_BUSY', message: 'The server is busy analysing another game. Try again in a minute.' });
    return;
  }
  analysesRunning++;
  room.analysis = { state: 'running', waiting };

  // Split the decisions over a few workers, interleaved so each gets a mix.
  const nWorkers = Math.max(1, Math.min(config.analysisWorkers ?? 4, availableParallelism() - 1, decisions.length));
  const chunks = Array.from({ length: nWorkers }, (_, w) => decisions.filter((_, k) => k % nWorkers === w));
  const results = new Map();
  let done = 0, live = nWorkers, failed = false;
  const end = () => { analysesRunning--; };
  const fail = err => {
    if (failed) return;
    failed = true;
    console.error('[analysis] worker failed', err);
    for (const w of workers) w.terminate();
    room.analysis = null;
    for (const w of waiting) sendTo(w, { event: 'error', code: 'ANALYSIS_FAILED', message: 'Analysis failed.' });
    end();
  };
  const workers = chunks.map(chunk => {
    const worker = new Worker(new URL('./analysisWorker.js', import.meta.url), {
      workerData: { decisions: chunk.map(({ r, idx }) => ({ idx, before: r.before, after: r.after, pi: r.pi })), options: { ...config.analysis, level: 0 } },
    });
    worker.on('message', msg => {
      if (failed) return;
      if (msg.type === 'item') {
        results.set(msg.idx, msg.item);
        done++;
        for (const w of waiting) sendTo(w, { event: 'analysisProgress', done, total: decisions.length });
      }
      if (msg.type === 'end' && --live === 0) {
        base.rolls.forEach((r, idx) => { if (results.has(idx)) r.analysis = results.get(idx); });
        finish(base);
        autoCheck(room, base, end);
      }
    });
    worker.on('error', fail);
    worker.on('exit', code => { if (code !== 0) fail(new Error(`worker exited ${code}`)); });
    return worker;
  });
}

// ---------- Automatic check of the questionable decisions ----------
//
// After the instant pass, every decision where the play differs from the
// robot's choice, or the estimate calls it an error, is played out at level 1
// in the background; each answer replaces the estimate as it arrives.
function autoCheck(room, report, end, { level = 1, all = false } = {}) {
  const opts = config.analysisLevels[level];
  // The automatic pass checks the questionable decisions (and the cube);
  // "play out all" (all = true) redoes every decision below `level`.
  const todo = report.rolls.map((r, idx) => ({ r, idx })).filter(({ r, idx }) =>
    r.analysis && !r._deepening && room.game?._rolls?.[idx]?.after &&
    (all ? (r.analysis.level ?? 0) < level : (!r.analysis.robotAgrees || r.analysis.severity !== 'ok')));
  const cubeLog = room.game?._cubeLog ?? [];
  const cubeTodo = all ? [] : (report.cube ?? []).map(c => c.i).filter(i => cubeLog[i]);
  if (!opts || (!todo.length && !cubeTodo.length)) { end(); return; }
  for (const { r, idx } of todo) {
    Object.defineProperty(r, '_deepening', { value: true, configurable: true, enumerable: false, writable: true });
    broadcast(room, { event: 'analysisDeepening', idx, level, auto: true });
  }
  const nWorkers = Math.max(1, Math.min(config.analysisWorkers ?? 4, availableParallelism() - 1, todo.length + cubeTodo.length));
  let live = nWorkers, ended = false;
  const stop = () => { if (!ended) { ended = true; for (const { r } of todo) r._deepening = false; end(); } };
  for (let w = 0; w < nWorkers; w++) {
    const chunk = todo.filter((_, k) => k % nWorkers === w);
    const worker = new Worker(new URL('./analysisWorker.js', import.meta.url), {
      workerData: { decisions: chunk.map(({ idx }) => { const raw = room.game._rolls[idx]; return { idx, before: raw.before, after: raw.after, pi: raw.pi }; }),
        cube: cubeTodo.filter((_, k) => k % nWorkers === w).map(i => ({ i, entry: cubeLog[i] })),
        cubeGames: config.cubeAnalysisGames,
        options: { ...opts, level } },
    });
    worker.on('message', msg => {
      if (msg.type === 'item') {
        const roll = report.rolls[msg.idx];
        roll._deepening = false;
        if (room.analysis?.result !== report) return;      // a rematch replaced the report
        roll.analysis = msg.item;
        broadcast(room, { event: 'analysisUpdate', idx: msg.idx, analysis: msg.item });
        saveRoomAnalysis(room, report);
      }
      if (msg.type === 'cube') {
        const c = report.cube?.[msg.i];
        if (!c || room.analysis?.result !== report) return;
        c.analysis = msg.item; c.pending = false;
        broadcast(room, { event: 'cubeUpdate', i: msg.i, analysis: msg.item });
        saveRoomAnalysis(room, report);
      }
      if (msg.type === 'end' && --live === 0) stop();
    });
    worker.on('error', err => { console.error('[analysis] auto-check failed', err); worker.terminate(); if (--live === 0) stop(); });
  }
}

// ---------- Play out every decision ----------
// A player asks for the whole game at the deep level (every decision played
// out, not just the questionable ones). Runs in the background like the
// automatic checks; each row updates as it finishes.
export function handlePlayOutAll(ws, roomId) {
  const room = rooms.get(roomId);
  const sess = sessions.get(ws._id);
  if (!room || !sess || sess.roomId !== roomId || room.analysis?.state !== 'done') return;
  if (room._playingOutAll) return;
  if (analysesRunning >= MAX_ANALYSES) {
    sendTo(ws, { event: 'error', code: 'ANALYSIS_BUSY', message: 'The server is busy analysing. Try again in a minute.' });
    return;
  }
  analysesRunning++;
  room._playingOutAll = true;
  broadcast(room, { event: 'playOutAll', running: true });
  autoCheck(room, room.analysis.result, () => {
    analysesRunning--; room._playingOutAll = false;
    broadcast(room, { event: 'playOutAll', running: false });
  }, { level: 2, all: true });
}

// ---------- Go deeper on one decision ----------

let deepensRunning = 0;
const MAX_DEEPENS = 2;                 // at once, server-wide

// A player asks for one analysed decision (report roll index) to be redone
// at the next depth. The new answer replaces the old one in the room's
// report and goes to everyone in the room.
export function handleAnalyzeDeeper(ws, roomId, idx) {
  const room = rooms.get(roomId);
  const sess = sessions.get(ws._id);
  if (!room || !sess || sess.roomId !== roomId || room.analysis?.state !== 'done') return;
  const report = room.analysis.result;
  const roll = report.rolls?.[idx];
  const raw = room.game?._rolls?.[idx];
  if (!roll?.analysis || !raw?.after) return;
  const level = (roll.analysis.level ?? 0) + 1;
  const opts = config.analysisLevels[level];
  if (!opts || roll._deepening) return;
  if (deepensRunning >= MAX_DEEPENS) {
    sendTo(ws, { event: 'error', code: 'ANALYSIS_BUSY', message: 'The server is busy analysing. Try again in a moment.' });
    return;
  }
  deepensRunning++;
  Object.defineProperty(roll, '_deepening', { value: true, configurable: true, enumerable: false, writable: true });
  broadcast(room, { event: 'analysisDeepening', idx, level });
  const worker = new Worker(new URL('./analysisWorker.js', import.meta.url), {
    workerData: { decisions: [{ idx, before: raw.before, after: raw.after, pi: raw.pi }], options: { ...opts, level } },
  });
  let done = false;
  const finish = (item) => {
    if (done) return;
    done = true; deepensRunning--; roll._deepening = false;
    if (item && room.analysis?.result === report) {
      roll.analysis = item;
      broadcast(room, { event: 'analysisUpdate', idx, analysis: item });
      saveRoomAnalysis(room, report);
    } else if (!item) {
      broadcast(room, { event: 'analysisUpdate', idx, analysis: roll.analysis, failed: true });
    }
  };
  worker.on('message', msg => { if (msg.type === 'item') finish(msg.item); });
  worker.on('error', err => { console.error('[analysis] deeper failed', err); finish(null); });
  worker.on('exit', () => finish(null));
}

// Go deeper on one cube decision (report.cube index): more played-out games
// (cubeLevels), or — for a no-double that was skipped as nowhere near the
// window — analyse it anyway at the first level.
export function handleAnalyzeDeeperCube(ws, roomId, i) {
  const room = rooms.get(roomId);
  const sess = sessions.get(ws._id);
  if (!room || !sess || sess.roomId !== roomId || room.analysis?.state !== 'done') return;
  const report = room.analysis.result;
  const c = report.cube?.[i];
  const entry = room.game?._cubeLog?.[i];
  if (!c || !entry || c.pending || c._deepening || c.analysis?.exact) return;
  const level = c.analysis?.skip ? 0 : (c.analysis?.level ?? 0) + 1;
  const games = config.cubeLevels[level];
  if (!games) return;
  if (deepensRunning >= MAX_DEEPENS) {
    sendTo(ws, { event: 'error', code: 'ANALYSIS_BUSY', message: 'The server is busy analysing. Try again in a moment.' });
    return;
  }
  deepensRunning++;
  Object.defineProperty(c, '_deepening', { value: true, configurable: true, enumerable: false, writable: true });
  broadcast(room, { event: 'cubeDeepening', i, level });
  const worker = new Worker(new URL('./analysisWorker.js', import.meta.url), {
    workerData: { decisions: [], cube: [{ i, entry }], cubeGames: games, cubeForce: true, cubeLevel: level, options: {} },
  });
  let done = false;
  const finish = item => {
    if (done) return;
    done = true; deepensRunning--; c._deepening = false;
    if (item && room.analysis?.result === report) { c.analysis = item; saveRoomAnalysis(room, report); }
    broadcast(room, { event: 'cubeUpdate', i, analysis: c.analysis, failed: !item });
  };
  worker.on('message', msg => { if (msg.type === 'cube') finish(msg.item); });
  worker.on('error', err => { console.error('[analysis] cube deeper failed', err); finish(null); });
  worker.on('exit', () => finish(null));
}

// For unit testing only — resets all module-level state between test cases.
export function _reset() {
  rooms.clear();
  sessions.clear();
}

// For unit testing only — exposes a room (and its live game) for state setup.
export function _getRoom(roomId) {
  return rooms.get(roomId);
}
