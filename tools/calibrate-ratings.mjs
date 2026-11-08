#!/usr/bin/env node
// Calibrate the rating bands: play 2-player games between a test player and
// the robot, analyse every real choice of the test player at the "checked"
// level, and report equity lost per decision (every loss beyond the rollout
// noise counts).
//
//   node tools/calibrate-ratings.mjs --mix 0.8 --games 20 [--seed 1]
//   --mix p   the test player plays the robot's move with probability p,
//             otherwise a random way to play the roll (1 = robot, 0 = random)
import { createGame, earnsExtraRoll, rollDice } from '../src/GameEngine.js';
import { allPlays, robotPlay, analyzeDecision } from '../src/Analysis.js';

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : +args[i + 1]; };
const MIX = opt('--mix', 1), N = opt('--games', 20);
let s = opt('--seed', 1) * 2654435761 >>> 0;
const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const CHECKED = { screen: 16, deep: 150, keep: 3, maxDeep: 300 };

let decisions = 0, lost = 0, clearLost = 0;
const losses = [];
for (let gno = 0; gno < N; gno++) {
  const seat = gno % 2;
  let g = createGame([{ name: 'a', color: 'blue' }, { name: 'b', color: 'yellow' }], undefined, gno % 2);
  for (let t = 0; t < 3000 && g.winner == null; t++) {
    const pi = g.turnIndex;
    g.dice = rollDice(); g.diceUsed = [false, false]; g.phase = 'AWAITING_MOVE';
    const before = structuredClone(g);
    let after;
    if (pi === seat) {
      const plays = allPlays(before, pi);
      after = rnd() < MIX ? robotPlay(before, pi).game : plays[Math.floor(rnd() * plays.length)].game;
      if (plays.length > 1) {
        const a = analyzeDecision({ before, after, pi }, { ...CHECKED, seed: 1 + decisions });
        decisions++;
        const eq = 2 * a.loss;
        if (a.loss > 1.96 * a.se) lost += eq;
        if (a.severity !== 'ok') clearLost += eq;
        losses.push(eq);
      }
    } else after = robotPlay(before, pi).game;
    g = after;
    if (g.winner != null) break;
    const again = earnsExtraRoll(before.dice);
    g.dice = null; g.phase = 'IN_TURN';
    if (!again) g.turnIndex = 1 - pi;
  }
  process.stderr.write(`game ${gno + 1}/${N}: ${decisions} decisions, ${(lost / decisions).toFixed(4)}/dec\n`);
}
console.log(JSON.stringify({ mix: MIX, games: N, decisions,
  perDecision: +(lost / decisions).toFixed(4), oldCounting: +(clearLost / decisions).toFixed(4),
  rawMean: +(losses.reduce((a, b) => a + b, 0) / decisions).toFixed(4) }));
