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
import { racePips, dangerPips } from './RobotPlayer.js';
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

let weights = null;
function loadWeights() {
  if (weights) return weights;
  const file = new URL('./evaluator-weights.json', import.meta.url);
  weights = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).weights : null;
  return weights;
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
  const w = loadWeights();
  if (!w) return null;
  return softmax(game.players.map((_, i) => {
    const f = playerFeatures(game, i, mover);
    return f.reduce((s, x, k) => s + x * w[k], 0);
  }));
}
