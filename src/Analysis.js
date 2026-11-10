// Analysis.js — move feedback and post-game analysis.
//
// Instant feedback (moveFeedback): after a player commits a roll, compare
// their play with what the robot would have played from the same position
// and dice, and — near home — with the exact endgame table.
//
// Post-game analysis (analyzeDecision): for one recorded decision, roll out
// the plausible ways of playing it (every player uses the robot's strategy
// afterwards) and compare win rates. Runs in a worker thread (see
// analysisWorker.js), because it takes seconds per decision.
import { allLegalMoves, applyMove, earnsExtraRoll, rollDice, lossMultiple } from './GameEngine.js';
import { met } from './MatchEquity.js';
import { pickNextRobotMove } from './RobotPlayer.js';
import { lookup, expectedTurns, finishedBy } from './EndgameTable.js';
import { locName, armOf } from '../public/js/constants.js';
import { duelWinChance } from './DuelTable.js';
import { evaluate1 } from './Evaluator.js';

// ---- Positions and notation -------------------------------------------------

// Internal key for a location (not shown to players).
const locStr = l => l.zone === 'track' ? `t${l.space}` : l.zone === 'home' ? `h${l.slot}`
  : l.zone === 'center' ? 'hub' : 'base';
// One player's marbles, ignoring which same-coloured marble is which.
export const positionKey = (game, pi) => game.players[pi].marbles.map(locStr).sort().join(' ');
// The whole board (so plays that bump different opponents differ).
const boardKey = (game, pi) => positionKey(game, pi) + '|' + game.players.map((_, i) => positionKey(game, i)).join('/');

// Moves in the move-log notation: "79/84 65/70", consecutive moves of one
// marble joined ("8/39/h1"). Each entry: { marbleId, from, to } (locations).
// The player's arm (their numbering: countdown to their home entry).
const armOfPlayer = (game, pi) => armOf(game.players[pi].config);

// Moves in the move-log notation, in the mover's numbers (see constants.js
// countdown): "30/25 12/9", consecutive moves of one marble joined ("8/5/1").
export function notation(moves, arm = 0) {
  const nm = l => locName(l, arm);
  const parts = [];
  for (const m of moves) {
    const last = parts[parts.length - 1];
    const to = nm(m.to) + (m.bump ? '*' : '');   // * = bumped an opponent, as in the move log
    if (last && last.marbleId === m.marbleId && last.end === locStr(m.from)) {
      last.path.push(to);
    } else {
      parts.push({ marbleId: m.marbleId, path: [nm(m.from), to] });
    }
    parts[parts.length - 1].end = locStr(m.to);
  }
  return parts.length ? parts.map(p => p.path.join('/')).join(' ') : '--';
}

const destOf = mv => mv.toZone === 'home' ? { zone: 'home', slot: mv.toSlot }
  : mv.toZone === 'center' ? { zone: 'center' } : { zone: 'track', space: mv.toSpace };
const fromOf = m => m.zone === 'track' ? { zone: 'track', space: m.space }
  : m.zone === 'home' ? { zone: 'home', slot: m.slot } : { zone: m.zone };

function applyRecorded(game, pi, mv, record) {
  const to = destOf(mv);
  const bump = (to.zone === 'track' || to.zone === 'center') && game.players.some((p, o) => o !== pi &&
    p.marbles.some(m => m.zone === to.zone && (to.zone === 'center' || m.space === to.space)));
  record.push({ marbleId: mv.marbleId, from: fromOf(game.players[pi].marbles[mv.marbleId]), to, bump, die: game.dice?.[mv.dieIndex] });
  Object.defineProperty(record[record.length - 1], 'mv', { value: mv, enumerable: false }); // the engine move (not sent to clients)
  applyMove(game, pi, mv);
}

// ---- Enumerating plays -------------------------------------------------------

const realMoves = (g, pi, d) => (allLegalMoves(g, pi)[d] ?? []).filter(m => !m.optional);

// The choices for one die: every legal move, plus skipping the die when it
// has no move or only optional ones (passing your own home is never forced).
// null = skip.
function dieChoices(g, pi, d) {
  if (g.winner != null || g.diceUsed[d]) return [];
  const moves = allLegalMoves(g, pi)[d] ?? [];
  return moves.every(m => m.optional) ? [...moves, null] : moves;
}

// Every distinct way to play the roll in `game` (dice set, none used):
// [{ game, moves, key }], deduplicated by resulting board. Optional moves
// count (a player may choose to go round, e.g. to hit), and so does skipping
// a die whose moves are all optional.
export function allPlays(game, pi) {
  const out = new Map();
  const add = (g, moves) => { const key = boardKey(g, pi); if (!out.has(key)) out.set(key, { game: g, moves, key }); };
  const play = (g, d, mv, rec) => {
    const g2 = structuredClone(g), r2 = rec.slice();
    if (mv) applyRecorded(g2, pi, mv, r2); else g2.diceUsed[d] = true;
    return [g2, r2];
  };
  for (const d of [0, 1]) {
    // A die with no move at all can't be given up first while the other die
    // is unplayed: playing that one may open a move for it (hub/7 then 7/4).
    // The other order covers it (the die is skipped second if still stuck).
    if (!(allLegalMoves(game, pi)[d] ?? []).length && (allLegalMoves(game, pi)[1 - d] ?? []).length) continue;
    for (const m1 of dieChoices(game, pi, d)) {
      const [g1, rec1] = play(game, d, m1, []);
      const second = dieChoices(g1, pi, 1 - d);
      if (!second.length) { add(g1, rec1); continue; }
      for (const m2 of second) {
        const [g2, rec2] = play(g1, 1 - d, m2, rec1);
        add(g2, rec2);
      }
    }
  }
  if (!out.size) add(structuredClone(game), []);
  return [...out.values()];
}

// What the robot plays with this roll: { game, moves, key }.
export function robotPlay(game, pi) {
  const g = structuredClone(game), moves = [];
  for (let k = 0; k < 2 && g.winner == null && !(g.diceUsed[0] && g.diceUsed[1]); k++) {
    const mv = pickNextRobotMove(g, pi);
    if (!mv) { g.diceUsed[g.diceUsed[0] ? 1 : 0] = true; continue; }
    applyRecorded(g, pi, mv, moves);
  }
  return { game: g, moves, key: boardKey(g, pi) };
}

// ---- Instant feedback ---------------------------------------------------------

// Exact race value (expected turns still to play) after a roll, or null when
// the player isn't within the endgame table's region.
function raceTurns(g, pi, six) {
  const e = lookup(g.players[pi]);
  if (!e) return null;
  return expectedTurns(e) === 0 ? 0 : six ? expectedTurns(e) - 1 : expectedTurns(e);
}

// `before`: the game as it was right after the roll (dice set, nothing used).
// `after`:  the game after the player's moves. Returns { forced: true } when
// there was only one way to play the roll (optional go-arounds don't count),
// otherwise:
//   { forced: false, robotAgrees, robotMoves, endgame: null | { best, cost, bestMoves } }
export function moveFeedback(before, after, pi) {
  const plays = allPlays(before, pi);
  if (plays.length < 2) return { forced: true };
  const playedKey = boardKey(after, pi);
  const robot = robotPlay(before, pi);
  const result = { forced: false, robotAgrees: robot.key === playedKey, robotMoves: notation(robot.moves, armOfPlayer(before, pi)), endgame: null };
  if (lookup(before.players[pi])) {
    const six = before.dice.includes(6);
    const scored = plays.map(p => ({ p, t: raceTurns(p.game, pi, six) })).filter(x => x.t != null);
    const mine = scored.find(x => x.p.key === playedKey);
    if (mine && scored.length > 1) {
      const best = scored.reduce((a, b) => (b.t < a.t ? b : a));
      const cost = mine.t - best.t;
      result.endgame = { best: cost < 0.005, cost: Math.round(cost * 100) / 100, bestMoves: notation(best.p.moves, armOfPlayer(before, pi)) };
    }
  }
  return result;
}

// ---- Recording rolls ----------------------------------------------------------

// What a roll was, for the post-game report: whether there was a choice and
// what was played. `before` is the game right after the roll, `after` the game
// once the roll was played.
export function describeRoll(before, after, pi) {
  const plays = allPlays(before, pi);
  const key = boardKey(after, pi);
  const mine = plays.find(p => p.key === key);
  return { forced: plays.length < 2, played: mine ? notation(mine.moves, armOfPlayer(before, pi)) : '?', options: plays.length, steps: mine ? mine.moves : [] };
}

// ---- Post-game rollouts -------------------------------------------------------
//
// Options are compared with common random numbers: playout i of every option
// uses the same dice stream (seed i), so the luck of the dice cancels out of
// the comparison and only the difference the play makes is left. That makes
// the difference between two options far less noisy than either win rate.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- What a game's ending is worth ------------------------------------------
//
// Play-outs are scored by what the ending is worth to the mover, on a 0–1
// "win-like" scale u, so a difference of x in u is 2x in equity (like a
// win-chance difference was before):
//   money (2 players): equity ±1/±2/±3 for a single / aggro / baggro
//   match: match-winning chances after the result at this score and cube,
//     in game units (EMG); u = (MWC − MWC of losing a single) / (spread)
//   3+ players: u = 1 for a win, 0 otherwise (the plain win chance)
// ctx: { match: { length, score, crawfordUsed } } (the game's start).
export function outcomeValuer(before, pi, ctx = {}) {
  if (before.players.length !== 2) return g => (g.winner === pi ? 1 : 0);
  const v = before.cube?.value ?? 1;
  const multOf = g => lossMultiple(g.players[1 - g.winner]);
  const m = ctx.match;
  if (!m) return g => { const e = (g.winner === pi ? 1 : -1) * multOf(g); return (e + 1) / 2; };
  const a = m.length - m.score[pi], b = m.length - m.score[1 - pi], cu = !!m.crawfordUsed;
  const w1 = met(a - v, b, cu), l1 = met(a, b - v, cu), spread = w1 - l1;
  if (!(spread > 1e-9)) return g => (g.winner === pi ? 1 : 0);
  return g => {
    const pts = v * multOf(g);
    const x = g.winner === pi ? met(a - pts, b, cu) : met(a, b - pts, cu);
    return (x - l1) / spread;
  };
}

// Play out from just after `pi` played a roll of `dice`; returns the finished game.
function playout(g, pi, dice) {
  let turn = earnsExtraRoll(dice) ? pi : (pi + 1) % g.players.length;
  for (let t = 0; t < 4000 && g.winner == null; t++) {
    let again = true;
    while (again && g.winner == null) {
      g.dice = rollDice(); g.diceUsed = [false, false]; g.phase = 'AWAITING_MOVE';
      while (!(g.diceUsed[0] && g.diceUsed[1]) && g.winner == null) {
        const mv = pickNextRobotMove(g, turn);
        if (mv) applyMove(g, turn, mv); else g.diceUsed[g.diceUsed[0] ? 1 : 0] = true;
      }
      again = earnsExtraRoll(g.dice);
    }
    turn = (turn + 1) % g.players.length;
  }
  return g;
}

// Outcomes of n playouts using seeds seed0 … seed0+n-1: the value of each
// ending (valuer; default 1 = pi won), with .w = 1/0 for won or not.
export function outcomes(g, pi, dice, n, seed0, valuer = null) {
  const out = new Float64Array(n), w = new Uint8Array(n);
  const saved = Math.random;
  try {
    for (let i = 0; i < n; i++) {
      Math.random = mulberry32(seed0 + i * 7919);
      const end = playout(structuredClone(g), pi, dice);
      w[i] = end.winner === pi ? 1 : 0;
      out[i] = valuer ? valuer(end) : w[i];
    }
  } finally { Math.random = saved; }
  out.w = w;
  return out;
}
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
// Standard error of mean(a − b) for paired samples.
export function pairedSE(a, b) {
  const n = a.length; let s = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const d = a[i] - b[i]; s += d; s2 += d * d; }
  const m = s / n;
  return Math.sqrt(Math.max(s2 / n - m * m, 0) / Math.max(n - 1, 1));
}

// Severity of a loss in win-rate points (0–1 scale), when it is real.
// Two levels, as in backgammon tools: error (?) and blunder (??).
export const SEVERITY = [
  { key: 'blunder', min: 0.10 },
  { key: 'error', min: 0.03 },
];
export function severityOf(loss, significant) {
  if (!significant) return 'ok';
  return SEVERITY.find(s => loss >= s.min)?.key ?? 'ok';
}

const marblesOf = g => g.players.map(p => p.marbles.map(m => ({ ...m })));

// ---- Instant analysis (the position evaluator) -------------------------------
//
// Every way to play the roll is scored by the evaluator at 1-ply
// (src/Evaluator.js evaluate1): the formula averaged over the next player's
// rolls, with the robot's reply.
// No dice are rolled, so there is no noise (se = 0) — but it is a formula's
// estimate, not a played-out result; "Go deeper" checks it with rollouts.
export function evaluateDecision({ before, after, pi }, { keep = 3 } = {}) {
  const plays = allPlays(before, pi);
  const playedKey = boardKey(after, pi);
  const robotKey = robotPlay(before, pi).key;
  const next = earnsExtraRoll(before.dice) ? pi : (pi + 1) % before.players.length;
  const cands = plays.map(p => ({ p, win: evaluate1(p.game, next)?.[pi] ?? 0 }));
  cands.sort((a, b) => b.win - a.win);
  const best = cands[0];
  const mine = cands.find(c => c.p.key === playedKey) ?? null;
  const shown = cands.slice(0, keep);
  for (const k of [playedKey, robotKey]) {
    const c = cands.find(x => x.p.key === k);
    if (c && !shown.includes(c)) shown.push(c);
  }
  const loss = mine ? Math.max(0, best.win - mine.win) : 0;
  const severity = severityOf(loss, !!mine && mine !== best);
  return {
    played: mine ? notation(mine.p.moves, armOfPlayer(before, pi)) : '?',
    playedWin: mine ? mine.win : null,
    best: notation(best.p.moves, armOfPlayer(before, pi)),
    bestWin: best.win,
    loss: Math.round(loss * 1000) / 1000,
    se: 0,
    severity,
    mistake: severity !== 'ok',
    robotAgrees: playedKey === robotKey,
    estimate: true,
    options: shown.map(c => ({
      moves: notation(c.p.moves, armOfPlayer(before, pi)), win: c.win, n: 0, loss: Math.round(Math.max(0, best.win - c.win) * 1000) / 1000,
      played: c === mine, robot: c.p.key === robotKey, marbles: marblesOf(c.p.game), steps: c.p.moves,
      facts: positionFacts(c.p.game, pi),
    })),
    before: (({ race, duel }) => ({ race, duel }))(positionFacts({ ...before, dice: null }, pi)),
  };
}

// ---- Position facts: hit chances and race odds -------------------------------
//
// Exact, not sampled. For the position after a play by `pi`:
//   hits: every marble of pi's an opponent could bump with their next roll
//         (all 36 dice outcomes, every way to play each), with the rolls that do
//         it; anyHit = chance that at least one of them gets bumped. Each
//         opponent's next roll is counted separately (in 3+ player games the
//         chances are combined as if independent). An extra roll after a 6 is
//         not counted.
//   race: for each player within the endgame table's region, the chance to
//         finish on their next turn and the expected turns to finish.
const DICE = [];
for (let a = 6; a >= 1; a--) for (let b = a; b >= 1; b--) DICE.push({ d: [a, b], w: a === b ? 1 : 2 });

// "any 5, 4-1, 3-2": faces whose every combination hits, then the rest.
function rollsText(hitting) {
  const set = new Set(hitting.map(d => d.join('-')));
  const anyFace = [6, 5, 4, 3, 2, 1].filter(f => DICE.every(({ d }) => !d.includes(f) || set.has(d.join('-'))));
  const rest = hitting.filter(d => !anyFace.some(f => d.includes(f))).map(d => d.join('-'));
  return [...anyFace.map(f => `any ${f}`), ...rest].join(', ');
}

export function positionFacts(game, pi) {
  const mine = game.players[pi].marbles;
  const exposed = mine.map((m, id) => ({ m, id })).filter(({ m }) => m.zone === 'track' || m.zone === 'center');
  const perMarble = new Map(exposed.map(({ id }) => [id, { p: 0, byOpp: [], miss: 1 }]));
  let anyMiss = 1;
  game.players.forEach((_, o) => {
    if (o === pi || !exposed.length || game.winner != null) return;
    let any = 0;
    const local = new Map(exposed.map(({ id }) => [id, { w: 0, rolls: [] }]));
    for (const { d, w } of DICE) {
      const g = structuredClone(game);
      g.turnIndex = o; g.dice = d.slice(); g.diceUsed = [false, false]; g.phase = 'AWAITING_MOVE';
      const hit = new Set();
      for (const play of allPlays(g, o)) {
        play.game.players[pi].marbles.forEach((m, id) => { if (perMarble.has(id) && m.zone === 'base') hit.add(id); });
      }
      if (hit.size) any += w;
      for (const id of hit) { local.get(id).w += w; local.get(id).rolls.push(d); }
    }
    anyMiss *= 1 - any / 36;
    for (const [id, l] of local) {
      const pm = perMarble.get(id);
      pm.miss *= 1 - l.w / 36;
      if (l.w) pm.byOpp.push({ opp: o, rolls: rollsText(l.rolls) });   // the page adds the opponent's name
    }
  });
  const hits = exposed.map(({ m, id }) => {
    const pm = perMarble.get(id);
    return { id, at: locName(m, armOfPlayer(game, pi)), p: 1 - pm.miss, rolls: pm.byOpp.map(x => x.rolls).join('; '), byOpp: pm.byOpp };
  }).filter(h => h.p > 0);
  const race = [];
  game.players.forEach((p, i) => {
    const e = lookup(p);
    if (e && expectedTurns(e) > 0) race.push({ pi: i, next: finishedBy(e, 1), turns: expectedTurns(e) });
  });
  // Two-player last-marble duel: the exact chance to win with perfect play.
  const next = game.dice && earnsExtraRoll(game.dice) ? pi : (pi + 1) % game.players.length;
  const duel = duelWinChance(game, pi, next);
  return { anyHit: 1 - anyMiss, hits, race, duel };
}

// Analyse one decision: screen every option with a few playouts, then roll
// out the most promising few plus the played option in depth, all on the same
// dice streams.
//   decision: { before (game after the roll), after (game after the play), pi }
// Returns { played, playedWin, best, bestWin, loss, se, severity, mistake,
//           robotAgrees, options: [{ moves, win, loss, played, robot, marbles }] }.
export function analyzeDecision({ before, after, pi }, { screen = 60, deep = 400, keep = 3, maxDeep = 1600, seed = 1, mode = 'rollout', screenBy = 'rollout', ctx = {} } = {}) {
  if (mode === 'eval') return evaluateDecision({ before, after, pi }, { keep });
  const val = outcomeValuer(before, pi, ctx);
  const winRate = r => (r.w?.length ? mean(r.w) : null);
  const plays = allPlays(before, pi);
  const playedKey = boardKey(after, pi);
  const robotKey = robotPlay(before, pi).key;
  const dice = before.dice;
  // Screen every option: with a few playouts each, or (screenBy 'eval') by
  // the 1-ply evaluator, which costs no playouts at all.
  let cands;
  if (screenBy === 'eval') {
    const next = earnsExtraRoll(dice) ? pi : (pi + 1) % before.players.length;
    cands = plays.map(p => ({ p, res: new Uint8Array(0), win: evaluate1(p.game, next)?.[pi] ?? 0 }));
  } else {
    const nScreen = plays.length > 12 ? Math.ceil(screen / 2) : screen;   // many options: cheaper screen
    cands = plays.map(p => ({ p, res: outcomes(p.game, pi, dice, nScreen, seed, val) }));
    for (const c of cands) c.win = mean(c.res);
  }
  cands.sort((a, b) => b.win - a.win);
  const finalists = cands.slice(0, keep);
  for (const k of [playedKey, robotKey]) {
    const c = cands.find(x => x.p.key === k);
    if (c && !finalists.includes(c)) finalists.push(c);
  }
  for (const c of finalists) { c.res = outcomes(c.p.game, pi, dice, deep, seed + 1_000_003, val); c.win = mean(c.res); }
  finalists.sort((a, b) => b.win - a.win);
  let best = finalists[0];
  const mine = finalists.find(c => c.p.key === playedKey) ?? null;
  // A loss that may be real but isn't clear yet: give the finalists more
  // playouts (same new seeds for all) until it is clear or the budget runs out.
  const grow = c => {
    const n = c.res.length;
    const more = outcomes(c.p.game, pi, dice, n, seed + 1_000_003 + n * 7919, val);
    const r = new Float64Array(2 * n); r.set(c.res); r.set(more, n);
    const w = new Uint8Array(2 * n); w.set(c.res.w); w.set(more.w, n); r.w = w;
    c.res = r; c.win = mean(r);
  };
  const unclear = () => mine && mine !== best && best.win - mine.win >= SEVERITY.at(-1).min
    && best.win - mine.win <= 1.96 * pairedSE(best.res, mine.res);
  while (unclear() && best.res.length < maxDeep) {
    for (const c of finalists) grow(c);          // all of them: same dice, same sample size
    finalists.sort((x, y) => y.win - x.win);
    best = finalists[0];
  }
  const loss = mine ? Math.max(0, best.win - mine.win) : 0;
  const se = mine && mine !== best ? pairedSE(best.res, mine.res) : 0;
  const significant = !!mine && mine !== best && loss > 1.96 * se;
  const severity = severityOf(loss, significant);
  return {
    played: mine ? notation(mine.p.moves, armOfPlayer(before, pi)) : '?',
    // Win chances (for the chart and display); the ranking and loss use the
    // value of the endings (eq = equity of each option, in game units).
    playedWin: mine ? winRate(mine.res) : null,
    best: notation(best.p.moves, armOfPlayer(before, pi)),
    bestWin: winRate(best.res),
    valued: ctx.match ? 'match' : before.players.length === 2 ? 'money' : 'win',
    loss: Math.round(loss * 1000) / 1000,
    se: Math.round(se * 1000) / 1000,
    severity,
    mistake: severity !== 'ok',
    robotAgrees: playedKey === robotKey,
    options: finalists.map(c => ({
      moves: notation(c.p.moves, armOfPlayer(before, pi)), win: winRate(c.res), eq: Math.round((2 * c.win - 1) * 1000) / 1000, n: c.res.length,
      loss: Math.round(Math.max(0, best.win - c.win) * 1000) / 1000,
      played: c === mine, robot: c.p.key === robotKey, marbles: marblesOf(c.p.game), steps: c.p.moves,
      facts: positionFacts(c.p.game, pi),
    })),
    before: (({ race, duel }) => ({ race, duel }))(positionFacts({ ...before, dice: null }, pi)),
  };
}
