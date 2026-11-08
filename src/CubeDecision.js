// CubeDecision.js — the robot's doubling-cube decisions (money play, two players).
//
// 1. Estimate, for the player about to roll: p = chance to win, and how many
//    of the wins and losses are aggros (the loser has no marbles home, worth
//    double). Exact from the duel tables when they apply (no aggros possible
//    there); otherwise by playing games out with the robot's strategy.
// 2. Turn that into cube decisions with Janowski's model: cubeful equity is a
//    mix of the dead-cube equity (no more doubling) and the live-cube equity
//    (perfect cube use), weighted by cube efficiency X.
//    W = average points won per win (1 + aggro share), L = average lost per loss.
//      take point TP = (L − ½) / (W + L + ½)     cash point CP = (L + 1) / (W + L + ½)
//    Doubler: double when min(double/take, double/drop) beats no double.
//    Taker:   take when the equity of owning the doubled cube beats −1 (dropping).
import { applyMove, rollDice, earnsExtraRoll } from './GameEngine.js';
import { pickNextRobotMove } from './RobotPlayer.js';
import { duelWinChance } from './DuelTable.js';

export const CUBE_EFFICIENCY = 0.68;          // typical for racing/contact games

// ---- Estimates ---------------------------------------------------------------

// Play the game out from the start of `mover`'s turn (not yet rolled).
// Returns { winner, aggro }.
function playoutFromTurn(g, mover) {
  let turn = mover;
  for (let t = 0; t < 4000 && g.winner == null; t++) {
    let again = true;
    while (again && g.winner == null) {
      g.turnIndex = turn; g.dice = rollDice(); g.diceUsed = [false, false]; g.phase = 'AWAITING_MOVE';
      while (!(g.diceUsed[0] && g.diceUsed[1]) && g.winner == null) {
        const mv = pickNextRobotMove(g, turn);
        if (mv) applyMove(g, turn, mv); else g.diceUsed[g.diceUsed[0] ? 1 : 0] = true;
      }
      again = earnsExtraRoll(g.dice);
    }
    turn = 1 - turn;
  }
  const loser = g.players[1 - g.winner];
  return { winner: g.winner, aggro: !!loser && loser.marbles.every(m => m.zone !== 'home') };
}

// Exact estimate when a duel table covers the position, else null.
export function exactEstimate(game, pi) {
  const p = duelWinChance(game, pi, game.turnIndex);
  return p == null ? null : { p, aggroWin: 0, aggroLoss: 0, n: Infinity, exact: true };
}

// Played-out estimate within a time budget (ms). The cube, the dice and any
// pending offer are ignored: plain cubeless chances from the turn's start.
export function rolloutEstimate(game, pi, { budgetMs = 1200, minGames = 50 } = {}) {
  const t0 = Date.now();
  const start = structuredClone({ players: game.players, turnIndex: game.turnIndex, phase: 'IN_TURN',
    dice: null, diceUsed: [false, false], winner: null, cube: null, cubeOffer: null, result: null });
  let n = 0, wins = 0, aggroWin = 0, aggroLoss = 0;
  while (n < minGames || Date.now() - t0 < budgetMs) {
    const r = playoutFromTurn(structuredClone(start), game.turnIndex);
    n++;
    if (r.winner === pi) { wins++; if (r.aggro) aggroWin++; } else if (r.aggro) aggroLoss++;
    if (n >= 20000) break;
  }
  return { p: wins / n, aggroWin: aggroWin / n, aggroLoss: aggroLoss / n, n, exact: false };
}

// ---- Janowski -----------------------------------------------------------------

// Average value of a win and of a loss, in cube units.
function wl({ p, aggroWin, aggroLoss }) {
  const W = p > 0 ? 1 + aggroWin / p : 1;
  const L = p < 1 ? 1 + aggroLoss / (1 - p) : 1;
  return { W, L };
}

// Cubeful equity per unit of cube value for the player with chance p, given
// who owns the cube: 'me', 'opp' or 'centre'.
export function cubefulEquity(est, owner, x = CUBE_EFFICIENCY) {
  const { p } = est;
  const { W, L } = wl(est);
  const dead = p * W - (1 - p) * L;
  const TP = (L - 0.5) / (W + L + 0.5);        // my take point
  const CP = (L + 1) / (W + L + 0.5);          // my cash point
  const oppCP = 1 - (W + 1) / (W + L + 0.5);   // below this the opponent cashes (from my side)
  let live;
  if (owner === 'me') {
    live = p >= CP ? 1 : -L + (1 + L) * (p / CP);
  } else if (owner === 'opp') {
    live = p <= TP ? -1 : -1 + (W + 1) * ((p - TP) / (1 - TP));
  } else {
    if (p >= CP) live = 1;
    else if (p <= oppCP) live = -1;
    else live = -1 + 2 * ((p - oppCP) / (CP - oppCP));
  }
  return x * live + (1 - x) * dead;
}

// Should the player to roll double? owner = 'me' or 'centre' (cube value v
// cancels out). Returns { double, nd, dt, dp }.
// jacobyUnturned: Jacoby rule with the cube still at 1 — if nobody doubles,
// an aggro counts as a single game, so no-double values ignore aggros.
export function shouldDouble(est, owner, { jacobyUnturned = false } = {}) {
  const nd = cubefulEquity(jacobyUnturned ? { ...est, aggroWin: 0, aggroLoss: 0 } : est, owner);
  const dt = 2 * cubefulEquity(est, 'opp');
  const dp = 1;
  return { double: Math.min(dt, dp) > nd + 1e-9, nd, dt, dp };
}

// Should the player being doubled take? est is from the TAKER's side.
// Taking means owning a cube worth twice as much: 2·E(owned) against −1.
export function shouldTake(est) {
  const take = 2 * cubefulEquity(est, 'me');
  return { take: take > -1, takeEq: take, dropEq: -1 };
}
