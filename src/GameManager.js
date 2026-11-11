// GameManager.js — room registry, session tracking, disconnect timers

import { randomBytes, randomInt, createHash, createHmac } from 'crypto';
import {
  createGame, rollDice, allLegalMoves, applyMove, skipDie,
  earnsExtraRoll, nextTurn, startExtraRoll, PLAYER_CONFIG, ARM_MAP,
  MARBLES_PER_PLAYER, offerResign, answerResign, abandonMultiple, canDouble, offerDouble, takeDouble, dropDouble, twoDiceTargets, gameResult,
} from './GameEngine.js';
import { exactEstimate, shouldDouble, shouldTake } from './CubeDecision.js';
import { matchCube, emg } from './MatchEquity.js';
import { recordGame, saveAnalysis, storeEnabled, rateGame, isBlocked, applyRatingBonus, nextUnanalysed } from './Store.js';
import { analyzeCube } from './CubeAnalysis.js';
import { pickNextRobotMove } from './RobotPlayer.js';
import { think } from './RobotThinker.js';
import { worthThinking } from './RobotRollout.js';
import { isDuel } from './DuelTable.js';
import { Worker } from 'worker_threads';
import { moveFeedback, describeRoll, allPlays } from './Analysis.js';
import { AICommentator } from './AICommentator.js';
import { LeagueTracker } from './LeagueTracker.js';
import { TEAMS } from '../public/js/league.js';
import { pipCount, countdown, PLAYER_CONFIG as PCFG } from '../public/js/constants.js';
const armOfPlayer = p => PCFG.findIndex(c => c.color === p.config.color);
import { evaluate1 } from './Evaluator.js';
import { availableParallelism } from 'os';

const DISCONNECT_TIMEOUT_MS  = 30 * 60 * 1000; // 30 minutes
const ROBOT_TURN_DELAY_MS    = 800;            // pause before robot's turn starts
const ROBOT_MOVE_DELAY_MS    = 600;            // pause between robot's individual moves
const MAX_TOTAL_ROOMS        = 200;            // global cap — prevents memory exhaustion
const MAX_ROOMS_PER_WS       = 3;             // per-connection cap
const LOBBY_TTL_MS           = 2 * 60 * 60 * 1000; // unstarted lobbies expire after 2 h
const ILLEGAL_LOG_INTERVAL_MS = 10_000;        // at most one illegal-move warning per socket per 10 s
const MAX_ANALYSES          = 1;              // post-game analyses running at once (CPU-heavy)
const FINISHED_GRACE_MS   = 10 * 60 * 1000; // keep a finished room after a disconnect, for reconnecting
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
    { screen: 16, deep: 150, keep: 3, maxDeep: 300 },      // 1: checked — every option screened by playouts, the best few + yours + the robot's played out
    { screen: 60, deep: 400, keep: 4, maxDeep: 1600 },     // 2: deep
    { screen: 120, deep: 1200, keep: 5, maxDeep: 4800 },   // 3: deepest
  ],
  analysisWorkers: 4,     // worker threads per analysis (capped at CPUs − 1)
  cubeAnalysisGames: 400, // played-out games per cube decision (when no exact table applies)
  cubeLevels: [400, 1600, 6400],
  backgroundAnalysis: true,  // analyse stored, never-analysed games when the server is idle
  dropNextGameMs: 1500,  // match play: pause after a game (not the last) before the next one starts
  watchNextGameMs: 12000, // watch mode: pause after a game (the last move, then 10 s of the result card)
  // Late in the game the robot plays its options out in a background thread
  // before moving. The game never waits longer than this (ms); 0 turns it off.
  secureDice: true,      // live dice from crypto.randomInt (tests turn it off to script rolls)
  robotThinkMs: 1500,
  robotCubeMs: 3000,     // play-out time for a robot's cube decision (more than a move: they're rare and costly)
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

export function createRoom(hostWs, hostName, totalPlayers, hostColor, { cube = false, matchTo = 0, watch = false, pace = 1.5 } = {}) {
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
    // Doubling cube: two players only; a match (to 2+) always has it, a 1-point match never.
    cube: totalPlayers === 2 && (Number.isInteger(matchTo) && matchTo >= 1 ? matchTo >= 2 : !!cube),
    // A match to N points (two players), or null for a money session.
    match: totalPlayers === 2 && Number.isInteger(matchTo) && matchTo >= 1 && matchTo <= 25
      ? { length: matchTo, score: [0, 0], crawfordUsed: false, over: false, winner: null } : null,
    score: Array(totalPlayers).fill(0),   // money-session points across rematches (cube rooms)
    wins: Array(totalPlayers).fill(0),    // games won in this room
    gamesPlayed: 0,
    watchers: new Set(),  // spectators' sockets (not seated)
  };
  rooms.set(roomId, room);
  // Watch mode: robots play every seat (the host's too) and each game starts
  // the next; the host only watches, until they quit. Nothing is stored.
  if (watch) {
    room.watch = true;
    room.match = null;
    // Robots-only rooms play slower than robots in a game with people: at the
    // default 1.5× a robot move comes every ~0.9 s and a turn starts after
    // ~1.2 s, about two beats of the music at its middle tempo.
    room.pace = Math.min(3, Math.max(0.5, Number(pace) || 1.5));
    for (const s of slots) {
      s.name = TEAMS[s.color]?.short ?? `Robot ${s.index + 1}`;   // the team (assignTeams sets it again each game)
      s.isRobot = true;
      s.accountId = null;
      s.ws = null;
      s.playerId = 'robot-' + s.index;
    }
    sessions.set(hostWs._id, { roomId, playerIndex: null, watcher: true });
    room.watchers.add(hostWs);
    // The AI commentator (it only calls out while it's switched on and someone watches).
    room._ai = new AICommentator(room, { send: msg => broadcast(room, msg) });
    // The league: teams, marbles, careers and records (robot stream rooms only).
    room._league = new LeagueTracker(room, { send: msg => broadcast(room, msg) });
    room.league = true;
  }

  // Return the hostId as reconnectToken so the host can authenticate reconnects.
  // The client must store this and send it back in any 'reconnect' action.
  return { roomId, code, reconnectToken: hostId, color: slots[0].color, totalPlayers, cube: room.cube, watch: !!room.watch,
    matchTo: room.match?.length ?? 0,
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

// Robots are "Robot", "Robot 2"… (every robot plays the same, tuned way).
export const ROBOT_NAMES = ['Robot'];

// What beginGame needs from the seats.
const seatPlayers = room => room.slots.map(s => ({ id: s.playerId, name: s.name, color: s.color, isRobot: s.isRobot }));

// League rooms: each seat is its colour's team.
function assignTeams(room) {
  for (const s of room.slots) { const t = TEAMS[s.color]; if (t) s.name = t.short; }
}

export function addRobot(ws, roomId) {
  const room = rooms.get(roomId);
  if (!room || room.state !== 'lobby') return { error: 'Invalid room' };
  if (!isHost(ws, room)) return { error: 'Only host can add robots' };

  const slot = room.slots.find(s => !s.playerId && !s.isRobot);
  if (!slot) return { error: 'No empty slots' };

  const taken = new Set(room.slots.map(s => s.name?.toLowerCase()).filter(Boolean));
  let name = 'Robot';
  for (let k = 2; taken.has(name.toLowerCase()); k++) name = `Robot ${k}`;
  slot.isRobot = true;
  slot.name = name;
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

// ---------- Seating ----------
//
// Who sits where matters (the player just behind you is the one best placed to
// hit you). People are spread out round the table by default — as far apart as
// the seats allow — unless the host arranged the seats themselves (swapSeats).
const SEAT_FIELDS = ['playerId', 'name', 'ws', 'accountId', 'isRobot'];
function arrangeSeats(room, contents) {
  room.slots.forEach((s, i) => Object.assign(s, contents[i]));
  room.slots.forEach((s, i) => {
    if (s.ws) { const sess = sessions.get(s.ws._id); if (sess) sess.playerIndex = i; }
    if (s.isRobot && s.playerId?.startsWith('robot-')) s.playerId = 'robot-' + i;
  });
}
function seatContents(room) { return room.slots.map(s => Object.fromEntries(SEAT_FIELDS.map(f => [f, s[f]]))); }
function announceSeats(room, hostBefore) {
  // The host keeps hosting wherever they now sit.
  room.hostIndex = room.slots.findIndex(s => s.ws && s.ws === hostBefore);
  if (room.hostIndex < 0) room.hostIndex = 0;
  room.slots.forEach((s, i) => { if (s.ws && !s.isRobot) sendTo(s.ws, { event: 'seatChanged', playerIndex: i, reconnectToken: s.playerId }); });
  broadcast(room, { event: 'lobbyState', lobbyState: lobbySnapshot(room) });
}
function spreadPeople(room) {
  const n = room.slots.length;
  const host = room.hostIndex;
  // People in seat order going round from the host; robots fill what's left.
  const order = Array.from({ length: n }, (_, k) => (host + k) % n);
  const people = order.filter(i => room.slots[i].playerId && !room.slots[i].isRobot);
  if (people.length < 2) return;
  const cur = seatContents(room);
  const targets = people.map((_, k) => (host + Math.round(k * n / people.length)) % n);
  if (people.every((p, k) => p === targets[k])) return;
  const others = order.filter(i => !people.includes(i)).map(i => cur[i]);
  const next = new Array(n);
  people.forEach((p, k) => { next[targets[k]] = cur[p]; });
  for (const i of order) if (!next[i]) next[i] = others.shift();
  const hostWs = room.slots[room.hostIndex]?.ws;
  arrangeSeats(room, next);
  announceSeats(room, hostWs);
}
// The host swaps two seats in the waiting room (then their arrangement stands).
export function handleSwapSeats(ws, roomId, a, b) {
  const room = rooms.get(roomId);
  if (!room || room.state !== 'lobby' || !isHost(ws, room)) return;
  const n = room.slots.length;
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0 || a >= n || b >= n || a === b) return;
  const cur = seatContents(room);
  [cur[a], cur[b]] = [cur[b], cur[a]];
  const hostWs = room.slots[room.hostIndex]?.ws;
  arrangeSeats(room, cur);
  room.seatsArranged = true;
  announceSeats(room, hostWs);
}

export function startGame(ws, roomId) {
  const room = rooms.get(roomId);
  if (!room || room.state !== 'lobby') return { error: 'Invalid room' };
  if (!isHost(ws, room)) return { error: 'Only host can start' };
  if (room.slots.some(s => !s.playerId && !s.isRobot)) return { error: 'Unfilled slots remain' };
  if (!room.seatsArranged) spreadPeople(room);

  const players = seatPlayers(room);

  beginGame(room, players);
  return { ok: true };
}

function beginGame(room, players) {
  if (room.league) { assignTeams(room); players = seatPlayers(room); }
  // Match play: a fresh match after one has ended; the Crawford game is the
  // first game after someone reaches match point (no doubling in it).
  const m = room.match;
  if (m?.over) { Object.assign(m, { score: [0, 0], crawfordUsed: false, over: false, winner: null }); room.records = []; }
  const crawford = !!m && !m.crawfordUsed && m.score.some(x => x === m.length - 1);
  if (crawford) m.crawfordUsed = true;
  room.game = createGame(players, room.slots.map(s => s.armIndex), config.initialTurnIndex,
    { cube: room.cube, crawford, away: m ? m.score.map(x => m.length - x) : null });
  // What a game's ending is worth, for the analysis: the score at the start
  // of this game (and whether the Crawford game is used up afterwards).
  Object.defineProperty(room.game, '_valueCtx', { value: {
    match: m ? { length: m.length, score: m.score.slice(), crawfordUsed: !!m.crawfordUsed } : null }, enumerable: false });
  if (config.secureDice) startDice(room.game);
  room.state = 'playing';
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
  beginGame(room, seatPlayers(room));
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
  // Every room keeps a points score: each loser pays the winner 1 (2 for an
  // aggro, 3 for a baggro), times the cube's value when playing with the cube.
  const r = game.result ?? (game.winner != null ? gameResult(game, game.winner) : null);
  const m = room.match;
  if (r && m) {
    m.score[r.winner] += r.points;
    if (m.score[r.winner] >= m.length) { m.over = true; m.winner = r.winner; }
  } else if (r) {
    room.score[r.winner] += r.points;
    for (const l of r.losers ?? room.score.map((_, pi) => ({ pi, points: r.points })).filter(l => l.pi !== r.winner)) room.score[l.pi] -= l.points;
  }
  storeFinishedGame(room, r);
  room.records ??= [];
  if (!m) room.records = [];
  const rec = { n: (room.records.at(-1)?.n ?? 0) + 1, game, analysis: null, storedGameId: room.storedGameId ?? null,
    score: m ? m.score.slice() : null, result: r, players: room.slots.map((s, i) => ({ name: s.name, color: game.players[i]?.color, isRobot: !!s.isRobot })) };
  room.records.push(rec);
  room.storedGameId = null;
  // In a match, every game goes straight on to the next (after a moment) —
  // no Next game step. Only the end of the match stops.
  if (m && !m.over) {
    const t = setTimeout(() => {
      if (rooms.has(room.id) && room.state === 'finished' && room.game === game && !room.slots.every(s => s.isRobot)) {
        beginGame(room, seatPlayers(room));
      }
    }, config.dropNextGameMs);
    t.unref?.();
  }
  if (room.watch) {
    const t = setTimeout(() => {
      if (rooms.has(room.id) && room.state === 'finished' && room.game === game) {
        beginGame(room, seatPlayers(room));
      }
    }, config.watchNextGameMs);
    t.unref?.();
  }
  const ratings = room._ratings ? room.slots.map(s => (s.accountId && room._ratings[s.accountId]) || null) : null;
  rec.ratingPairs = room._ratings?.pairs ?? null;
  room._ratings = null;
  // A rated game is analysed at once (quick level) for the played-better bonus.
  if (rec.ratingPairs?.length) setImmediate(() => { if (rooms.has(room.id)) handleAnalyzeGame(null, room.id, rec.n); });
  const dice = game._dice ? { commit: game._dice.commit, seed: game._dice.seed } : null;
  broadcast(room, { event: 'gameResult', game: rec.n, ratings, dice, winnerIndex: game.winner, result: r,
    score: !m ? room.score.slice() : null, wins: room.wins.slice(), gamesPlayed: room.gamesPlayed,
    match: m ? structuredClone(m) : null });
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
    const seats = room.slots.map((s, i) => {
        const c = game._cubeStats?.[i] ?? {};
        const won = game.winner === i;
        return {
          playerId: s.accountId ?? null, name: s.name ?? `Player ${i + 1}`, color: s.color,
          isRobot: !!s.isRobot && !s.accountId, won,
          points: r ? (won ? r.points : -(r.losers?.find(l => l.pi === i)?.points ?? (two ? r.points : 0))) : 0,
          aggro: won ? !!r?.aggro : (r?.losers?.find(l => l.pi === i)?.mult ?? (r?.aggro ? 2 : 1)) >= 2,
          doubles: c.doubles, takes: c.takes, drops: c.drops,
        };
      });
    room.storedGameId = recordGame({ cube: !!game.cube, winnerSeat: game.winner, rolls: game._rolls ?? [], seats, diceSeed: game._dice?.seed ?? null });
    // Rated only between accounts with no robot seat (a quitter's seat still counts as theirs).
    room._ratings = rateGame(seats, game.winner, room.storedGameId);
  } catch (err) {
    console.error('[store] could not record game', err);
  }
}

// Played better as well as won: when a rated game's analysis shows the winner
// with a lower error rate (equity lost per decision, moves and cube) than a
// loser, that pair's rating exchange counts twice. Once per game.
function ratingBonus(room, rec, report) {
  if (!rec.ratingPairs?.length || rec._bonusDone || !storeEnabled()) return;
  rec._bonusDone = true;
  const per = seatAnalysis(report);
  const rate = i => { const s = per[i], n = (s?.choices ?? 0) + (s?.cubeDecisions ?? 0); return n ? (2 * s.eqLost + (s.cubeEqLost ?? 0)) / n : null; };
  for (const p of rec.ratingPairs) {
    const rw = rate(p.winSeat), rl = rate(p.loseSeat);
    if (rw == null || rl == null || !(rw < rl)) continue;
    const r = applyRatingBonus(p);
    if (!r) continue;
    broadcast(room, { event: 'ratingBonus', game: rec.n, winSeat: p.winSeat, loseSeat: p.loseSeat,
      ratings: { [p.winSeat]: { rating: r[p.winId]?.rating, change: Math.round(p.dw) }, [p.loseSeat]: { rating: r[p.loseId]?.rating, change: Math.round(p.dl) } } });
  }
}

// Per-seat numbers from an analysis report, counted as on the page: every
// loss beyond the rollout noise; cube: every wrong action that isn't close, per unit of cube.
function seatAnalysis(report) {
  return report.players.map((_, pi) => {
    const mine = report.rolls.filter(x => x.pi === pi && x.analysis);
    const bad = mine.filter(x => x.analysis.severity !== 'ok');
    const rolls = report.rolls.filter(x => x.pi === pi);
    const luck = rolls.some(x => x.luck != null) ? rolls.reduce((t, x) => t + (x.luck ?? 0), 0) : null;
    return { luck, choices: mine.length, errors: bad.filter(x => x.analysis.severity === 'error').length,
      blunders: bad.filter(x => x.analysis.severity === 'blunder').length,
      eqLost: mine.reduce((sum, x) => sum + (x.analysis.loss > 1.96 * (x.analysis.se ?? 0) ? x.analysis.loss : 0), 0),
      ...cubeSeat(report, pi) };
  });
}
function cubeSeat(report, pi) {
  const mine = (report.cube ?? []).filter(c => c.pi === pi && c.analysis && !c.analysis.skip);
  const bad = mine.filter(c => c.analysis.severity !== 'ok');
  return { cubeDecisions: mine.length, cubeErrors: bad.filter(c => c.analysis.severity === 'error').length,
    cubeBlunders: bad.filter(c => c.analysis.severity === 'blunder').length,
    cubeEqLost: mine.filter(c => !c.analysis.close && c.analysis.played !== c.analysis.best)
      .reduce((sum, c) => sum + (c.analysis.lossNorm ?? c.analysis.loss), 0) };
}
function saveRecAnalysis(rec, report) {
  if (!rec.storedGameId || !storeEnabled()) return;
  try { saveAnalysis(rec.storedGameId, report, seatAnalysis(report)); } catch (err) { console.error('[store] could not save analysis', err); }
}

// ---------- Finished games kept for analysis ----------
// Each finished game is a record { n, game, analysis, storedGameId, score }.
// A match keeps every game until a new match starts; otherwise just the last.
// Analysis actions name the game by n (default: the latest).
function recordFor(room, gameNo) {
  room.records ??= [];
  const recs = room.records;
  // A finished game that has no record yet (it ended some other way): add it.
  if (room.state === 'finished' && room.game && !recs.some(r => r.game === room.game)) {
    recs.push({ n: (recs.at(-1)?.n ?? 0) + 1, game: room.game, analysis: null, storedGameId: room.storedGameId ?? null,
      score: room.match ? room.match.score.slice() : null, result: room.game.result ?? null,
      players: room.slots.map((s, i) => ({ name: s.name, color: room.game.players[i]?.color, isRobot: !!s.isRobot })) });
  }
  if (gameNo == null) return recs[recs.length - 1] ?? null;
  return recs.find(r => r.n === gameNo) ?? null;
}

// A stored game, for replay: its saved analysis, or a plain report built
// from its roll records.
export function storedGameReport(g) {
  if (g.report) return g.report;
  const rolls = g.rolls ?? [];
  return {
    players: g.seats.map(s => ({ name: s.name, color: s.color, isRobot: s.isRobot })),
    winner: g.winnerSeat,
    dice: g.diceSeed ? { commit: createHash('sha256').update(Buffer.from(g.diceSeed, 'hex')).digest('hex'), seed: g.diceSeed } : null,
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
  const dEntry = entry.kind === 'double' ? entry.pi : entry.doubler;
  entry.turn = game._turnNo ?? 1;
  game._cubeLog.push({ ...entry, turn: game._turnNo ?? 1, rollIdx, match: matchCtx(room, dEntry) });
  const slot = room.slots[entry.pi];
  if (!slot || slot.isRobot || !slot.ws) return;
  const d = entry.kind === 'double' ? entry.pi : entry.doubler;
  // A double to a robot: the robot works out the same chances to answer it,
  // so the feedback waits for that (one estimate, and the robot's thinking
  // thread stays free for its own decision).
  if (entry.kind === 'double' && entry.action && room.slots[1 - entry.pi]?.isRobot) { game._feedbackWait = entry; return; }
  cubeEstimate(entry.state, d).then(est => { if (est) sendCubeFeedback(room, slot.ws, entry, est); }).catch(() => {});
}

// est: chances from the doubler's side.
function sendCubeFeedback(room, ws, entry, est) {
  {
    const d = entry.kind === 'double' ? entry.pi : entry.doubler;
    const sd = cubeDecision(room, room.game, est, d, entry.state.cube);
    const v = entry.state.cube.value;
    // Money play: equity at this cube. Match play: match-winning chances,
    // shown in the same equity units (EMG).
    const f = room.match ? x => emg(x, sd).toFixed(3) : x => (v * x).toFixed(3);
    let agrees, text;
    if (entry.kind === 'double') {
      agrees = sd.double === entry.action;
      if (agrees && !entry.action) return;              // a quiet no-double: nothing to say
      // How much the choice cost (doubler's equity, cube units): a tiny
      // difference is a close call, not a mistake.
      const dbl = Math.min(sd.dt, sd.dp), cost = Math.abs(dbl - sd.nd) * (room.match ? 1 : v);
      const close = cost < 0.06 ? `close call, −${cost.toFixed(3)}; ` : `−${cost.toFixed(3)}; `;
      text = agrees ? '✓ Coach agrees: double'
        : (entry.action ? 'Coach would not double' : `Coach would have doubled at the start of your turn ${entry.turn}`)
          + ` (${close}no double ${f(sd.nd)} · double/take ${f(sd.dt)} · double/drop ${f(sd.dp)})`;
    } else {
      const takeEq = -sd.dt, dropEq = -sd.dp;
      const shouldTakeIt = room.match ? sd.take : takeEq > dropEq;
      agrees = shouldTakeIt === entry.action;
      text = agrees ? `✓ Coach agrees: ${entry.action ? 'take' : 'drop'}`
        : `Coach would ${shouldTakeIt ? 'take' : 'drop'} (take ${room.match ? (-emg(sd.dt, sd)).toFixed(3) : f(takeEq)} · drop ${room.match ? (-emg(sd.dp, sd)).toFixed(3) : f(dropEq)})`;
    }
    sendTo(ws, { event: 'cubeFeedback', playerIndex: entry.pi, kind: entry.kind, turn: entry.turn, agrees, text, exact: !!est.exact });
  }
}

// ---------- Doubling cube ----------

// The cube decision for doubler d (est = d's chances from the turn's start):
// match play uses the match equity table at the current score; money play
// the Janowski formulas.
// → { double, take, nd, dt, dp } (take = the opponent should take).
function cubeDecision(room, game, est, d, cube = game.cube) {
  const m = room.match;
  if (m) {
    const owner = cube.owner == null ? 'centre' : cube.owner === d ? 'me' : 'opp';
    const r = matchCube(est, { a: m.length - m.score[d], b: m.length - m.score[1 - d], v: cube.value, crawfordUsed: m.crawfordUsed, owner });
    return r;
  }
  const owner = cube.owner == null ? 'centre' : cube.owner === d ? 'me' : 'opp';
  const sd = shouldDouble(est, owner);
  const st = shouldTake({ ...est, p: 1 - est.p, aggroWin: est.aggroLoss, aggroLoss: est.aggroWin });
  return { ...sd, take: st.take };
}
// The match position for a cube decision (kept with the decision for the analysis).
function matchCtx(room, d) {
  const m = room.match;
  return m ? { a: m.length - m.score[d], b: m.length - m.score[1 - d], crawfordUsed: m.crawfordUsed, length: m.length } : null;
}

const cubeStat = (game, pi) => ((game._cubeStats ??= {})[pi] ??= { doubles: 0, takes: 0, drops: 0 });
const cubeOwnerFor = (game, pi) => game.cube.owner == null ? 'centre' : game.cube.owner === pi ? 'me' : 'opp';

// Chances for player pi from the start of the current turn: exact when a duel
// table applies, else played out in the robot's thinking thread (bounded by
// config.robotThinkMs). Null when there is no estimate in time.
async function cubeEstimate(game, pi) {
  const exact = exactEstimate(game, pi);
  if (exact) return exact;
  if (!(config.robotThinkMs > 0)) return null;
  return think(snapshot(game), pi, Math.max(config.robotThinkMs, config.robotCubeMs ?? 0), 'cube');
}

// ---------- Resignation offers (two players) ----------
export function handleResign(ws, roomId, mult) {
  const room = rooms.get(roomId);
  if (!room || room.state !== 'playing') return;
  const sess = sessions.get(ws._id);
  const game = room.game;
  if (!sess || !offerResign(game, sess.playerIndex, mult)) return;
  broadcast(room, { event: 'resignOffered', playerIndex: sess.playerIndex, mult, points: game.resignOffer.points });
  if (room.slots[game.resignOffer.to]?.isRobot) robotAnswerResign(room);
}
export function handleResignAnswer(ws, roomId, accept) {
  const room = rooms.get(roomId);
  const sess = sessions.get(ws._id);
  if (!room || !sess || room.state !== 'playing') return;
  answerResignFor(room, sess.playerIndex, !!accept);
}
function answerResignFor(room, pi, accept) {
  const game = room.game, o = game.resignOffer;
  if (!o || !answerResign(game, pi, accept)) return;
  broadcast(room, { event: 'resignAnswered', playerIndex: pi, accept, mult: o.mult, points: o.points });
  if (accept) finishGame(room);
}
// The robot accepts when the offer is at least what it expects from playing
// on (its win chance and extra aggro/baggro points; cube ignored); otherwise
// it declines. Without an estimate it accepts.
function robotAnswerResign(room) {
  const game = room.game, o = game.resignOffer, pi = o.to;
  const toMove = { ...game, phase: 'IN_TURN', resignOffer: null };
  cubeEstimate(toMove, pi).then(est => {
    if (room.game !== game || game.resignOffer !== o) return;
    let accept = true;
    if (est) {
      const p = est.p, extraWin = est.aggroWin, extraLoss = est.aggroLoss;   // the robot's side
      const expected = p + extraWin - (1 - p) - extraLoss;   // per unit of stake
      accept = o.mult >= expected - 1e-9;
    }
    answerResignFor(room, pi, accept);
  }).catch(() => answerResignFor(room, pi, true));
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
      if (w) sendCubeFeedback(room, w, fw, { ...est, p: 1 - est.p, aggroWin: est.aggroLoss, aggroLoss: est.aggroWin });
    }
    const wait = Math.max(0, ROBOT_TURN_DELAY_MS * (room.pace ?? 1) - (Date.now() - started));
    room.robotTurnTimer = setTimeout(() => {
      room.robotTurnTimer = null;
      if (!rooms.has(room.id) || game.cubeOffer !== offer || !room.slots[pi]?.isRobot) return;
      answerDouble(room, pi, est ? cubeDecision(room, game, { ...est, p: 1 - est.p, aggroWin: est.aggroLoss, aggroLoss: est.aggroWin }, offer.from).take : true);
    }, wait);
  }).catch(() => answerDouble(room, pi, true));
}

// ---------- Shared roll helper ----------

// The dice of live games come from the operating system's secure random
// generator: unbiased and unpredictable (Math.random's state can in principle
// be worked out from enough output). Simulations — robot thinking, analysis
// play-outs — keep their own fast, seedable generator.
// Provably fair: each game has a secret 32-byte seed, chosen at random when
// it starts; its SHA-256 fingerprint is shown then, the seed itself only when
// the game is over. Roll number k (0, 1, 2, …) is the first two bytes below
// 252 of HMAC-SHA256(seed, "k"), each taken as 1 + byte mod 6 (252 = 6 × 42,
// so all six faces are equally likely). Anyone can re-derive every roll from
// the revealed seed and check the game (the client's "Verify dice" does).
export function diceFromSeed(seedHex, k) {
  const h = createHmac('sha256', Buffer.from(seedHex, 'hex')).update(String(k)).digest();
  const out = [];
  for (const byte of h) { if (byte < 252) out.push(1 + (byte % 6)); if (out.length === 2) break; }
  while (out.length < 2) out.push(randomInt(1, 7));     // (never happens: 32 bytes)
  return out[0] >= out[1] ? out : [out[1], out[0]];
}
function startDice(game) {
  const seed = randomBytes(32).toString('hex');
  Object.defineProperty(game, '_dice', { value: { seed, n: 0, commit: createHash('sha256').update(Buffer.from(seed, 'hex')).digest('hex') }, enumerable: false, writable: true });
}
function liveDice(game) {
  if (!config.secureDice) return rollDice();          // tests script the dice through Math.random
  if (!game._dice) startDice(game);
  return diceFromSeed(game._dice.seed, game._dice.n++);
}

// Performs a dice roll and transitions game to AWAITING_MOVE.
// Called by both human handleRoll() and doRobotTurn() so roll logic stays in one place.
// ---------- "That's the roll X needed!" ----------
// For the commentary: would this roll have been a big deal for someone else?
// Each other player is tried with the same dice on a copy of the position
// (the real engine): it would have won them the game, let them bonk the
// leader's marble near home, or ended a long wait in the hub (a 1) or in base
// (a 1 or 6, all four stuck). Only the biggest one, and only clear cases.
function updateWaits(game, pi, dice) {
  const w = (game._waits ??= {})[pi] ??= { hub: 0, base: 0 };
  const ms = game.players[pi].marbles;
  w.hub = ms.some(m => m.zone === 'center') && !dice.includes(1) ? w.hub + 1 : 0;
  w.base = ms.every(m => m.zone === 'base') && !dice.includes(1) && !dice.includes(6) ? w.base + 1 : 0;
}
export function _rollEnvy(game, roller, dice) { return rollEnvy(game, roller, dice); }
function rollEnvy(game, roller, dice) {
  try {
    const n = game.players.length;
    const pips = game.players.map(p => pipCount(armOfPlayer(p), p.marbles));
    let best = null;
    const rank = { win: 4, hit: 3, hub: 2, base: 1 };
    const consider = e => { if (!best || rank[e.kind] > rank[best.kind]) best = e; };
    for (let o = 0; o < n; o++) {
      if (o === roller) continue;
      const P = game.players[o], home = P.marbles.filter(m => m.zone === 'home').length;
      const w = game._waits?.[o];
      if (w?.hub >= 2 && dice.includes(1)) consider({ pi: o, kind: 'hub', turns: w.hub });
      if (w?.base >= 2 && (dice.includes(1) || dice.includes(6))) consider({ pi: o, kind: 'base', turns: w.base });
      // The engine checks: a win needs 2+ home; a hit on the leader near home.
      const leader = pips.reduce((b, x, i) => (i !== o && x < pips[b] ? i : b), o === 0 ? 1 : 0);
      const target = game.players[leader].marbles.some(m => m.zone === 'track' && countdown(armOfPlayer(game.players[leader]), m.space) < 12);
      if (home < 2 && !target) continue;
      const g = { players: structuredClone(game.players), turnIndex: o, phase: 'AWAITING_MOVE', dice: dice.slice(), diceUsed: [false, false], winner: null, cube: null };
      for (const play of allPlays(g, o)) {
        if (play.game.winner === o) { consider({ pi: o, kind: 'win' }); break; }
        if (target && leader !== roller) {
          const lost = game.players[leader].marbles.some((m, id) => m.zone === 'track' && countdown(armOfPlayer(game.players[leader]), m.space) < 12 && play.game.players[leader].marbles[id].zone === 'base');
          if (lost) consider({ pi: o, kind: 'hit', victim: leader });
        }
      }
    }
    return best;
  } catch (err) { return null; }
}

function performRoll(game) {
  const dice = liveDice(game);
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
  const envy = rollEnvy(game, game.turnIndex, dice); updateWaits(game, game.turnIndex, dice);
  broadcast(room, { event: 'rolled', playerIndex: game.turnIndex, dice, moves, combos: twoDiceTargets(game, game.turnIndex), envy });
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

  // A deliberate skip is part of the turn like a move: it can be undone, and
  // the turn ends with Commit.
  game._undoStack ??= [];
  game._undoStack.push({ marbles: game.players.map(p => p.marbles.map(m => ({ ...m }))), diceUsed: [...game.diceUsed] });
  game._humanMadeMove = true;
  skipDie(game, idx);
  // Tell everyone the die was skipped so the client updates its dice state and
  // re-evaluates the Skip button for the other die (otherwise the player can be
  // stuck unable to skip a second optional-only die).
  broadcast(room, { event: 'dieForfeit', dieIndex: idx });
  advanceTurnIfDone(room);
}

// ---------- Quitting ----------
//
// Quit a room for good. During a game:
//   2 players — a resignation: the other player wins the cube's value (a
//               single game); in a match, they win the match.
//   3+ players — a robot takes over the seat and the game goes on.
// Robots-only games just end. After the game (or in the lobby) it is a plain leave.
export function handleQuit(ws, roomId) {
  const room = rooms.get(roomId);
  const sess = sessions.get(ws._id);
  if (!room || !sess || sess.roomId !== roomId) return;
  if (sess.watcher) { sessions.delete(ws._id); stopWatching(room, ws, { grace: false }); return; }
  const pi = sess.playerIndex, slot = room.slots[pi], game = room.game;
  if (room.state === 'playing' && game && game.winner == null && slot && !slot.isRobot) {
    const others = room.slots.filter((s, i) => i !== pi && s.playerId && !s.isRobot).length;
    if (room.totalPlayers === 2 && others > 0) {
      // Abandoning: in a match, the match; else the most still losable.
      const w = 1 - pi, m = room.match, mult = abandonMultiple(game.players[pi]);
      const points = m ? m.length - m.score[w] : (game.cube?.value ?? 1) * mult;
      game.cubeOffer = null; game.resignOffer = null; game.phase = 'GAME_OVER'; game.winner = w;
      game.result = { winner: w, points, losers: [{ pi, points, mult }], aggro: mult >= 2, baggro: mult === 3, dropped: false, resigned: true, abandoned: true };
      broadcast(room, { event: 'playerQuit', playerIndex: pi, resigned: true });
      finishGame(room);
    } else if (others > 0) {
      slot.isRobot = true;
      broadcast(room, { event: 'playerQuit', playerIndex: pi });
      broadcast(room, { event: 'robotTookOver', playerIndex: pi });
      if (game.turnIndex === pi || game.cubeOffer?.to === pi) scheduleCurrentTurn(room);
    }
  } else if (room.state === 'finished') {
    broadcast(room, { event: 'playerQuit', playerIndex: pi });
  }
  if (room.state === 'lobby') { leaveRoom(ws); return; }
  // Gone for good: no reconnecting, and a robot plays the seat in any rematch.
  sessions.delete(ws._id);
  let tookOver = false;
  if (slot) {
    slot.ws = null;
    if (!slot.isRobot) { slot.isRobot = true; tookOver = true; broadcast(room, { event: 'robotTookOver', playerIndex: pi }); }
  }
  const t = room.disconnectTimers.get(pi);
  if (t) { clearTimeout(t); room.disconnectTimers.delete(pi); }
  if (cleanupIfAbandoned(room)) return;
  // Robots only now, but still watched: the robot takes the seat's turn.
  if (tookOver && room.state === 'playing' && game && game.winner == null && (game.turnIndex === pi || game.cubeOffer?.to === pi)) scheduleCurrentTurn(room);
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
  if (sess.watcher) { stopWatching(room, ws); return; }

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
    // A dropped connection (a phone or iPad pausing the tab) usually comes
    // straight back: keep the seat for FINISHED_GRACE_MS so the player can
    // reconnect to the result, the analysis and Rematch. Only then tell the
    // others they left, and close the room once nobody is connected.
    const pi = sess.playerIndex;
    const t = setTimeout(() => {
      room.disconnectTimers.delete(pi);
      if (!rooms.has(room.id) || slot.ws) return;
      broadcast(room, { event: 'opponentLeft', playerIndex: pi });
      if (!room.slots.some(s => s.ws)) deleteRoom(room);
    }, FINISHED_GRACE_MS);
    t.unref?.();
    room.disconnectTimers.set(pi, t);
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
  if (!room) return { error: 'GONE' };
  if (room.state !== 'playing' && room.state !== 'finished') return { error: 'Invalid room' };

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

  // After the game: just re-attach (the page keeps showing the result or
  // the analysis; nothing to redraw).
  if (room.state === 'finished') {
    sendTo(ws, { event: 'rejoined' });
    return { ok: true };
  }

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
  // Robots only: it goes on while someone watches (not in the lobby).
  if (room.state !== 'lobby' && room.watchers?.size > 0) return false;
  deleteRoom(room);
  return true;
}

// Remove a room and everything that could still act on it: every pending
// timer, and any sessions pointing at it.
function deleteRoom(room) {
  room._ai?.stop();
  for (const w of room.watchers ?? []) sendTo(w, { event: 'watchEnded' });
  room.watchers?.clear();
  clearTimeout(room._unwatchedTimer);
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
    }, ROBOT_TURN_DELAY_MS * (room.pace ?? 1));
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
    // Nowhere near a double (the instant evaluator gives it under 55%): no
    // double, without spending play-out time on it.
    const quick = exactEstimate(game, me) ? null : evaluate1(game, me)?.[me];
    const estP = quick != null && quick < 0.55 ? Promise.resolve(null) : cubeEstimate(game, me);
    estP.then(est => {
      if (!rooms.has(room.id) || room.game !== game || game.phase !== 'IN_TURN' || game.turnIndex !== me || !room.slots[me]?.isRobot) return;
      if (est && cubeDecision(room, game, est, me).double && doubleFor(room, me)) return;
      recordCube(room, { kind: 'double', pi: me, action: false, state: cubeSnapshot(game) });
      doRobotTurn(room);
    }).catch(() => doRobotTurn(room));
    return;
  }

  // Roll using the shared helper (same logic path as a human roll)
  if (game.phase === 'IN_TURN' || game.phase === 'EXTRA_ROLL') {
    const dice = performRoll(game);
    const envy = rollEnvy(game, game.turnIndex, dice); updateWaits(game, game.turnIndex, dice);
    broadcast(room, { event: 'rolled', playerIndex: game.turnIndex, dice, envy });
  }
  room.robotPlan = null;

  // Late in the game: think first (bounded by config.robotThinkMs; on a late
  // or failed answer the robot just plays its normal move).
  const pi = game.turnIndex;
  if (config.robotThinkMs > 0 && game.phase === 'AWAITING_MOVE' && !isDuel(game) && worthThinking(game, pi)) {
    const rollId = game._afterRoll;
    // With the cube and the score context, so the play-outs value endings in points.
    think({ ...snapshot(game), cube: structuredClone(game.cube ?? null), valueCtx: game._valueCtx ?? {} }, pi, config.robotThinkMs).then(result => {
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
      skipDie(game, dieIdx);
      broadcast(room, { event: 'dieForfeit', dieIndex: dieIdx });
    }
    applyNextRobotMove(room);
  }, ROBOT_MOVE_DELAY_MS * (room.pace ?? 1));
}

// Watch mode: start the robots' first game (the host is already watching).
export function startWatchRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room?.watch || room.state !== 'lobby') return;
  beginGame(room, seatPlayers(room));
}

// A watch-mode viewer: may chat, analyse and quit, but never act for the seat.
export function isWatcher(ws) {
  return !!sessions.get(ws._id)?.watcher;
}

// ---------- Spectators ----------

// A watcher left (Quit, closed the tab, or went elsewhere). A robots-only game
// nobody watches any more ends: at once on Quit, after a short grace for a
// dropped connection (a phone pausing the tab) so the viewer can come back.
function stopWatching(room, ws, { grace = true } = {}) {
  room.watchers.delete(ws);
  if (humanCount(room) > 0 || room.watchers.size) return;
  if (!grace) { deleteRoom(room); return; }
  clearTimeout(room._unwatchedTimer);
  room._unwatchedTimer = setTimeout(() => {
    if (rooms.has(room.id) && !room.watchers.size && humanCount(room) === 0) deleteRoom(room);
  }, DISCONNECT_TIMEOUT_MS);
  room._unwatchedTimer.unref?.();
}

// The stream's robot rooms that someone is watching (the YouTube chat is read only then).
export function streamRoomsWatched() {
  return [...rooms.values()].some(r => r.watch && r.watchers?.size);
}
// New YouTube chat messages: to every watched robot room (AI commentator + the page).
export function streamChat(messages) {
  for (const room of rooms.values()) {
    if (!room.watch || !room.watchers?.size) continue;
    for (const m of messages) room._ai?.addChat(m.author, m.text);
    broadcast(room, { event: 'streamChat', messages: messages.map(m => ({ author: String(m.author).slice(0, 40), text: String(m.text).slice(0, 200) })) });
  }
}

// Games in progress (or just finished), for the Watch list.
export function liveGames() {
  return [...rooms.values()].filter(r => r.game && (r.state === 'playing' || r.state === 'finished')).map(r => ({
    roomId: r.id, state: r.state, game: r.gamesPlayed + (r.state === 'playing' ? 1 : 0),
    players: r.slots.map(s => ({ name: s.name, color: s.color, isRobot: !!s.isRobot })),
    watchers: r.watchers.size, watch: !!r.watch, cube: !!r.cube,
    match: r.match ? { length: r.match.length, score: r.match.score.slice() } : null,
  }));
}

// Start watching a game (or come back after a dropped connection).
export function handleWatchGame(ws, roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.game) return { error: 'GONE' };
  const sess = sessions.get(ws._id);
  if (sess && !(sess.watcher && sess.roomId === roomId)) leaveRoom(ws);
  if (room.watchers.size >= 50) return { error: 'Too many watchers' };
  sessions.set(ws._id, { roomId, playerIndex: null, watcher: true });
  room.watchers.add(ws);
  clearTimeout(room._unwatchedTimer);
  sendTo(ws, { event: 'reconnected', gameState: publicState(room), watching: true });
  const ls = room._league?.state();
  if (ls) sendTo(ws, { event: 'leagueState', ...ls });
  return { ok: true };
}

function isHost(ws, room) {
  return !!ws && room.slots[room.hostIndex]?.ws === ws;
}

function broadcast(room, msg, excludeWs = null) {
  room._league?.observe(msg);
  room._ai?.observe(msg);
  const data = JSON.stringify(msg);
  for (const w of room.watchers ?? []) {
    if (w !== excludeWs && w.readyState === 1) { try { w.send(data); } catch { /* closed */ } }
  }
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
    watch: !!room.watch,
    league: !!room.league,
    turnNo: game._turnNo ?? 1,
    gameNo: room.gamesPlayed + (room.state === 'finished' ? 0 : 1),   // this room's game number (1st, 2nd…)
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
    resignOffer: game.resignOffer ?? null,
    diceCommit: game._dice?.commit ?? null,
    score: !room.match ? room.score.slice() : null,
    wins: room.wins.slice(),
    match: room.match ? { ...structuredClone(room.match), crawford: !!game.cube?.crawford } : null,
    gamesPlayed: room.gamesPlayed,
  };
}

// ---------- Background analysis (idle time) ----------
//
// Games that were stored but never analysed get analysed when the server is
// otherwise idle: no game in progress and no analysis running. One game at a
// time, in one worker, at the automatic level (played out), so the stats,
// trends and history fill in. It stops between games as soon as anyone plays.
const backgroundSkip = new Set();
let backgroundBusy = false;
const serverIdle = () => analysesRunning === 0 && checksRunning === 0 && deepensRunning === 0 &&
  ![...rooms.values()].some(r => r.state === 'playing' && r.slots.some(s => !s.isRobot && s.ws));
export function backgroundAnalysisTick() {
  if (backgroundBusy || !storeEnabled() || !config.backgroundAnalysis || !serverIdle()) return false;
  const g = nextUnanalysed(backgroundSkip);
  if (!g) return false;
  backgroundSkip.add(g.id);
  const rolls = g.rolls ?? [];
  const decisions = rolls.map((r, idx) => ({ r, idx })).filter(x => !x.r.forced && x.r.before && x.r.after)
    .map(({ r, idx }) => ({ idx, before: r.before, after: r.after, pi: r.pi }));
  const report = storedGameReport({ ...g, report: null });
  if (!decisions.length) { saveAnalysis(g.id, report, seatAnalysis(report)); return true; }
  backgroundBusy = true;
  const level = 1, opts = config.analysisLevels[level];
  const worker = new Worker(new URL('./analysisWorker.js', import.meta.url), {
    workerData: { decisions, options: { ...opts, level }, cube: [], luck: rolls.map((r, idx) => ({ idx, before: r.before, pi: r.pi })).filter(x => x.before) },
  });
  let ended = false;
  const end = ok => {
    if (ended) return; ended = true; backgroundBusy = false;
    if (ok) { try { saveAnalysis(g.id, report, seatAnalysis(report)); } catch (err) { console.error('[background] save failed', err); } }
  };
  worker.on('message', msg => {
    if (msg.type === 'item' && report.rolls[msg.idx]) report.rolls[msg.idx].analysis = msg.item;
    if (msg.type === 'luck' && report.rolls[msg.idx]) report.rolls[msg.idx].luck = msg.luck;
    if (msg.type === 'end') end(true);
  });
  worker.on('error', err => { console.error('[background] analysis failed', err.message); end(false); });
  worker.on('exit', () => end(false));
  return true;
}
if (process.env.NODE_ENV !== 'test') setInterval(backgroundAnalysisTick, 60_000).unref();

// ---------- In-game chat ----------
// Short messages to everyone in the room (lobby, game, after the game).
// At most 8 per 10 seconds per connection; 300 characters. Someone who has
// blocked the sender (both with accounts) doesn't receive it.
export const CHAT_MAX = 300;
export function handleChat(ws, roomId, text) {
  const room = rooms.get(roomId);
  const sess = sessions.get(ws._id);
  if (!room || !sess || sess.roomId !== roomId) return;
  const body = String(text ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, CHAT_MAX);
  if (!body) return;
  const t = Date.now();
  ws._chatTimes = (ws._chatTimes ?? []).filter(x => t - x < 10_000);
  if (ws._chatTimes.length >= 8) { sendTo(ws, { event: 'error', code: 'RATE_LIMITED', message: 'Slow down a little.' }); return; }
  ws._chatTimes.push(t);
  const from = room.slots[sess.playerIndex];
  const msg = JSON.stringify({ event: 'chat', playerIndex: sess.playerIndex, name: from?.name, text: body, at: t });
  for (const s of room.slots) {
    if (!s.ws || s.ws.readyState !== 1) continue;
    if (s.accountId && from?.accountId && storeEnabled() && isBlocked(s.accountId, from.accountId)) continue;
    try { s.ws.send(msg); } catch { /* closed */ }
  }
  for (const w of room.watchers) if (w.readyState === 1) { try { w.send(msg); } catch { /* closed */ } }
}

// For reports: the account sitting in seat `seat` of this connection's room.
export function seatAccountOf(ws, seat) {
  const room = rooms.get(sessions.get(ws._id)?.roomId);
  return room?.slots[seat]?.accountId ?? null;
}
// For the admin page: what the server is doing.
export function serverSnapshot() {
  const list = [...rooms.values()];
  return {
    rooms: list.length, lobbies: list.filter(r => r.state === 'lobby').length, playing: list.filter(r => r.state === 'playing').length,
    peopleInGames: list.filter(r => r.state === 'playing').reduce((n, r) => n + r.slots.filter(s => !s.isRobot && s.ws).length, 0),
    analyses: analysesRunning, analysisQueue: analysisQueue.length, checks: checksRunning, checkQueue: checkQueue.length,
    games: list.filter(r => r.state !== 'lobby').slice(0, 30).map(r => ({ code: r.code, state: r.state,
      players: r.slots.map(s => (s.name ?? '—') + (s.isRobot ? ' 🤖' : '')), match: r.match ? `${r.match.score.join('–')} of ${r.match.length}` : null })),
  };
}

// The code of the lobby this connection is in (for invites), else null.
export function roomCodeOf(ws) {
  const room = rooms.get(sessions.get(ws._id)?.roomId);
  return room && room.state === 'lobby' ? room.code : null;
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
// Analyses waiting for a free slot (one runs at a time, server-wide).
const analysisQueue = [];
function releaseAnalysis() {
  analysesRunning = Math.max(0, analysesRunning - 1);
  while (analysesRunning < MAX_ANALYSES && analysisQueue.length) {
    const q = analysisQueue.shift();
    if (rooms.has(q.roomId) && q.rec.analysis == null) { handleAnalyzeGame(q.ws, q.roomId, q.gameNo); break; }
  }
}
// The slow played-out checks run in their own line (one at a time), so a
// game's instant report never waits behind another game's checks.
let checksRunning = 0;
const checkQueue = [];
function scheduleCheck(job) {
  if (checksRunning >= MAX_ANALYSES) { checkQueue.push(job); return; }
  checksRunning++;
  job.run(() => {
    checksRunning = Math.max(0, checksRunning - 1);
    while (checkQueue.length) { const j = checkQueue.shift(); if (rooms.has(j.roomId)) { scheduleCheck(j); break; } }
  });
}
// The base play-out of a game. Timed; Go deeper requests made meanwhile wait
// for it (the base analysis comes first) and run when it ends.
const autoCheckJob = (room, rec, report) => {
  rec._basePending = true;
  return { roomId: room.id, run: done => {
    const t0 = Date.now();
    broadcast(room, { event: 'analysisPhase', game: rec.n, phase: 'playout' });
    autoCheck(room, rec, report, () => {
      done();
      rec._basePending = false;
      report.timing = { ...(report.timing ?? {}), playoutMs: Date.now() - t0 };
      broadcast(room, { event: 'analysisTiming', game: rec.n, timing: report.timing });
      for (const idx of rec._deeperQueue?.splice(0) ?? []) runDeeper(room, rec, idx);
    });
  } };
};

// Analyse every finished game of the room's match (one after another).
export function handleAnalyzeMatch(ws, roomId) {
  const room = rooms.get(roomId);
  const sess = sessions.get(ws._id);
  if (!room || !sess || sess.roomId !== roomId) return;
  for (const rec of room.records ?? []) if (rec.analysis == null) handleAnalyzeGame(ws, roomId, rec.n);
}

// A finished game's player asks for the post-game report. Every decision of
// every player is rolled out (in worker threads, so games keep running); the
// report is cached on the room and sent to everyone who asked.
export function handleAnalyzeGame(ws, roomId, gameNo) {
  const room = rooms.get(roomId);
  const rec = room && recordFor(room, gameNo);
  if (!rec) return;
  // ws = null: the server's own quick analysis of a rated game (no play-outs).
  const sess = ws ? sessions.get(ws._id) : null;
  if (ws && (!sess || sess.roomId !== roomId)) return;
  const tell = m => { if (ws) sendTo(ws, m); };

  const a = rec.analysis;
  if (a?.state === 'done') {
    if (!ws) return;
    sendTo(ws, { event: 'analysisResult', game: rec.n, report: a.result });
    // Analysed quickly for the rating: a player now wants it, so play it out.
    if (rec._checkPending) { rec._checkPending = false; scheduleCheck(autoCheckJob(room, rec, a.result)); }
    return;
  }
  if (a?.state === 'running') { if (ws) a.waiting.add(ws); return; }
  const system = !ws;

  const { game } = rec;
  finishRollRecord(game);
  const rolls = game._rolls ?? [];
  const decisions = rolls.map((r, idx) => ({ r, idx })).filter(x => !x.r.forced);
  const base = {
    players: room.slots.map((s, i) => ({ name: s.name, color: game.players[i]?.color, isRobot: !!s.isRobot })),
    winner: game.winner,
    rolls: rolls.map(({ turn, pi, dice, forced, played, options, before, steps }) =>
      ({ turn, pi, dice, forced, played, options, steps, marbles: before ? before.players.map(p => p.marbles) : null })),
    // The game's dice seed (revealed now the game is over), to verify the rolls.
    dice: game._dice ? { commit: game._dice.commit, seed: game._dice.seed } : null,
    // Cube decisions, worked out in the background (see autoCheck).
    cube: (game._cubeLog ?? []).map((c, i) => ({ i, turn: c.turn, pi: c.pi, kind: c.kind, action: c.action, doubler: c.doubler,
      rollIdx: c.rollIdx, v: c.state.cube?.value ?? 1, marbles: c.state.players.map(p => p.marbles), analysis: null, pending: true })),
  };
  const finish = report => {
    rec.analysis = { state: 'done', result: report };
    saveRecAnalysis(rec, report);
    for (const w of waiting) sendTo(w, { event: 'analysisResult', game: rec.n, report });
    ratingBonus(room, rec, report);
  };
  // Play-outs follow the quick pass, unless only the server asked (then they
  // wait until a player opens the analysis).
  const check = report => {
    if (system && !waiting.size) { rec._checkPending = true; return; }
    scheduleCheck(autoCheckJob(room, rec, report));
  };
  const waiting = new Set(ws ? [ws] : []);
  if (!decisions.length) {
    finish(base);
    if (base.cube.length) check(base);
    return;
  }
  if (analysesRunning >= MAX_ANALYSES) {
    // Wait in line (e.g. the games of a match, or another room's analysis).
    if (analysisQueue.length >= 30) {
      tell({ event: 'error', code: 'ANALYSIS_BUSY', message: 'The server is busy analysing. Try again in a minute.' });
      return;
    }
    if (!analysisQueue.some(q => q.rec === rec)) analysisQueue.push({ ws, roomId, gameNo: rec.n, rec });
    tell({ event: 'analysisQueued', game: rec.n, ahead: analysisQueue.findIndex(q => q.rec === rec) });
    return;
  }
  analysesRunning++;
  rec.analysis = { state: 'running', waiting };
  const tQuick = Date.now();

  // Split the decisions over a few workers, interleaved so each gets a mix.
  const nWorkers = Math.max(1, Math.min(config.analysisWorkers ?? 4, availableParallelism() - 1, decisions.length));
  const chunks = Array.from({ length: nWorkers }, (_, w) => decisions.filter((_, k) => k % nWorkers === w));
  const results = new Map();
  let done = 0, live = nWorkers, failed = false;
  const end = releaseAnalysis;
  const fail = err => {
    if (failed) return;
    failed = true;
    console.error('[analysis] worker failed', err);
    for (const w of workers) w.terminate();
    rec.analysis = null;
    for (const w of waiting) sendTo(w, { event: 'error', code: 'ANALYSIS_FAILED', message: 'Analysis failed.' });
    end();
  };
  const workers = chunks.map((chunk, w) => {
    const worker = new Worker(new URL('./analysisWorker.js', import.meta.url), {
      workerData: { decisions: chunk.map(({ r, idx }) => ({ idx, before: r.before, after: r.after, pi: r.pi })), options: { ...config.analysis, level: 0 },
        luck: rolls.map((r, idx) => ({ idx, before: r.before, pi: r.pi })).filter((x, k) => x.before && k % nWorkers === w) },
    });
    worker.on('message', msg => {
      if (failed) return;
      if (msg.type === 'luck') { if (base.rolls[msg.idx]) base.rolls[msg.idx].luck = msg.luck; return; }
      if (msg.type === 'item') {
        results.set(msg.idx, msg.item);
        done++;
        for (const w of waiting) sendTo(w, { event: 'analysisProgress', game: rec.n, done, total: decisions.length });
      }
      if (msg.type === 'end' && --live === 0) {
        base.rolls.forEach((r, idx) => { if (results.has(idx)) r.analysis = results.get(idx); });
        base.timing = { quickMs: Date.now() - tQuick };
        finish(base);
        end();
        check(base);
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
function autoCheck(room, rec, report, end, { level = 1, all = false } = {}) {
  const opts = config.analysisLevels[level];
  // The automatic pass plays out EVERY decision at level 1 (and the cube):
  // the instant formula judges at about robot strength, so it can neither
  // find errors the robot would also make nor be trusted with the verdicts.
  // "Play out all" (all = true) redoes every decision below `level`.
  // Questionable ones (play differs from the robot, or flagged) go first.
  const todo = report.rolls.map((r, idx) => ({ r, idx })).filter(({ r, idx }) =>
    r.analysis && !r._deepening && rec.game?._rolls?.[idx]?.after && (r.analysis.level ?? 0) < level)
    .sort((x, y) => Number(x.r.analysis.robotAgrees && x.r.analysis.severity === 'ok') - Number(y.r.analysis.robotAgrees && y.r.analysis.severity === 'ok'));
  const cubeLog = rec.game?._cubeLog ?? [];
  // Play out all: also every cube decision below the deep level (not exact,
  // not one skipped as nowhere near the doubling window).
  const cubeTodo = (report.cube ?? []).filter(c => cubeLog[c.i] && !c._deepening && (!all ||
    (c.analysis && !c.analysis.exact && !c.analysis.skip && (c.analysis.level ?? 0) < 1))).map(c => c.i);
  if (!opts || (!todo.length && !cubeTodo.length)) { end(); return; }
  for (const { r, idx } of todo) {
    Object.defineProperty(r, '_deepening', { value: true, configurable: true, enumerable: false, writable: true });
    broadcast(room, { event: 'analysisDeepening', game: rec.n, idx, level, auto: true });
  }
  const nWorkers = Math.max(1, Math.min(config.analysisWorkers ?? 4, availableParallelism() - 1, todo.length + cubeTodo.length));
  let live = nWorkers, ended = false;
  const stop = () => { if (!ended) { ended = true; for (const { r } of todo) r._deepening = false; end(); } };
  for (let w = 0; w < nWorkers; w++) {
    const chunk = todo.filter((_, k) => k % nWorkers === w);
    const worker = new Worker(new URL('./analysisWorker.js', import.meta.url), {
      workerData: { decisions: chunk.map(({ idx }) => { const raw = rec.game._rolls[idx]; return { idx, before: raw.before, after: raw.after, pi: raw.pi }; }),
        cube: cubeTodo.filter((_, k) => k % nWorkers === w).map(i => ({ i, entry: cubeLog[i] })),
        cubeGames: all ? config.cubeLevels[1] : config.cubeAnalysisGames, cubeLevel: all ? 1 : 0,
        options: { ...opts, level, ctx: rec.game?._valueCtx ?? {} } },
    });
    worker.on('message', msg => {
      if (msg.type === 'item') {
        const roll = report.rolls[msg.idx];
        roll._deepening = false;
        if (rec.analysis?.result !== report) return;      // a rematch replaced the report
        roll.analysis = msg.item;
        broadcast(room, { event: 'analysisUpdate', game: rec.n, idx: msg.idx, analysis: msg.item });
        saveRecAnalysis(rec, report);
      }
      if (msg.type === 'cube') {
        const c = report.cube?.[msg.i];
        if (!c || rec.analysis?.result !== report) return;
        c.analysis = msg.item; c.pending = false;
        broadcast(room, { event: 'cubeUpdate', game: rec.n, i: msg.i, analysis: msg.item });
        saveRecAnalysis(rec, report);
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
export function handlePlayOutAll(ws, roomId, gameNo) {
  const room = rooms.get(roomId);
  const rec = room && recordFor(room, gameNo);
  if (!rec) return;
  const sess = sessions.get(ws._id);
  if (!room || !sess || sess.roomId !== roomId || rec.analysis?.state !== 'done') return;
  if (rec._playingOutAll) return;
  rec._playingOutAll = true;
  broadcast(room, { event: 'playOutAll', game: rec.n, running: true });
  scheduleCheck({ roomId: room.id, run: done => {
    const t0 = Date.now();
    broadcast(room, { event: 'playOutAll', game: rec.n, running: true, started: true });
    autoCheck(room, rec, rec.analysis.result, () => {
      done(); rec._playingOutAll = false;
      const r = rec.analysis?.result;
      if (r) r.timing = { ...(r.timing ?? {}), playOutAllMs: Date.now() - t0 };
      broadcast(room, { event: 'playOutAll', game: rec.n, running: false, timing: r?.timing });
    }, { level: 2, all: true });
  } });
}

// ---------- Go deeper on one decision ----------

let deepensRunning = 0;
const MAX_DEEPENS = 2;                 // at once, server-wide

// A player asks for one analysed decision (report roll index) to be redone
// at the next depth. The new answer replaces the old one in the room's
// report and goes to everyone in the room.
export function handleAnalyzeDeeper(ws, roomId, idx, gameNo) {
  const room = rooms.get(roomId);
  const rec = room && recordFor(room, gameNo);
  if (!rec) return;
  const sess = sessions.get(ws._id);
  if (!room || !sess || sess.roomId !== roomId || rec.analysis?.state !== 'done') return;
  const report = rec.analysis.result;
  const roll = report.rolls?.[idx];
  const raw = rec.game?._rolls?.[idx];
  if (!roll?.analysis || !raw?.after) return;
  if (roll._deepening || rec._deeperQueue?.includes(idx)) return;
  // The base analysis comes first: wait for its play-outs to finish.
  if (rec._basePending) {
    (rec._deeperQueue ??= []).push(idx);
    broadcast(room, { event: 'analysisDeepening', game: rec.n, idx, queued: true });
    return;
  }
  if (deepensRunning >= MAX_DEEPENS) {
    sendTo(ws, { event: 'error', code: 'ANALYSIS_BUSY', message: 'The server is busy analysing. Try again in a moment.' });
    return;
  }
  runDeeper(room, rec, idx);
}
function runDeeper(room, rec, idx) {
  const report = rec.analysis?.result;
  const roll = report?.rolls?.[idx];
  const raw = rec.game?._rolls?.[idx];
  if (!roll?.analysis || !raw?.after) return;
  const level = (roll.analysis.level ?? 0) + 1;
  const opts = config.analysisLevels[level];
  if (!opts || roll._deepening) return;
  deepensRunning++;
  Object.defineProperty(roll, '_deepening', { value: true, configurable: true, enumerable: false, writable: true });
  broadcast(room, { event: 'analysisDeepening', game: rec.n, idx, level });
  const worker = new Worker(new URL('./analysisWorker.js', import.meta.url), {
    workerData: { decisions: [{ idx, before: raw.before, after: raw.after, pi: raw.pi }], options: { ...opts, level, ctx: rec.game?._valueCtx ?? {} } },
  });
  let done = false;
  const t0 = Date.now();
  const finish = (item) => {
    if (done) return;
    done = true; deepensRunning--; roll._deepening = false;
    if (item) item.ms = Date.now() - t0;
    if (item && rec.analysis?.result === report) {
      roll.analysis = item;
      broadcast(room, { event: 'analysisUpdate', game: rec.n, idx, analysis: item });
      saveRecAnalysis(rec, report);
    } else if (!item) {
      broadcast(room, { event: 'analysisUpdate', game: rec.n, idx, analysis: roll.analysis, failed: true });
    }
  };
  worker.on('message', msg => { if (msg.type === 'item') finish(msg.item); });
  worker.on('error', err => { console.error('[analysis] deeper failed', err); finish(null); });
  worker.on('exit', () => finish(null));
}

// Go deeper on one cube decision (report.cube index): more played-out games
// (cubeLevels), or — for a no-double that was skipped as nowhere near the
// window — analyse it anyway at the first level.
export function handleAnalyzeDeeperCube(ws, roomId, i, gameNo) {
  const room = rooms.get(roomId);
  const rec = room && recordFor(room, gameNo);
  if (!rec) return;
  const sess = sessions.get(ws._id);
  if (!room || !sess || sess.roomId !== roomId || rec.analysis?.state !== 'done') return;
  const report = rec.analysis.result;
  const c = report.cube?.[i];
  const entry = rec.game?._cubeLog?.[i];
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
  broadcast(room, { event: 'cubeDeepening', game: rec.n, i, level });
  const worker = new Worker(new URL('./analysisWorker.js', import.meta.url), {
    workerData: { decisions: [], cube: [{ i, entry }], cubeGames: games, cubeForce: true, cubeLevel: level, options: {} },
  });
  let done = false;
  const finish = item => {
    if (done) return;
    done = true; deepensRunning--; c._deepening = false;
    if (item && rec.analysis?.result === report) { c.analysis = item; saveRecAnalysis(rec, report); }
    broadcast(room, { event: 'cubeUpdate', game: rec.n, i, analysis: c.analysis, failed: !item });
  };
  worker.on('message', msg => { if (msg.type === 'cube') finish(msg.item); });
  worker.on('error', err => { console.error('[analysis] cube deeper failed', err); finish(null); });
  worker.on('exit', () => finish(null));
}

// For unit testing only — resets all module-level state between test cases.
export function _reset() {
  rooms.clear();
  sessions.clear();
  // Analysis lines: leftovers from earlier tests mustn't hold the slots.
  analysisQueue.length = 0; checkQueue.length = 0;
  analysesRunning = 0; checksRunning = 0;
}

// For unit testing only — exposes a room (and its live game) for state setup.
export function _getRoom(roomId) {
  return rooms.get(roomId);
}
