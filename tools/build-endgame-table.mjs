#!/usr/bin/env node
// Builds src/endgame-table.json: exact one-sided endgame values, in the spirit
// of gnubg's bear-off databases.
//
// Usage: node tools/build-endgame-table.mjs
//
// Region (relative to a player's home entry, so one table serves every arm):
//   track offsets 0..11 — offset 0 is the home entry, 11 is eleven squares
//   before it (yellow: squares 42..31); offset 6 is the pre-home star.
//   the hub, and home slots 1..4.
// A position = where the player's four marbles are, all in the region or home.
// For every position the table stores, under play that minimizes expected turns:
//   - expected turns to get all four marbles home ("turn" = a roll plus any
//     bonus rolls after 6s), and
//   - the probability of being finished within 1, 2, …, NMAX turns.
// Two such distributions give an exact race-win probability.
//
// Moves come from the real rules engine (GameEngine.allLegalMoves), including
// the mandatory-move rule: a die must be used if it has a legal move; the
// player chooses order and moves. Optional moves (passing home to go around
// again) are never taken. Opponents are not part of the table (it is the race
// alone): no bumps.
//
// One approximation: from the pre-home star, star-track hops leave the region.
// Optimal play never chooses them, but they can be forced when the player's
// own marbles block every other move. Such an "escaped" marble is valued as if
// it were on the region's far end, plus ESCAPE_TURNS. The build reports how
// many positions/rolls this affects.
import { writeFileSync } from 'fs';
import { createGame, allLegalMoves, applyMove } from '../src/GameEngine.js';

const REGION = 12;
const NMAX = 40;
const ESCAPE_TURNS = 2;
const PLAYER = 1;                                   // yellow in a 2-player game
const base = createGame([{ name: 'a' }, { name: 'b' }], undefined, 0);
const ENTRY = base.players[PLAYER].config.homeEntry;

// Cell codes: track offset 0..11, HUB = 20, home slot k = 30 + k.
const HUB = 20;
const cellOf = m => m.zone === 'home' ? 30 + m.slot
  : m.zone === 'center' ? HUB
  : m.zone === 'track' && ((ENTRY - m.space + 84) % 84) < REGION ? (ENTRY - m.space + 84) % 84
  : null;                                           // outside the region (escaped)
const isHomeCell = c => c > 30;
const key = cells => [...cells].sort((a, b) => a - b).join(',');

const allCells = [...Array(REGION).keys(), HUB, 31, 32, 33, 34];
const states = [];
for (let a = 0; a < allCells.length; a++) for (let b = a + 1; b < allCells.length; b++)
  for (let c = b + 1; c < allCells.length; c++) for (let d = c + 1; d < allCells.length; d++)
    states.push([allCells[a], allCells[b], allCells[c], allCells[d]]);
const index = new Map(states.map((s, i) => [key(s), i]));
const done = s => s.every(isHomeCell);

function gameFor(cells, dice) {
  const g = structuredClone(base);
  g.turnIndex = PLAYER;
  g.players[PLAYER].marbles.forEach((m, i) => {
    const c = cells[i];
    if (isHomeCell(c)) Object.assign(m, { zone: 'home', slot: c - 30, space: null, starEligible: false });
    else if (c === HUB) Object.assign(m, { zone: 'center', space: null, slot: null, starEligible: false });
    else {
      const space = ((ENTRY - c - 1 + 84) % 84) + 1;
      Object.assign(m, { zone: 'track', space, slot: null, starEligible: space === ENTRY - 6 });
    }
  });
  g.dice = dice; g.diceUsed = [false, false]; g.phase = 'AWAITING_MOVE';
  return g;
}
const realMoves = (g, d) => (allLegalMoves(g, PLAYER)[d] ?? []).filter(m => !m.optional);

// Every legal way to play roll (a, b) from `cells`. Returns outcome cell lists;
// an escaped marble shows as null.
function outcomes(cells, a, b) {
  const g = gameFor(cells, [a, b]);
  const out = new Map();
  const add = gg => { const c = gg.players[PLAYER].marbles.map(cellOf); out.set(c.map(x => x ?? 'x').sort().join(','), c); };
  for (const d of [0, 1]) {
    for (const m1 of realMoves(g, d)) {
      const g1 = structuredClone(g); applyMove(g1, PLAYER, m1);
      const second = realMoves(g1, 1 - d);
      if (second.length === 0 || g1.winner != null) { add(g1); continue; }
      for (const m2 of second) { const g2 = structuredClone(g1); applyMove(g2, PLAYER, m2); add(g2); }
    }
  }
  if (out.size === 0) out.set('stay', cells.slice());
  return [...out.values()];
}

// An escaped marble is valued as sitting on the region's far end (the nearest
// free offset counting down from 11) — plus ESCAPE_TURNS when used.
function resolveEscape(cells) {
  if (!cells.includes(null)) return { cells, escaped: false };
  const c = cells.slice();
  for (let i = 0; i < 4; i++) if (c[i] === null) {
    for (let o = REGION - 1; o >= 0; o--) if (!c.includes(o)) { c[i] = o; break; }
  }
  return { cells: c, escaped: true };
}

console.log(`Building: ${states.length} positions × 36 rolls, region ${REGION} squares + hub + home…`);
const t0 = Date.now();
const rolls = [];
for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) rolls.push([a, b]);
let escapeRolls = 0, forcedEscapes = 0;
// succ[s][r] = list of { i: index, escaped }
const succ = states.map(s => done(s) ? null : rolls.map(([a, b]) => outcomes(s, a, b).map(o => {
  const { cells, escaped } = resolveEscape(o);
  return { i: index.get(key(cells)), escaped };
})));
succ.forEach(per => per && per.forEach(list => {
  if (list.some(x => x.escaped)) escapeRolls++;
  if (list.every(x => x.escaped)) forcedEscapes++;
}));
console.log(`  moves generated in ${((Date.now() - t0) / 1000).toFixed(1)} s; ` +
  `${escapeRolls} position-rolls offer a star escape, ${forcedEscapes} force one (approximated).`);

// Expected turns. G[s] = expected further turns after the current one when
// the current turn continues (bonus roll); W[s] = 1 + G[s] at the start of a
// turn. A roll containing a 6 keeps the turn going.
const six = r => r[0] === 6 || r[1] === 6;
const G = new Float64Array(states.length);
const isDone = states.map(done);
const value = (r, o) => isDone[o.i] ? 0 : (six(r) ? G[o.i] : 1 + G[o.i]) + (o.escaped ? ESCAPE_TURNS : 0);
for (let it = 0; it < 100000; it++) {
  let delta = 0;
  for (let s = 0; s < states.length; s++) {
    if (isDone[s]) continue;
    let v = 0;
    rolls.forEach((r, ri) => { let best = Infinity; for (const o of succ[s][ri]) best = Math.min(best, value(r, o)); v += best / 36; });
    delta = Math.max(delta, Math.abs(v - G[s])); G[s] = v;
  }
  if (delta < 1e-12) break;
}
// Policy: the chosen outcome per (position, roll).
const policy = states.map((s, si) => isDone[si] ? null : rolls.map((r, ri) => {
  let best = null, bv = Infinity;
  for (const o of succ[si][ri]) { const v = value(r, o); if (v < bv) { bv = v; best = o; } }
  return best;
}));

// Finish-time distribution under that policy: H[n][s] = P(done within n turns).
const H = [new Float64Array(states.length).map((_, s) => isDone[s] ? 1 : 0)];
for (let n = 1; n <= NMAX; n++) {
  const h = new Float64Array(states.length).fill(0);
  for (let s = 0; s < states.length; s++) if (isDone[s]) h[s] = 1;
  for (let it = 0; it < 100000; it++) {          // bonus rolls refer to the same n
    let delta = 0;
    for (let s = 0; s < states.length; s++) {
      if (isDone[s]) continue;
      let v = 0;
      rolls.forEach((r, ri) => {
        const o = policy[s][ri];
        const delay = o.escaped ? ESCAPE_TURNS : 0;
        const nn = (six(r) ? n : n - 1) - delay;
        v += (isDone[o.i] ? 1 : nn <= 0 ? 0 : nn === n ? h[o.i] : H[nn][o.i]) / 36;
      });
      delta = Math.max(delta, Math.abs(v - h[s])); h[s] = v;
    }
    if (delta < 1e-12) break;
  }
  H.push(h);
}

const r4 = x => Math.round(x * 1e5) / 1e5;
const table = {
  description: 'Exact one-sided endgame table; see tools/build-endgame-table.mjs.',
  region: REGION, hub: HUB, homeBase: 30, nmax: NMAX,
  // per position (key = sorted cell codes joined by ','):
  //   [expected turns from the start of a turn, P(done ≤ 1 turn), …, P(done ≤ NMAX)]
  positions: Object.fromEntries(states.map((s, i) =>
    [key(s), [r4(isDone[i] ? 0 : 1 + G[i]), ...H.slice(1).map(h => r4(h[i]))]])),
};
const out = new URL('../src/endgame-table.json', import.meta.url);
writeFileSync(out, JSON.stringify(table));
const tail = Math.max(...states.map((_, i) => 1 - H[NMAX][i]));
console.log(`  solved in ${((Date.now() - t0) / 1000).toFixed(1)} s total; largest P(not done within ${NMAX} turns) = ${tail.toExponential(2)}`);
console.log(`  wrote ${out.pathname}`);
