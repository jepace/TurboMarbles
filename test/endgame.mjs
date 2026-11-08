// Tests for src/EndgameTable.js (the precomputed endgame table) and the
// robot's use of it. Run with: node test/endgame.mjs
import { createGame, applyMove } from '../src/GameEngine.js';
import { lookup, expectedTurns, finishedBy, raceWinProbability, REGION } from '../src/EndgameTable.js';
import { pickNextRobotMove } from '../src/RobotPlayer.js';
import { positionFacts, allPlays, notation } from '../src/Analysis.js';
import { parseSpaceName, spaceName } from '../public/js/constants.js';
import { isDuel, duelWinChance } from '../src/DuelTable.js';

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

// Position facts — the final race from a real game: both players have three
// marbles home; Blue is on O↑4, Yellow stops on Y↓4 (5 from h1) or Y↓3.
{
  const g = createGame([{ name: 'a', color: 'blue' }, { name: 'b', color: 'yellow' }], undefined, 0);
  const put = (pi, last) => g.players[pi].marbles.forEach((m, i) => {
    delete m.space; delete m.slot;
    Object.assign(m, i < 3 ? { zone: 'home', slot: i + 2 } : { zone: 'track', space: parseSpaceName(last) });
  });
  put(0, 'O↑4');
  put(1, 'Y↓4');
  const f4 = positionFacts(g, 1);
  put(1, 'Y↓3');
  const f3 = positionFacts(g, 1);
  assert(Math.abs(f4.anyHit - 15 / 36) < 1e-9 && f4.hits[0].rolls === 'any 5, 4-1, 3-2', `Y↓4 hit 15/36 by any 5, 4-1, 3-2 (${f4.hits[0]?.rolls})`);
  assert(Math.abs(f3.anyHit - 16 / 36) < 1e-9 && f3.hits[0].rolls === 'any 6, 5-1, 4-2, 3-3', `Y↓3 hit 16/36 by any 6, 5-1, 4-2, 3-3 (${f3.hits[0]?.rolls})`);
  assert(f4.race[0].next > f3.race[0].next, 'five away finishes next turn more often than four away');
}

// The duel table: same race, Yellow's last marble in the hub, Yellow rolls 3-1.
// The robot must play the exact best play by the table. (Under the original
// rules that was waiting on a far star; since passing your home became
// optional on the star track too, it is hub/P★/Y↓4.)
{
  const g = createGame([{ name: 'a', color: 'blue' }, { name: 'b', color: 'yellow' }], undefined, 1);
  g.players.forEach((p, pi) => p.marbles.forEach((m, i) => {
    delete m.space; delete m.slot;
    Object.assign(m, i < 3 ? { zone: 'home', slot: i + 2 } : pi === 0 ? { zone: 'track', space: parseSpaceName('O↑4') } : { zone: 'center' });
  }));
  g.dice = [3, 1]; g.diceUsed = [false, false]; g.phase = 'AWAITING_MOVE';
  assert(isDuel(g), 'two last marbles with h2–h4 filled is a duel');
  const v = duelWinChance(g, 1, 1);
  assert(v > 0.3 && v < 0.7, `duel value is a probability (${v.toFixed(3)})`);
  const plays = allPlays(g, 1).map(p => ({ p, v: duelWinChance(p.game, 1, 0) }));
  const best = plays.reduce((a, b) => (b.v > a.v ? b : a));
  const mv1 = pickNextRobotMove(g, 1);
  applyMove(g, 1, mv1);
  const mv2 = pickNextRobotMove(g, 1);
  applyMove(g, 1, mv2);
  const got = duelWinChance(g, 1, 0);
  assert(Math.abs(got - best.v) < 1e-9, `robot plays the table's best (${notation(best.p.moves)}, ${(100 * best.v).toFixed(1)}%; robot got ${(100 * got).toFixed(1)}%)`);
}

// Hitting a marble in the hub counts as a hit (it was scored as a plain move).
{
  const g = createGame([{ name: 'a', color: 'blue' }, { name: 'b', color: 'yellow' }], undefined, 1);
  const set = (pi, locs) => g.players[pi].marbles.forEach((m, i) => { m.space = null; m.slot = null; m.starEligible = false; Object.assign(m, locs[i]); });
  set(0, [{ zone: 'home', slot: 4 }, { zone: 'home', slot: 3 }, { zone: 'center' }, { zone: 'base' }]);
  set(1, [{ zone: 'track', space: parseSpaceName('G↑4') }, { zone: 'track', space: parseSpaceName('Y↑2') }, { zone: 'base' }, { zone: 'home', slot: 4 }]);
  g.dice = [4, 1]; g.diceUsed = [false, false]; g.phase = 'AWAITING_MOVE';
  const moves = [];
  for (let k = 0; k < 2 && !(g.diceUsed[0] && g.diceUsed[1]); k++) { const mv = pickNextRobotMove(g, 1); if (!mv) break; moves.push(mv); applyMove(g, 1, mv); }
  assert(g.players[0].marbles[2].zone === 'base', `robot hits the marble in the hub (G↑4 + 4 → hub): ${moves.map(m => m.type).join(', ')}`);
}

// Hit chances count optional moves: a marble on a star can reach the hub
// with any die (a 1 straight in, or hop round the star track and step in —
// optional when it passes the mover's approach star, but allowed).
{
  const g = createGame([{ name: 'a', color: 'blue' }, { name: 'b', color: 'yellow' }], undefined, 0);
  g.players[0].marbles.forEach((m, i) => { delete m.space; delete m.slot; Object.assign(m, i === 0 ? { zone: 'center' } : { zone: 'base' }); });
  g.players[1].marbles.forEach((m, i) => { delete m.space; delete m.slot;
    Object.assign(m, i === 0 ? { zone: 'track', space: 36, starEligible: true } : { zone: 'home', slot: i + 1 }); });
  const f = positionFacts(g, 0);
  assert(Math.abs(f.anyHit - 1) < 1e-9, `a marble in the hub next to an opponent on a star is hit 100% (${(100 * f.anyHit).toFixed(1)}%)`);
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
