// MatchEquity.js — match equity table (MET) for TurboMarbles matches, and the
// match-play cube decisions built on it.
//
// MET[a][b] = chance that the player needing `a` points beats the player
// needing `b`, before a game with the cube centred. Computed for this game's
// own aggro rate (an aggro — the loser has no marbles home — counts double):
// measured in robot self-play at 7.3% of games. Model: each game is 50/50;
// a won game is worth 1 point, or 2 for an aggro (the cube's extra swings are
// not modelled in the table itself — the cube is handled by the decisions
// below). The Crawford rule: the first game after a player reaches match
// point (needs 1) is played without the cube; after it (post-Crawford) the
// trailer doubles at once, so those games are worth 2 (4 for an aggro).
import { cubefulEquity } from './CubeDecision.js';

export const AGGRO_RATE = 0.073;
export const MAX_MATCH = 25;

const g = AGGRO_RATE;
const cache = new Map();
// Post-Crawford: leader needs 1, trailer needs b; trailer doubles at once.
function post(b) {
  if (b <= 0) return 0;
  if (b === 1) return 0.5;
  const k = `p${b}`;
  if (cache.has(k)) return cache.get(k);
  const v = 0.5 + 0.5 * ((1 - g) * post(b - 2) + g * post(b - 4));
  cache.set(k, v);
  return v;
}
// The Crawford game: leader needs 1, trailer b (no cube this game).
function crawford(b) {
  if (b <= 0) return 0;
  const k = `c${b}`;
  if (cache.has(k)) return cache.get(k);
  const v = 0.5 + 0.5 * ((1 - g) * post(b - 1) + g * post(b - 2));
  cache.set(k, v);
  return v;
}
// Chance the player needing a beats the player needing b, before the next
// game. crawfordUsed: whether the Crawford game has already been played.
export function met(a, b, crawfordUsed = false) {
  if (a <= 0) return 1;
  if (b <= 0) return 0;
  if (a === 1 && b === 1) return 0.5;
  if (a === 1) return crawfordUsed ? post(b) : crawford(b);
  if (b === 1) return 1 - (crawfordUsed ? post(a) : crawford(a));
  const k = `m${a},${b}`;
  if (cache.has(k)) return cache.get(k);
  const v = 0.5 * ((1 - g) * met(a - 1, b) + g * met(a - 2, b))
          + 0.5 * ((1 - g) * met(a, b - 1) + g * met(a, b - 2));
  cache.set(k, v);
  return v;
}

// Match-play cube decision for the player to roll (or being doubled), from
// the estimate of their game chances: est = { p, aggroWin, aggroLoss } (as
// shares of all games). ctx = { a, b, v, crawfordUsed } — points each side
// still needs, the cube value now. Values are match-winning chances (MWC)
// for the doubler after the game, cube dead (ownership not valued).
export function matchCube(est, { a, b, v, crawfordUsed, owner = 'centre' }) {
  // met() knows the Crawford state: a score that puts someone at match point
  // with the Crawford game not yet played means the next game is Crawford.
  const M = (aa, bb) => met(aa, bb, crawfordUsed);
  const single = est.p - est.aggroWin, singleLoss = (1 - est.p) - est.aggroLoss;
  const mwc = val => single * M(a - val, b) + est.aggroWin * M(a - 2 * val, b)
    + singleLoss * M(a, b - val) + est.aggroLoss * M(a, b - 2 * val);
  let nd = mwc(v), dt = mwc(2 * v);
  const dp = M(a - v, b);
  const scale = M(a - 1, b) - M(a, b - 1);
  // Cube ownership. The dead-cube values above ignore that whoever holds the
  // cube can double later — at 50/50 that makes giving the cube away look
  // free (an opening double at 3-away 3-away "looked" right). Add the same
  // allowance money play uses (Janowski live minus dead, × cube value),
  // converted to match-winning chances — but only where the cube is alive:
  // a taker who wins the match with any win at the doubled cube (b ≤ 2v) can
  // never use it, and a doubler who already wins the match with a win at v
  // gains nothing from it.
  const dead = cubefulEquityDead(est);
  const toMwc = eq => eq * scale / 2;
  if (a > v) nd += toMwc(v * (cubefulEquity(est, owner) - dead));
  if (b > 2 * v) dt += toMwc(2 * v * (cubefulEquity(est, 'opp') - dead));
  return { nd, dt, dp, double: Math.min(dt, dp) > nd + 1e-9, take: dt < dp - 1e-9,
    // MWC swing of one game at cube 1, to show match decisions in equity
    // units (normalised like money play: a game won vs lost = 2).
    scale, mlose: M(a, b - 1) };
}
function cubefulEquityDead(est) {
  const W = est.p > 0 ? 1 + est.aggroWin / est.p : 1;
  const L = est.p < 1 ? 1 + est.aggroLoss / (1 - est.p) : 1;
  return est.p * W - (1 - est.p) * L;
}
// A match-winning chance shown in equity units (EMG): losing a single game at
// cube 1 from here = −1, winning one = +1.
export function emg(x, r) {
  return r.scale > 0 ? 2 * (x - r.mlose) / r.scale - 1 : 0;
}
