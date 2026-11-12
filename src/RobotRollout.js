// RobotRollout.js — the robot "thinks" in late positions by playing out its
// options (every player using the normal robot strategy afterwards) and picking
// the one that wins most. Runs inside a worker thread (robotThinkWorker.js) with
// a time budget; the game never waits on it (see RobotThinker.js).
//
// Options are compared on common dice streams (the same seeds for every option)
// and narrowed by successive halving: every round adds playouts to the
// surviving options and drops the worse half. The robot's normal play is
// always kept, and is only overridden when another play beats it by a clear
// margin (more than twice the standard error of the paired difference), so
// rollout noise can't make the robot worse than its heuristics.
import { allPlays, robotPlay, outcomes, pairedSE, pointsValuer } from './Analysis.js';

const mean = a => { let s = 0; for (const x of a) s += x; return a.length ? s / a.length : 0; };
const concat = (a, b) => { const r = new Float64Array(a.length + b.length); r.set(a); r.set(b, a.length); return r; };

// Late in the game: worth thinking about. The exact duel tables take precedence
// (the caller checks them first).
export function worthThinking(game, pi) {
  const outside = p => p.marbles.filter(m => m.zone !== 'home').length;
  return outside(game.players[pi]) <= 2 || game.players.some((p, i) => i !== pi && outside(p) <= 1);
}

// Earlier in the game: worth thinking when a bonk is on the table (some play
// sends an opponent's marble home). Those swing the game most, and the rules'
// value of a bonk against the counter-hit is where the robot errs.
export function contested(game, pi) {
  const inBase = g => g.players.reduce((n, p, i) => n + (i === pi ? 0 : p.marbles.filter(m => m.zone === 'base').length), 0);
  const before = inBase(game);
  const plays = allPlays(game, pi);
  return plays.length >= 2 && plays.some(p => inBase(p.game) > before);
}

// Returns { moves: [engine move, …] (to play in order), changed, n } or null
// (nothing to decide / no time).
export function chooseByRollouts(game, pi, { budgetMs = 1200, seed = 1, batch = 8, maxCands = 16, points = false } = {}) {
  const t0 = Date.now();
  const plays = allPlays(game, pi);
  if (plays.length < 2) return null;
  const robot = robotPlay(game, pi);
  let cands = plays.map(p => ({ p, res: new Float64Array(0), robot: p.key === robot.key }));
  if (!cands.some(c => c.robot)) return null;
  const dice = game.dice;
  // Endings are worth what they score (aggros 2, baggros 3; the cube; the match), not just win or lose.
  const valuer = points ? pointsValuer(game, pi, game.valueCtx ?? {}) : null;   // points: false = plain win / lose (for comparison)
  let done = 0;                               // playouts per surviving candidate
  const add = c => { c.res = concat(c.res, outcomes(c.p.game, pi, dice, batch, seed + done * 7919, valuer)); };
  let round = 0;
  while (Date.now() - t0 < budgetMs && cands.length > 1) {
    for (const c of cands) {
      add(c);
      if (Date.now() - t0 >= budgetMs) break;
    }
    if (cands.some(c => c.res.length < done + batch)) break;   // ran out of time mid-round
    done += batch;
    round++;
    // Narrow: after two rounds, and whenever there are too many, keep the
    // better half (always keeping the robot's own play).
    if (round >= 2 || cands.length > maxCands) {
      cands.sort((a, b) => mean(b.res) - mean(a.res));
      const keep = Math.max(2, Math.ceil(cands.length / 2));
      const kept = cands.slice(0, keep);
      const rc = cands.find(c => c.robot);
      if (!kept.includes(rc)) kept.push(rc);
      cands = kept;
    }
  }
  const rc = cands.find(c => c.robot);
  const n = Math.min(...cands.map(c => c.res.length));
  if (n < 2 * batch) return { moves: robot.moves.map(m => m.mv), changed: false, n };
  const at = c => c.res.subarray(0, n);
  let best = rc;
  for (const c of cands) if (mean(at(c)) > mean(at(best))) best = c;
  const clear = best !== rc && mean(at(best)) - mean(at(rc)) > 2 * pairedSE(at(best), at(rc));
  const pick = clear ? best.p : robot;
  return { moves: pick.moves.map(m => m.mv), changed: clear, n };
}
