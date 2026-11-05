// Tests for src/EndgameTable.js (the precomputed endgame table) and the
// robot's use of it. Run with: node test/endgame.mjs
import { createGame, applyMove } from '../src/GameEngine.js';
import { lookup, expectedTurns, finishedBy, raceWinProbability, REGION } from '../src/EndgameTable.js';
import { pickNextRobotMove } from '../src/RobotPlayer.js';

let passed = 0, failed = 0;
const assert = (cond, label) => {
  if (cond) { console.log(`  ✓ ${label}`); passed++; } else { console.error(`  ✗ ${label}`); failed++; }
};
const describe = (label, fn) => { console.log(`\n${label}`); fn(); };

// Player 1 (yellow) in a 2-player game: home entry 42, region squares 31–42.
function yellow(spec) {
  const g = createGame([{ name: 'blue' }, { name: 'yellow' }], undefined, 1);
  spec.split(' ').forEach((t, i) => {
    const m = g.players[1].marbles[i];
    if (t === 'base') Object.assign(m, { zone: 'base', space: null, slot: null });
    else if (t === 'hub') Object.assign(m, { zone: 'center', space: null, slot: null });
    else if (t[0] === 'h') Object.assign(m, { zone: 'home', slot: +t.slice(1), space: null });
    else Object.assign(m, { zone: 'track', space: +t, slot: null, starEligible: +t === 36 });
  });
  return g;
}

describe('lookup — which positions are in the table', () => {
  assert(REGION === 12, 'region is the last 12 squares');
  assert(lookup(yellow('31 36 hub h4').players[1]) !== null, 'squares 31–42, hub and home are in the table');
  assert(lookup(yellow('30 36 41 h4').players[1]) === null, 'square 30 is outside');
  assert(lookup(yellow('base 36 41 h4').players[1]) === null, 'a marble in base is outside');
  assert(expectedTurns(lookup(yellow('h1 h2 h3 h4').players[1])) === 0, 'all home → 0 turns');
});

describe('lookup — exact value for a lone marble needing a 1', () => {
  // Marble on 42 with slots 2–4 full: a turn succeeds if some roll in it has a
  // 1; a roll with a 6 but no 1 (9/36) continues the turn. P(turn succeeds) =
  // (11/36) / (1 − 9/36) = 11/27, so expected turns = 27/11.
  const e = lookup(yellow('42 h2 h3 h4').players[1]);
  assert(Math.abs(expectedTurns(e) - 27 / 11) < 1e-3, `expected turns ${expectedTurns(e)} = 27/11`);
  assert(Math.abs(finishedBy(e, 1) - 11 / 27) < 1e-3, `P(done in 1 turn) ${finishedBy(e, 1)} = 11/27`);
  let mono = true;
  for (let n = 1; n < 40; n++) if (finishedBy(e, n + 1) < finishedBy(e, n) - 1e-9) mono = false;
  assert(mono && finishedBy(e, 40) > 0.9999, 'distribution rises to 1');
});

describe('raceWinProbability — consistent between the two sides', () => {
  const a = lookup(yellow('31 38 41 h4').players[1]);
  const b = lookup(yellow('33 36 42 h3').players[1]);
  // A to move: A wins if it finishes in no more turns than B. Then B, moving
  // second, wins exactly when A doesn't.
  const pA = raceWinProbability(a, [b]);
  let pB = 0;
  for (let n = 1; n <= 40; n++) pB += (finishedBy(b, n) - finishedBy(b, n - 1)) * (1 - finishedBy(a, n));
  assert(Math.abs(pA + pB - 1) < 1e-3, `P(A wins) ${pA.toFixed(4)} + P(B wins) ${pB.toFixed(4)} = 1`);
  const same = raceWinProbability(a, [a]);
  assert(same > 0.5 && same < 1, `identical positions: the player to move is favoured (${same.toFixed(3)})`);
  assert(raceWinProbability(lookup(yellow('h1 h2 h3 h4').players[1]), [b]) === 1, 'already home → wins');
});

describe('robot — uses the table near home', () => {
  // Turn 21 of a logged game (also in test/engine.mjs): the table's best play
  // is 37→40 and h3→h4.
  const g = yellow('h2 h3 42 37');
  g.dice = [3, 1]; g.diceUsed = [false, false]; g.phase = 'AWAITING_MOVE';
  for (let k = 0; k < 2; k++) {
    const mv = pickNextRobotMove(g, 1);
    if (mv) applyMove(g, 1, mv); else g.diceUsed[g.diceUsed[0] ? 1 : 0] = true;
  }
  const where = g.players[1].marbles.map(m => m.zone === 'home' ? 'h' + m.slot : m.space).sort().join(' ');
  assert(where === '40 42 h2 h4', `3-1 → 40 42 h2 h4 (got ${where})`);
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
