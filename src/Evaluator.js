// Evaluator.js — instant estimate of each player's chance to win a position
// (the "0-ply" evaluator behind the quick analysis; see tools/train-evaluator.mjs).
//
// Each player gets a score s = w · features, and the chances are a softmax
// over the players: P(i) = exp(s_i) / Σ exp(s_j). Features per player:
//   race      — the robot's distance-to-home estimate over their marbles
//   √race     — so a lead counts for more as the race gets shorter
//   base      — marbles still in base
//   home      — marbles home
//   danger    — expected pips lost to a hit before their next turn
//   toMove    — 1 for the player about to roll
// The weights are fitted to the winners of self-play games
// (src/evaluator-weights.json). Two-player positions an exact duel table
// covers use the exact value instead.
import { readFileSync, existsSync } from 'fs';
import { racePips, dangerPips, pickNextRobotMove } from './RobotPlayer.js';
import { applyMove, skipDie, earnsExtraRoll } from './GameEngine.js';
import { duelWinChance } from './DuelTable.js';

export const FEATURES = ['race', 'sqrtRace', 'base', 'home', 'danger', 'toMove'];

export function playerFeatures(game, i, mover) {
  const p = game.players[i];
  const race = racePips(game, i);
  return [
    race / 100,
    Math.sqrt(race) / 10,
    p.marbles.filter(m => m.zone === 'base').length,
    p.marbles.filter(m => m.zone === 'home').length,
    i === mover ? 0 : dangerPips(game, i) / 100,      // the mover can't be hit before moving
    i === mover ? 1 : 0,
  ];
}

// Weights: shared, plus (where fitted) separate ones per number of players —
// races and danger weigh differently at a crowded table.
let weightsFile = null;
function loadWeights(n) {
  if (!weightsFile) {
    const file = new URL('./evaluator-weights.json', import.meta.url);
    weightsFile = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  }
  return weightsFile.byPlayers?.[n] ?? weightsFile.weights ?? null;
}

export function softmax(scores) {
  const mx = Math.max(...scores);
  const e = scores.map(s => Math.exp(s - mx));
  const z = e.reduce((a, b) => a + b, 0);
  return e.map(x => x / z);
}

// Chances to win for every player, with `mover` about to roll. Exact for a
// covered two-player duel; null if no weights have been trained.
export function evaluate(game, mover) {
  if (game.winner != null) return game.players.map((_, i) => (i === game.winner ? 1 : 0));
  if (game.players.length === 2) {
    const p0 = duelWinChance(game, 0, mover);
    if (p0 != null) return [p0, 1 - p0];
  }
  const w = loadWeights(game.players.length);
  if (!w) return null;
  return softmax(game.players.map((_, i) => {
    const f = playerFeatures(game, i, mover);
    return f.reduce((s, x, k) => s + x * w[k], 0);
  }));
}

// 1-ply: average the evaluation over every roll `mover` can make (21 outcomes,
// doubles weighted 1/36, others 2/36), with `mover` playing the robot's reply.
// Slower than evaluate() (~21 robot plays) but sees the next roll's threats
// and races.
const ROLLS = [];
for (let a = 6; a >= 1; a--) for (let b = a; b >= 1; b--) ROLLS.push({ d: [a, b], w: a === b ? 1 / 36 : 2 / 36 });
// The chances after `mover` plays roll d (the robot's play) from `game`.
function afterRoll(game, mover, d) {
  const n = game.players.length;
  const g = structuredClone(game);
  g.turnIndex = mover; g.dice = d.slice(); g.diceUsed = [false, false]; g.phase = 'AWAITING_MOVE';
  while (!(g.diceUsed[0] && g.diceUsed[1]) && g.winner == null) {
    const mv = pickNextRobotMove(g, mover);
    if (mv) applyMove(g, mover, mv); else skipDie(g, g.diceUsed[0] ? 1 : 0);
  }
  const next = earnsExtraRoll(d) ? mover : (mover + 1) % n;
  return evaluate(g, next) ?? new Array(n).fill(1 / n);
}
export function evaluate1(game, mover) {
  if (game.winner != null) return evaluate(game, mover);
  const n = game.players.length;
  const acc = new Array(n).fill(0);
  for (const { d, w } of ROLLS) {
    const p = afterRoll(game, mover, d);
    for (let i = 0; i < n; i++) acc[i] += w * p[i];
  }
  return acc;
}
// Luck of a roll: how much the roll `mover` got was worth compared with an
// average roll from the same position (both played the robot's way), in
// equity (2 × win chance). `game` is the position with the roll's dice set.
export function rollLuck(game, mover) {
  if (!game?.dice) return null;
  const start = { ...game, dice: null, diceUsed: [false, false], phase: 'IN_TURN' };
  const avg = evaluate1(start, mover)?.[mover];
  const got = afterRoll(start, mover, game.dice)?.[mover];
  return avg == null || got == null ? null : Math.round(2 * (got - avg) * 1000) / 1000;
}
