// CubeAnalysis.js — judging cube decisions (money play): double / no double,
// take / drop. Used for in-game feedback and the post-game analysis.
//
// A decision point is recorded at the start of a turn (before rolling) with
// the position and the cube:
//   { kind: 'double', pi, action }   pi could double; action = doubled or not
//   { kind: 'take',   pi, action, doubler }   pi was doubled; action = took
// For the doubler d with cube value v (before the double), from d's side:
//   ND = v · E(cube as it was)        no double
//   DT = 2v · E(opponent owns it)     double, taken
//   DP = v                            double, dropped
// E is Janowski's cubeful equity (src/CubeDecision.js) from d's chances to win
// and the aggro shares: exact from the duel tables when they apply, else from
// played-out games. Right action: double when min(DT, DP) > ND; take when
// −DT > −DP. The loss is in points at the decision's cube; severity uses the
// loss per point of cube (error ≥ 0.05, blunder ≥ 0.15). With played-out
// estimates, a decision counts as clear only if the right action is the same
// at both ends of the 95% range of the win chance — otherwise it is "close"
// and not counted as an error.
import { exactEstimate, rolloutEstimate, cubefulEquity } from './CubeDecision.js';

export const CUBE_SEVERITY = [{ key: 'blunder', min: 0.15 }, { key: 'error', min: 0.05 }];

const ownerFor = (cube, d) => cube.owner == null ? 'centre' : cube.owner === d ? 'me' : 'opp';

// Equities for doubler d given an estimate (cube value 1; scale by v).
function equities(est, owner) {
  const nd = cubefulEquity(est, owner);
  const dt = 2 * cubefulEquity(est, 'opp');
  return { nd, dt, dp: 1 };
}
function rightActions(est, owner) {
  const { nd, dt, dp } = equities(est, owner);
  return { double: Math.min(dt, dp) > nd, take: -dt > -dp };
}

// entry: { kind, pi, action, doubler?, state } — state is the game at the
// start of the turn (doubler to roll) with state.cube = { value, owner }
// as it was before the double.
export function analyzeCube(entry, { games = 400 } = {}) {
  const st = entry.state;
  const d = entry.kind === 'double' ? entry.pi : entry.doubler;
  const v = st.cube?.value ?? 1;
  const owner = ownerFor(st.cube ?? { owner: null }, d);
  const est = exactEstimate(st, d) ?? rolloutEstimate(st, d, { budgetMs: 0, minGames: games });
  const { nd, dt, dp } = equities(est, owner);
  const right = rightActions(est, owner);

  // Is the right action clear? Recheck at the ends of the win chance's 95% range.
  let close = false;
  if (!est.exact) {
    const se = Math.sqrt(Math.max(est.p * (1 - est.p), 0.0025) / est.n);
    for (const p of [est.p - 1.96 * se, est.p + 1.96 * se]) {
      const r = rightActions({ ...est, p: Math.min(0.999, Math.max(0.001, p)) }, owner);
      if (entry.kind === 'double' ? r.double !== right.double : r.take !== right.take) close = true;
    }
  }

  let options, best, played;
  if (entry.kind === 'double') {
    const dbl = Math.min(dt, dp);
    options = [{ key: 'nd', label: 'No double', eq: v * nd }, { key: 'dt', label: 'Double / take', eq: v * dt }, { key: 'dp', label: 'Double / drop', eq: v * dp }];
    best = right.double ? 'double' : 'no double';
    played = entry.action ? 'double' : 'no double';
    var bestEq = v * Math.max(nd, dbl), playedEq = v * (entry.action ? dbl : nd);
  } else {
    options = [{ key: 'take', label: 'Take', eq: -v * dt }, { key: 'drop', label: 'Drop', eq: -v * dp }];
    best = right.take ? 'take' : 'drop';
    played = entry.action ? 'take' : 'drop';
    var bestEq = Math.max(-v * dt, -v * dp), playedEq = entry.action ? -v * dt : -v * dp;
  }
  const loss = Math.max(0, bestEq - playedEq);
  const lossNorm = loss / v;
  const severity = close || played === best ? 'ok' : (CUBE_SEVERITY.find(s => lossNorm >= s.min)?.key ?? 'ok');
  const forDecider = entry.kind === 'double' ? est : { ...est, p: 1 - est.p, aggroWin: est.aggroLoss, aggroLoss: est.aggroWin };
  // Name the mistake the way backgammon players do.
  const label = played === best ? null
    : entry.kind === 'double' ? (entry.action ? 'Wrong double' : 'Missed double')
    : (entry.action ? 'Wrong take' : 'Wrong drop');
  return {
    kind: entry.kind, action: entry.action, v, best, played, label,
    p: forDecider.p, aggroWin: forDecider.aggroWin, aggroLoss: forDecider.aggroLoss,
    n: est.exact ? null : est.n, exact: !!est.exact,
    options: options.map(o => ({ ...o, eq: Math.round(o.eq * 1000) / 1000 })),
    loss: Math.round(loss * 1000) / 1000, lossNorm: Math.round(lossNorm * 1000) / 1000,
    severity, close,
  };
}
