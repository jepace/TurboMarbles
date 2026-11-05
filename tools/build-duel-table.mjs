// tools/build-duel-table.mjs — solve the two-player last-marble duel exactly.
//
//   node tools/build-duel-table.mjs            → writes src/duel-table.json
//
// The duel: two players, each with three marbles home in h2–h4 and one marble
// left (in base, the hub or anywhere on the track). The last marble must land
// exactly on h1. Hits send it back to base. The position is just the two
// marbles' squares and whose turn it is, so the whole game can be solved:
// for every position, the exact chance that each player wins when both play
// perfectly (6s give an extra roll, as in the game).
//
// The board is the same from every arm, so positions are stored with player A
// on arm 0 and player B `offset` arms further on (1–5); one table per offset.
// Moves come from the real rules engine (src/GameEngine.js), so rebuild this
// after any rule change that affects movement.
//
// Value iteration: V(a, b, mover) = chance A wins. On A's turn A picks the play
// that maximises it, on B's turn B minimises it; averaged over the 36 rolls.
import { writeFileSync } from 'fs';
import { createGame, earnsExtraRoll } from '../src/GameEngine.js';
import { allPlays } from '../src/Analysis.js';
import { PLAYER_CONFIG, ALL_STARS } from '../public/js/constants.js';
import { L, locIndex, DONE } from '../src/DuelTable.js';

const DICE = [];
for (let a = 6; a >= 1; a--) for (let b = a; b >= 1; b--) DICE.push({ d: [a, b], w: a === b ? 1 : 2 });

function locOf(idx) {
  if (idx === 0) return { zone: 'base', space: null, slot: null, starEligible: false };
  if (idx === 1) return { zone: 'center', space: null, slot: null, starEligible: false };
  const s = idx - 1;
  return { zone: 'track', space: s, slot: null, starEligible: ALL_STARS.has(s) };
}

function solve(offset) {
  const game = createGame([{ name: 'A', color: PLAYER_CONFIG[0].color }, { name: 'B', color: PLAYER_CONFIG[offset].color }], [0, offset], 0);
  for (const p of game.players) {
    p.marbles.forEach((m, i) => { if (i < 3) Object.assign(m, { zone: 'home', slot: i + 2, space: null }); });
  }
  const N = L * L;
  // trans[mover][state] = for each of the 21 rolls, the list of result codes:
  // a state index, or -1 for "mover wins". A roll with no play keeps the state.
  const trans = [new Array(N), new Array(N)];
  const t0 = Date.now();
  for (let a = 0; a < L; a++) for (let b = 0; b < L; b++) {
    const s = a * L + b;
    for (const mover of [0, 1]) {
      // Both marbles on the same track square can't happen (the second would
      // have bumped the first); such states are left out (never reached).
      const g = structuredClone(game);
      Object.assign(g.players[0].marbles[3], locOf(a));
      Object.assign(g.players[1].marbles[3], locOf(b));
      const rolls = [];
      for (const { d } of DICE) {
        g.turnIndex = mover; g.dice = d.slice(); g.diceUsed = [false, false]; g.phase = 'AWAITING_MOVE';
        const out = new Set();
        for (const p of allPlays(g, mover)) {
          if (p.game.winner === mover) { out.add(-1); continue; }
          const ia = locIndex(p.game.players[0].marbles[3]);
          const ib = locIndex(p.game.players[1].marbles[3]);
          out.add(ia * L + ib);
        }
        rolls.push([...out]);
      }
      trans[mover][s] = rolls;
    }
  }
  console.error(`offset ${offset}: transitions in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

  // V[mover * N + s] = chance A wins.
  const V = new Float64Array(2 * N).fill(0.5);
  for (let it = 0; it < 10000; it++) {
    let delta = 0;
    for (const mover of [0, 1]) {
      for (let s = 0; s < N; s++) {
        let v = 0;
        DICE.forEach(({ d, w }, k) => {
          const next = earnsExtraRoll(d) ? mover : 1 - mover;
          const opts = trans[mover][s][k];
          let best = mover === 0 ? -1 : 2;
          if (!opts.length) best = V[next * N + s];
          for (const o of opts) {
            const val = o === -1 ? (mover === 0 ? 1 : 0) : V[next * N + o];
            best = mover === 0 ? Math.max(best, val) : Math.min(best, val);
          }
          v += w * best;
        });
        v /= 36;
        delta = Math.max(delta, Math.abs(v - V[mover * N + s]));
        V[mover * N + s] = v;
      }
    }
    if (delta < 1e-7) { console.error(`offset ${offset}: converged after ${it + 1} sweeps`); break; }
  }
  // Store as 16-bit fixed point (1/65535 resolution), base64.
  const q = new Uint16Array(2 * N);
  for (let i = 0; i < q.length; i++) q[i] = Math.round(V[i] * 65535);
  return Buffer.from(q.buffer).toString('base64');
}

const out = { version: 1, locs: L, note: 'see tools/build-duel-table.mjs', tables: {} };
for (let k = 1; k <= 5; k++) out.tables[k] = solve(k);
writeFileSync(new URL('../src/duel-table.json', import.meta.url), JSON.stringify(out));
console.error('wrote src/duel-table.json');
void DONE;
