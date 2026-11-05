#!/usr/bin/env node
// Self-play: pit a candidate robot against a baseline robot to see whether a
// change to RobotPlayer.js actually makes it stronger.
//
// Usage:
//   node tools/selfplay.mjs <candidate.js> [--baseline <module>] [--games N] [--players P]
//
//   candidate   robot module to test (must export pickNextRobotMove). To test
//               a change, copy src/RobotPlayer.js somewhere, edit it, and fix
//               its './GameEngine.js' import to point at src/GameEngine.js.
//   --baseline  robot to play against (default: src/RobotPlayer.js)
//   --games     number of games (default 4000)
//   --players   2–6 (default 2). One candidate seat, the rest are baseline.
//
// The candidate's seat and the first player rotate every game, so neither has
// a positional advantage. "Even" is 1/players; the ± is a 95% interval.
// Example: a candidate winning 52.3% ± 0.8% of 2-player games is better.
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { createGame, applyMove, earnsExtraRoll, rollDice } from '../src/GameEngine.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i === -1 ? def : args[i + 1]; };
const candidatePath = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!candidatePath) {
  console.error('usage: node tools/selfplay.mjs <candidate.js> [--baseline <module>] [--games N] [--players P]');
  process.exit(2);
}
const load = async p => (await import(pathToFileURL(resolve(p)).href)).pickNextRobotMove;
const candidate = await load(candidatePath);
const baselinePath = opt('--baseline', null);
const baseline = baselinePath ? await load(baselinePath)
  : (await import(new URL('../src/RobotPlayer.js', import.meta.url).href)).pickNextRobotMove;
const N = +opt('--games', 4000);
const P = +opt('--players', 2);
if (!(P >= 2 && P <= 6)) { console.error('--players must be 2–6'); process.exit(2); }

let wins = 0, rolls = 0;
for (let g = 0; g < N; g++) {
  const seat  = g % P;
  const first = Math.floor(g / P) % P;
  const game = createGame(Array.from({ length: P }, (_, i) => ({ name: 'p' + i })), undefined, first);
  for (let t = 0; t < 5000 && game.winner == null; t++) {
    const pi = game.turnIndex;
    const pick = pi === seat ? candidate : baseline;
    let again = true;
    while (again && game.winner == null) {
      game.dice = rollDice(); game.diceUsed = [false, false]; game.phase = 'AWAITING_MOVE';
      rolls++;
      while (!(game.diceUsed[0] && game.diceUsed[1]) && game.winner == null) {
        const mv = pick(game, pi);
        if (mv) applyMove(game, pi, mv);
        else game.diceUsed[game.diceUsed[0] ? 1 : 0] = true;
      }
      again = earnsExtraRoll(game.dice);
    }
    game.turnIndex = (pi + 1) % P;
  }
  if (game.winner === seat) wins++;
}
const p = wins / N;
const ci = 196 * Math.sqrt(p * (1 - p) / N);
console.log(`${N} ${P}-player games: candidate won ${(100 * p).toFixed(1)}% ± ${ci.toFixed(1)}% ` +
  `(even = ${(100 / P).toFixed(1)}%), avg ${(rolls / N).toFixed(0)} rolls per game`);
