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
// loss per unit of cube (error ≥ 0.06, blunder ≥ 0.20, as for moves). With played-out
// estimates, a decision counts as clear only if the right action is the same
// at both ends of the 95% range of the win chance — otherwise it is "close"
// and not counted as an error.
import { exactEstimate, rolloutEstimate, cubefulEquity } from './CubeDecision.js';
import { matchCube, emg } from './MatchEquity.js';

// Same bands as moves (in equity): error ≥ 0.06, blunder ≥ 0.20 (per unit of cube).
export const CUBE_SEVERITY = [{ key: 'blunder', min: 0.20 }, { key: 'error', min: 0.06 }];

const ownerFor = (cube, d) => cube.owner == null ? 'centre' : cube.owner === d ? 'me' : 'opp';

// Values for doubler d (already at the decision's stakes, in equity units):
// money play — Janowski cubeful equity × cube value; match play — match-winning chances
// from the match equity table at the score, shown as equity (EMG).
function equities(est, owner, entry, v) {
  if (entry.match) {
    const r = matchCube(est, { ...entry.match, v, owner });
    return { nd: emg(r.nd, r), dt: emg(r.dt, r), dp: emg(r.dp, r) };
  }
  const nd = v * cubefulEquity(est, owner);
  return { nd, dt: 2 * v * cubefulEquity(est, 'opp'), dp: v };
}
function rightActions(est, owner, entry, v) {
  const { nd, dt, dp } = equities(est, owner, entry, v);
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
  const { nd, dt, dp } = equities(est, owner, entry, v);
  const right = rightActions(est, owner, entry, v);

  // Is the right action clear? Recheck at the ends of the win chance's 95% range.
  let close = false;
  if (!est.exact) {
    const se = Math.sqrt(Math.max(est.p * (1 - est.p), 0.0025) / est.n);
    for (const p of [est.p - 1.96 * se, est.p + 1.96 * se]) {
      const r = rightActions({ ...est, p: Math.min(0.999, Math.max(0.001, p)) }, owner, entry, v);
      if (entry.kind === 'double' ? r.double !== right.double : r.take !== right.take) close = true;
    }
  }

  let options, best, played;
  if (entry.kind === 'double') {
    const dbl = Math.min(dt, dp);
    options = [{ key: 'nd', label: 'No double', eq: nd }, { key: 'dt', label: 'Double / take', eq: dt }, { key: 'dp', label: 'Double / drop', eq: dp }];
    best = right.double ? 'double' : 'no double';
    played = entry.action ? 'double' : 'no double';
    var bestEq = Math.max(nd, dbl), playedEq = entry.action ? dbl : nd;
  } else {
    options = [{ key: 'take', label: 'Take', eq: -dt }, { key: 'drop', label: 'Drop', eq: -dp }];
    best = right.take ? 'take' : 'drop';
    played = entry.action ? 'take' : 'drop';
    var bestEq = Math.max(-dt, -dp), playedEq = entry.action ? -dt : -dp;
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
    severity, close, match: entry.match ?? null,
  };
}
