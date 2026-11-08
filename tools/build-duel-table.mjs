// tools/build-duel-table.mjs — solve two-player endgames exactly.
//
//   node tools/build-duel-table.mjs [11|12 ...]   → src/duel-11.json.gz, src/duel-12.json.gz
//
// Table "11": both players down to their last marble, any home layout.
// Table "12": player A down to the last marble with h2–h4 filled, player B
//             with two marbles out and h3–h4 filled — and every position that
//             can follow (B getting one home, either side being bumped).
//
// How: each player's own moves come from the real rules engine, one player at
// a time (another player's marbles never block a move; they only get bumped
// when a die lands on them). A play is stored as the mover's new position plus
// the squares its dice landed on; landing on an opponent marble sends it to
// base. This composition is checked against the full engine on random joint
// positions before solving. Then value iteration: V(a, b, mover) = chance A
// wins; A maximises it on A's rolls, B minimises it on B's; 6s roll again.
// Positions are rotated so A is on arm 0; one solution per offset of B's arm.
// Rebuild after any rule change that affects movement.
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { gzipSync } from 'zlib';
import { createGame, allLegalMoves, applyMove, earnsExtraRoll } from '../src/GameEngine.js';
import { allPlays } from '../src/Analysis.js';
import { ALL_STARS } from '../public/js/constants.js';
import { playerKey } from '../src/DuelTable.js';

const DICE = [];
for (let a = 6; a >= 1; a--) for (let b = a; b >= 1; b--) DICE.push({ d: [a, b], w: a === b ? 1 : 2 });
const realMoves = (g, pi, d) => (allLegalMoves(g, pi)[d] ?? []).filter(m => !m.optional);
const landOf = mv => mv.toZone === 'center' ? 1 : mv.toZone === 'track' ? 1 + mv.toSpace : -1;

function placeMarble(m, loc) {
  if (loc === 0) Object.assign(m, { zone: 'base', space: null, slot: null, starEligible: false });
  else if (loc === 1) Object.assign(m, { zone: 'center', space: null, slot: null, starEligible: false });
  else Object.assign(m, { zone: 'track', space: loc - 1, slot: null, starEligible: ALL_STARS.has(loc - 1) });
}
function setPlayer(p, key) {
  const [maskS, outsS] = key.split('|');
  const mask = +maskS, outs = outsS ? outsS.split(',').map(Number) : [];
  let mi = 0;
  for (let s = 1; s <= 4; s++) if (mask & (1 << (s - 1))) Object.assign(p.marbles[mi++], { zone: 'home', slot: s, space: null, starEligible: false });
  for (const loc of outs) placeMarble(p.marbles[mi++], loc);
}
const bumpKey = (key, loc) => {        // the marble on `loc` goes back to base
  const [mask, outsS] = key.split('|');
  const outs = outsS.split(',').map(Number);
  outs[outs.indexOf(loc)] = 0;
  outs.sort((x, y) => x - y);
  return `${mask}|${outs.join(',')}`;
};

// One player's position space (closed under its own moves and under being
// bumped) and its transitions: trans[state][roll] = [{ to, lands }], to = -1
// for a win; an empty list means no legal play (the position stays).
function playerSpace(arm, otherArm, seeds) {
  const game = createGame([{ name: 'P', color: 'x' }, { name: 'Q', color: 'y' }], [arm, otherArm], 0);
  game.players[1].marbles.forEach((m, i) => Object.assign(m, { zone: 'home', slot: i + 1 }));
  const index = new Map(), keys = [], trans = [], bumps = [];
  const add = k => { if (!index.has(k)) { index.set(k, keys.length); keys.push(k); } return index.get(k); };
  seeds.forEach(add);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const g = structuredClone(game);
    setPlayer(g.players[0], key);
    const rolls = [];
    for (const { d } of DICE) {
      g.dice = d.slice(); g.diceUsed = [false, false]; g.phase = 'AWAITING_MOVE'; g.turnIndex = 0;
      const out = new Map();
      const push = (gg, lands) => {
        const to = gg.winner === 0 ? -1 : playerKey(gg.players[0]);
        const ls = lands.filter(x => x > 0).sort((x, y) => x - y);
        out.set(`${to}#${ls}`, { to, lands: ls });
      };
      // Each die: any legal move, or skip it when it has none or only
      // optional ones (passing your own home is never forced) — the same
      // choices as Analysis.allPlays.
      const choices = (gg, d) => {
        if (gg.winner != null || gg.diceUsed[d]) return [];
        const ms = allLegalMoves(gg, 0)[d] ?? [];
        return ms.every(m => m.optional) ? [...ms, null] : ms;
      };
      const step = (gg, d, mv) => { const g2 = structuredClone(gg); if (mv) applyMove(g2, 0, mv); else g2.diceUsed[d] = true; return g2; };
      for (const di of [0, 1]) {
        for (const m1 of choices(g, di)) {
          const g1 = step(g, di, m1);
          const second = choices(g1, 1 - di);
          if (!second.length) { push(g1, [m1 ? landOf(m1) : -1]); continue; }
          for (const m2 of second) push(step(g1, 1 - di, m2), [m1 ? landOf(m1) : -1, m2 ? landOf(m2) : -1]);
        }
      }
      rolls.push([...out.values()].map(o => ({ to: o.to === -1 ? -1 : add(o.to), lands: o.lands })));
    }
    trans.push(rolls);
    const outs = key.split('|')[1].split(',').map(Number);
    bumps.push(new Map(outs.filter(l => l > 0).map(l => [l, add(bumpKey(key, l))])));
  }
  return { keys, index, trans, bumps };
}

// Apply an opponent's landings to a position: each landing on one of its
// marbles sends that marble to base.
function applyLands(space, s, lands) {
  for (const l of lands) { const t = space.bumps[s].get(l); if (t != null) s = t; }
  return s;
}

// Check the composition against the full engine on random joint positions.
function verify(A, B, armB, samples = 1500) {
  const game = createGame([{ name: 'A', color: 'x' }, { name: 'B', color: 'y' }], [0, armB], 0);
  let checked = 0;
  for (let t = 0; t < samples * 3 && checked < samples; t++) {
    const a = Math.floor(Math.random() * A.keys.length), b = Math.floor(Math.random() * B.keys.length);
    const la = A.keys[a].split('|')[1].split(',').map(Number).filter(x => x > 0);
    const lb = B.keys[b].split('|')[1].split(',').map(Number).filter(x => x > 0);
    if (la.some(x => lb.includes(x))) continue;          // two marbles on one square: impossible
    const g = structuredClone(game);
    setPlayer(g.players[0], A.keys[a]); setPlayer(g.players[1], B.keys[b]);
    for (const mover of [0, 1]) {
      const k = Math.floor(Math.random() * DICE.length);
      g.dice = DICE[k].d.slice(); g.diceUsed = [false, false]; g.phase = 'AWAITING_MOVE'; g.turnIndex = mover;
      const eng = new Set(allPlays(g, mover).map(p => p.game.winner === mover ? 'WIN'
        : `${playerKey(p.game.players[0])}/${playerKey(p.game.players[1])}`));
      const [S, O, s, o] = mover === 0 ? [A, B, a, b] : [B, A, b, a];
      const opts = S.trans[s][k];
      const comp = new Set(opts.length ? opts.map(op => {
        if (op.to === -1) return 'WIN';
        const so = applyLands(O, o, op.lands);
        return mover === 0 ? `${S.keys[op.to]}/${O.keys[so]}` : `${O.keys[so]}/${S.keys[op.to]}`;
      }) : [`${A.keys[a]}/${B.keys[b]}`]);
      if (eng.size !== comp.size || [...eng].some(x => !comp.has(x))) {
        throw new Error(`composition mismatch at ${A.keys[a]} vs ${B.keys[b]}, mover ${mover}, dice ${DICE[k].d}: engine ${[...eng]} / composed ${[...comp]}`);
      }
    }
    checked++;
  }
  return checked;
}

// Flatten a player space into typed arrays for the solver: for state s and
// roll k, options optStart[s*R+k] … optStart[s*R+k+1]-1, each with a target
// (−1 = win) and up to two landing squares (0 = none); bumpTo[s*L+loc] = the
// state after the marble on `loc` is bumped (−1 if none there).
function flatten(S) {
  const R = DICE.length, n = S.keys.length;
  const optStart = new Int32Array(n * R + 1);
  const to = [], l1 = [], l2 = [];
  for (let st = 0; st < n; st++) for (let k = 0; k < R; k++) {
    optStart[st * R + k] = to.length;
    for (const op of S.trans[st][k]) { to.push(op.to); l1.push(op.lands[0] ?? 0); l2.push(op.lands[1] ?? 0); }
  }
  optStart[n * R] = to.length;
  const bumpTo = new Int32Array(n * 86).fill(-1);
  S.bumps.forEach((m, st) => { for (const [loc, t] of m) bumpTo[st * 86 + loc] = t; });
  return { n, optStart, to: Int32Array.from(to), l1: Int32Array.from(l1), l2: Int32Array.from(l2), bumpTo };
}

function solve(A, B) {
  const FA = flatten(A), FB = flatten(B);
  const nA = FA.n, nB = FB.n, N = nA * nB, R = DICE.length;
  const W = Float64Array.from(DICE.map(x => x.w / 36));
  const SIX = Uint8Array.from(DICE.map(x => earnsExtraRoll(x.d) ? 1 : 0));
  const V = new Float64Array(2 * N).fill(0.5);
  const land = (F, st, l) => { if (l > 0) { const t = F.bumpTo[st * 86 + l]; if (t >= 0) return t; } return st; };
  for (let it = 0; it < 5000; it++) {
    let delta = 0;
    for (let a = 0; a < nA; a++) for (let b = 0; b < nB; b++) {
      const cell = a * nB + b;
      // A to move: maximise.
      let v = 0;
      for (let k = 0; k < R; k++) {
        const base = SIX[k] ? 0 : N;
        const s0 = FA.optStart[a * R + k], s1 = FA.optStart[a * R + k + 1];
        let best;
        if (s0 === s1) best = V[base + cell];
        else {
          best = -1;
          for (let o = s0; o < s1; o++) {
            const t = FA.to[o];
            const val = t === -1 ? 1 : V[base + t * nB + land(FB, land(FB, b, FA.l1[o]), FA.l2[o])];
            if (val > best) best = val;
          }
        }
        v += W[k] * best;
      }
      let d = Math.abs(v - V[cell]); if (d > delta) delta = d;
      V[cell] = v;
      // B to move: minimise.
      v = 0;
      for (let k = 0; k < R; k++) {
        const base = SIX[k] ? N : 0;
        const s0 = FB.optStart[b * R + k], s1 = FB.optStart[b * R + k + 1];
        let best;
        if (s0 === s1) best = V[base + cell];
        else {
          best = 2;
          for (let o = s0; o < s1; o++) {
            const t = FB.to[o];
            const val = t === -1 ? 0 : V[base + land(FA, land(FA, a, FB.l1[o]), FB.l2[o]) * nB + t];
            if (val < best) best = val;
          }
        }
        v += W[k] * best;
      }
      d = Math.abs(v - V[N + cell]); if (d > delta) delta = d;
      V[N + cell] = v;
    }
    if (delta < 1e-7) { console.error(`  converged after ${it + 1} sweeps`); break; }
  }
  const q = new Uint16Array(2 * N);
  for (let i = 0; i < q.length; i++) q[i] = Math.round(V[i] * 65535);
  return Buffer.from(q.buffer).toString('base64');
}

const pairs = [];
for (let a = 2; a < 86; a++) for (let b = a + 1; b < 86; b++) pairs.push([a, b]);
for (let a = 0; a < 86; a++) if (a !== 1) pairs.push([0, a]);   // base + anything (two in base included)
const ONE_ANY = [7, 11, 13, 14].flatMap(mask => Array.from({ length: 86 }, (_, l) => `${mask}|${l}`));
const ONE_TIDY = Array.from({ length: 86 }, (_, l) => `14|${l}`);
const TWO_TIDY = [...new Set(pairs.map(([a, b]) => `12|${Math.min(a, b)},${Math.max(a, b)}`))];
const SPEC = {
  11: { seedsA: ONE_ANY, seedsB: ONE_ANY },
  12: { seedsA: ONE_TIDY, seedsB: TWO_TIDY },
};

const which = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SPEC);
for (const name of which) {
  const spec = SPEC[name];
  const t0 = Date.now();
  const A = playerSpace(0, 3, spec.seedsA);
  const out = { version: 2, note: 'see tools/build-duel-table.mjs', statesA: A.keys, offsets: {} };
  // Each offset is saved as soon as it is solved (DUEL_CACHE, default
  // ./.duel-cache), so an interrupted build resumes where it stopped.
  const cacheDir = process.env.DUEL_CACHE ?? '.duel-cache';
  mkdirSync(cacheDir, { recursive: true });
  for (let k = 1; k <= 5; k++) {
    const cached = `${cacheDir}/duel-${name}-${k}.json`;
    if (existsSync(cached)) { out.offsets[k] = JSON.parse(readFileSync(cached, 'utf8')); console.error(`table ${name}, offset ${k}: from cache`); continue; }
    const B = playerSpace(k, 0, spec.seedsB);
    const n = verify(A, B, k);
    console.error(`table ${name}, offset ${k}: ${A.keys.length} × ${B.keys.length} positions; composition matches the engine on ${n} random positions`);
    out.offsets[k] = { statesB: B.keys, values: solve(A, B) };
    writeFileSync(cached, JSON.stringify(out.offsets[k]));
  }
  const file = new URL(`../src/duel-${name}.json.gz`, import.meta.url);
  writeFileSync(file, gzipSync(JSON.stringify(out)));
  console.error(`table ${name}: wrote ${file.pathname} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
