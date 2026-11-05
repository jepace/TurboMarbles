// RobotPlayer.js — heuristic robot player
// WIN_SCORE must be higher than any non-winning score so the robot always
// chooses a winning move first, regardless of other heuristic values.
const WIN_SCORE = 10000;

// Move scores (highest first):
//   1. Win move (place last marble in final home slot)
//   2. Enter home from the track
//   3. Positional moves (track, star track, hub, leaving base), ranked by how
//      much they cut the marble's estimated distance to home — see distToHome —
//      plus a bonus when the move bumps an opponent
//   4. Shuffling a marble forward inside home (safe there; only when nothing
//      else is useful)
// A whole roll is planned: both dice, both orders (pickNextRobotMove).

import { allLegalMoves, applyMove, TRACK_SIZE, ALL_STARS } from './GameEngine.js';

// Score of a die that has no move left to make: same as a move that neither
// helps nor hurts (positional moves score 200 + 5 × gain).
const NO_MOVE_SCORE = 200;

// Pick the next move, or null to forfeit the next unused die.
//
// With both dice unused, the robot plans the whole roll: every first move
// (either die), followed by the best second move in the position it creates.
// It plays the first move of the best pair; on the next call (one die left)
// the greedy pick below is exactly the plan's second move. This finds
// combinations the one-die-at-a-time robot missed, e.g. a move that only
// becomes possible after another, or a first move that strands the second die.
export function pickNextRobotMove(game, playerIndex) {
  if (game.diceUsed[0] && game.diceUsed[1]) return null;
  if (game.diceUsed[0] || game.diceUsed[1]) return bestSingleMove(game, playerIndex).move;

  let best = null, bestScore = -Infinity;
  for (const first of candidateMoves(game, playerIndex)) {
    const s1 = scoreMove(game, playerIndex, first);
    let total;
    if (s1 >= WIN_SCORE) {
      total = s1;
    } else {
      const after = structuredClone(game);
      applyMove(after, playerIndex, first);
      total = s1 + bestSingleMove(after, playerIndex).score;
    }
    if (total > bestScore) { bestScore = total; best = first; }
  }
  return best;
}

// Best move for the unused die(s) in this position, and its score
// (NO_MOVE_SCORE if no move is available).
function bestSingleMove(game, playerIndex) {
  let move = null, score = -Infinity;
  for (const m of candidateMoves(game, playerIndex)) {
    const s = scoreMove(game, playerIndex, m);
    if (s > score) { score = s; move = m; }
  }
  return move ? { move, score } : { move: null, score: NO_MOVE_SCORE };
}

// Legal moves for every unused die. Optional moves (pass home and go around
// again) are never worth it — better to wait next to home and burn the die.
function candidateMoves(game, playerIndex) {
  if (game.phase === 'GAME_OVER') return [];
  const legal = allLegalMoves(game, playerIndex);
  const out = [];
  for (const dieIdx of [0, 1]) {
    if (game.diceUsed[dieIdx]) continue;
    for (const m of (legal[dieIdx] || [])) if (!m.optional) out.push(m);
  }
  return out;
}

function scoreMove(game, playerIndex, move) {
  const player = game.players[playerIndex];
  const cfg    = player.config; // arm-mapped config, not raw PLAYER_CONFIG index
  const marble = player.marbles[move.marbleId];

  if (move.type === 'moveHome') {
    // isLast: every OTHER marble is already in home — moving this one wins.
    const isLast = player.marbles.every((m, i) => i === move.marbleId || m.zone === 'home');
    if (move.toSlot === 4 && isLast) return WIN_SCORE;
    // Worth about as much as a good 6-pip track move: below big shortcuts
    // (leaving the hub onto the pre-home star scores ~255), but above any move
    // that makes a marble's position worse. Self-play: scoring this below
    // neutral (190) dropped the robot from ~62% to ~40% vs the old robot,
    // because it then preferred harmful moves to a safe shuffle in home.
    return 230 + move.toSlot;
  }

  if (move.toZone === 'home') return 550 + move.toSlot * 40; // entering home

  // Everything else is positional: reward how much the move shortens the
  // marble's estimated trip home. Shortcuts count; positions that need an
  // exact roll to make progress cost extra.
  const before = distToHome(cfg, marbleLoc(marble));
  const after  = distToHome(cfg, moveDest(move));
  // Landing on an opponent sends them back to base: a bonus on top of the
  // move's own positional value, not a flat override. A flat 800 made the
  // robot chase bumps into bad positions — with planning it lost in games of
  // 3+ players, where a bump sets back only one of several rivals.
  const bump = move.toZone === 'track' && bumpsOpponent(game, playerIndex, move.toSpace, 'track');
  return 200 + 5 * (before - after) + (bump ? BUMP_BONUS : 0);
}

// Tuned by self-play (planning robot vs the previous robot): 50 wins in 2-,
// 3-, 4- and 6-player games; 0 and ≥ 300 do worse with 3+ players.
const BUMP_BONUS = 50;

// ---- Distance-to-home estimate --------------------------------------------
//
// Measured in pips to this player's home entry. A marble can walk the main
// track, or reach any star and hop along the star track to the star just
// before its home entry ("pre-home star", homeEntry − 6), then walk 6.
// Penalties stand in for waiting on a specific roll:
const P_LAND = 5;   // must land exactly on a star before star-hopping
const P_HUB  = 10;  // leaving the hub needs exactly a 1 (11/36 per turn)
const P_BASE = 10;  // leaving base needs a 1 or 6 (20/36 per turn)

const STARS = [...ALL_STARS].sort((a, b) => a - b); // clockwise order

function preHomeStar(cfg) {
  return ((cfg.homeEntry - 6 - 1 + TRACK_SIZE) % TRACK_SIZE) + 1;
}

// Star hops from star X to the pre-home star.
function starHops(cfg, star) {
  const n = STARS.length;
  return (STARS.indexOf(preHomeStar(cfg)) - STARS.indexOf(star) + n) % n;
}

function distToHome(cfg, loc) {
  if (loc.zone === 'home')   return 0;
  if (loc.zone === 'center') return 1 + 6 + P_HUB;   // 1 onto pre-home star, walk 6
  if (loc.zone === 'base')   return distToHome(cfg, { zone: 'track', space: cfg.start }) + P_BASE;

  const s    = loc.space;
  const walk = (cfg.homeEntry - s + TRACK_SIZE) % TRACK_SIZE;
  // Nearest star at or ahead of s (0 steps if already on one).
  let k = Infinity, star = null;
  for (const st of STARS) {
    const d = (st - s + TRACK_SIZE) % TRACK_SIZE;
    if (d < k) { k = d; star = st; }
  }
  const viaStars = k + (k > 0 ? P_LAND : 0) + starHops(cfg, star) + 6;
  return Math.min(walk, viaStars);
}

function marbleLoc(m) {
  if (m.zone === 'track') return { zone: 'track', space: m.space };
  return { zone: m.zone };
}

function moveDest(move) {
  if (move.toZone === 'center') return { zone: 'center' };
  if (move.toZone === 'home')   return { zone: 'home' };
  return { zone: 'track', space: move.toSpace };
}

function bumpsOpponent(game, playerIndex, space, zone) {
  return game.players.some((p, pi) =>
    pi !== playerIndex &&
    p.marbles.some(m => m.zone === zone && m.space === space)
  );
}
