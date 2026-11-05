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
import { allLegalMoves, applyMove, earnsExtraRoll, rollDice } from './GameEngine.js';
import { pickNextRobotMove } from './RobotPlayer.js';
import { lookup, expectedTurns } from './EndgameTable.js';

// ---- Positions and notation -------------------------------------------------

const locStr = l => l.zone === 'track' ? String(l.space) : l.zone === 'home' ? `h${l.slot}`
  : l.zone === 'center' ? 'hub' : 'base';
// One player's marbles, ignoring which same-coloured marble is which.
export const positionKey = (game, pi) => game.players[pi].marbles.map(locStr).sort().join(' ');
// The whole board (so plays that bump different opponents differ).
const boardKey = (game, pi) => positionKey(game, pi) + '|' + game.players.map((_, i) => positionKey(game, i)).join('/');

// Moves in the move-log notation: "79/84 65/70", consecutive moves of one
// marble joined ("8/39/h1"). Each entry: { marbleId, from, to } (locations).
export function notation(moves) {
  const parts = [];
  for (const m of moves) {
    const last = parts[parts.length - 1];
    if (last && last.marbleId === m.marbleId && last.path[last.path.length - 1] === locStr(m.from)) {
      last.path.push(locStr(m.to));
    } else {
      parts.push({ marbleId: m.marbleId, path: [locStr(m.from), locStr(m.to)] });
    }
  }
  return parts.length ? parts.map(p => p.path.join('/')).join(' ') : '--';
}

const destOf = mv => mv.toZone === 'home' ? { zone: 'home', slot: mv.toSlot }
  : mv.toZone === 'center' ? { zone: 'center' } : { zone: 'track', space: mv.toSpace };
const fromOf = m => m.zone === 'track' ? { zone: 'track', space: m.space }
  : m.zone === 'home' ? { zone: 'home', slot: m.slot } : { zone: m.zone };

function applyRecorded(game, pi, mv, record) {
  record.push({ marbleId: mv.marbleId, from: fromOf(game.players[pi].marbles[mv.marbleId]), to: destOf(mv) });
  applyMove(game, pi, mv);
}

// ---- Enumerating plays -------------------------------------------------------

const realMoves = (g, pi, d) => (allLegalMoves(g, pi)[d] ?? []).filter(m => !m.optional);

// Every distinct way to play the roll in `game` (dice set, none used):
// [{ game, moves, key }], deduplicated by resulting board.
export function allPlays(game, pi) {
  const out = new Map();
  const add = (g, moves) => { const key = boardKey(g, pi); if (!out.has(key)) out.set(key, { game: g, moves, key }); };
  for (const d of [0, 1]) {
    for (const m1 of realMoves(game, pi, d)) {
      const g1 = structuredClone(game), rec1 = [];
      applyRecorded(g1, pi, m1, rec1);
      const second = g1.winner != null ? [] : realMoves(g1, pi, 1 - d);
      if (!second.length) { add(g1, rec1); continue; }
      for (const m2 of second) {
        const g2 = structuredClone(g1), rec2 = rec1.slice();
        applyRecorded(g2, pi, m2, rec2);
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
// `after`:  the game after the player's moves. Returns null when the roll
// left no real choice, otherwise:
//   { robotAgrees, robotMoves, endgame: null | { best, cost, bestMoves } }
export function moveFeedback(before, after, pi) {
  const plays = allPlays(before, pi);
  if (plays.length < 2) return null;                 // forced
  const playedKey = boardKey(after, pi);
  const robot = robotPlay(before, pi);
  const result = { robotAgrees: robot.key === playedKey, robotMoves: notation(robot.moves), endgame: null };
  if (lookup(before.players[pi])) {
    const six = before.dice.includes(6);
    const scored = plays.map(p => ({ p, t: raceTurns(p.game, pi, six) })).filter(x => x.t != null);
    const mine = scored.find(x => x.p.key === playedKey);
    if (mine && scored.length > 1) {
      const best = scored.reduce((a, b) => (b.t < a.t ? b : a));
      const cost = mine.t - best.t;
      result.endgame = { best: cost < 0.005, cost: Math.round(cost * 100) / 100, bestMoves: notation(best.p.moves) };
    }
  }
  return result;
}

// ---- Post-game rollouts -------------------------------------------------------

// Play out from just after `pi` played a roll of `dice`; returns the winner.
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
  return g.winner;
}
function winRate(g, pi, dice, n) {
  let w = 0;
  for (let i = 0; i < n; i++) if (playout(structuredClone(g), pi, dice) === pi) w++;
  return w / n;
}
const halfWidth = (p, n) => 1.96 * Math.sqrt(Math.max(p * (1 - p), 0.0025) / n);

// Analyse one decision: screen every option with a few playouts, then roll
// out the most promising few plus the played option in depth.
//   decision: { before (game after the roll), after (game after the play), pi }
// Returns { played, playedWin, best, bestWin, loss, mistake, options }.
export function analyzeDecision({ before, after, pi }, { screen = 40, deep = 300, keep = 3 } = {}) {
  const plays = allPlays(before, pi);
  const playedKey = boardKey(after, pi);
  const dice = before.dice;
  let cands = plays.map(p => ({ p, win: winRate(p.game, pi, dice, screen), n: screen }));
  cands.sort((a, b) => b.win - a.win);
  const finalists = cands.slice(0, keep);
  const played = cands.find(c => c.p.key === playedKey);
  if (played && !finalists.includes(played)) finalists.push(played);
  for (const c of finalists) { c.win = winRate(c.p.game, pi, dice, deep); c.n = deep; }
  finalists.sort((a, b) => b.win - a.win);
  const best = finalists[0];
  const mine = played ?? null;
  const loss = mine ? best.win - mine.win : 0;
  const mistake = !!mine && loss > halfWidth(best.win, best.n) + halfWidth(mine.win, mine.n);
  return {
    played: mine ? notation(mine.p.moves) : '?',
    playedWin: mine ? mine.win : null,
    best: notation(best.p.moves),
    bestWin: best.win,
    loss: Math.round(loss * 1000) / 1000,
    mistake,
    options: finalists.map(c => ({ moves: notation(c.p.moves), win: c.win, played: c === mine })),
  };
}
