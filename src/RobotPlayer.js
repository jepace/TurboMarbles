// RobotPlayer.js — heuristic robot player
// WIN_SCORE must be higher than any non-winning score so the robot always
// chooses a winning move first, regardless of other heuristic values.
const WIN_SCORE = 10000;

// Move scores (highest first):
//   1. Win move (place last marble in final home slot)
//   2. Moves into and within home, scored by home layout (see homeDebt)
//   3. Positional moves (track, star track, hub, leaving base), ranked by how
//      much they cut the marble's estimated distance to home — see distToHome —
//      plus the progress an opponent loses when the move bumps it
//   4. Shuffling a marble forward inside home (safe there; only when nothing
//      else is useful)
// A whole roll is planned: both dice, both orders (pickNextRobotMove).

import { allLegalMoves, applyMove, TRACK_SIZE, ALL_STARS } from './GameEngine.js';
import { lookup } from './EndgameTable.js';
import { isDuel, duelWinChance } from './DuelTable.js';
import { earnsExtraRoll } from './GameEngine.js';

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
//
// Danger: every candidate's score has the expected cost of being bumped
// before the robot's next turn subtracted (see threatMap / risk).
export function pickNextRobotMove(game, playerIndex) {
  if (game.diceUsed[0] && game.diceUsed[1]) return null;
  if (isDuel(game)) return pickWithDuel(game, playerIndex);
  const threats = RISK_WEIGHT > 0 ? threatMap(game, playerIndex) : null;
  if (lookup(game.players[playerIndex])) return pickWithTable(game, playerIndex, threats);
  const locs = marbleLocs(game, playerIndex);
  if (game.diceUsed[0] || game.diceUsed[1]) {
    return bestSingleMove(game, playerIndex, locs, new Set(), threats).move;
  }

  let best = null, bestScore = -Infinity;
  for (const first of candidateMoves(game, playerIndex)) {
    const s1 = scoreMove(game, playerIndex, first);
    let total;
    if (s1 >= WIN_SCORE) {
      total = s1;
    } else {
      const after = structuredClone(game);
      applyMove(after, playerIndex, first);
      const locs1    = withMove(locs, first);
      const removed1 = bumpedBy(game, playerIndex, first, new Set());
      total = s1 + bestSingleMove(after, playerIndex, locs1, removed1, threats).score;
    }
    if (total > bestScore) { bestScore = total; best = first; }
  }
  return best;
}

// ---- Last-marble duel: exact values ----------------------------------------
//
// Two players, each down to one marble (the rest in h2–h4): play the roll the
// way that maximises the exact chance to win (src/DuelTable.js). That covers
// racing, hitting, and waiting out of reach until the other marble has passed.
function pickWithDuel(game, playerIndex) {
  const next = earnsExtraRoll(game.dice) ? playerIndex : 1 - playerIndex;
  const value = g => g.winner != null ? (g.winner === playerIndex ? 1 : 0)
    : duelWinChance(g, playerIndex, next) ?? 0;
  const apply = (g, mv) => { const g2 = structuredClone(g); applyMove(g2, playerIndex, mv); return g2; };
  let best = null, bestV = -1;
  for (const first of candidateMoves(game, playerIndex)) {
    const g1 = apply(game, first);
    const second = g1.winner != null || (g1.diceUsed[0] && g1.diceUsed[1]) ? [] : candidateMoves(g1, playerIndex);
    const v = second.length ? Math.max(...second.map(m2 => value(apply(g1, m2)))) : value(g1);
    if (v > bestV) { bestV = v; best = first; }
  }
  return best;
}

// ---- Endgame: exact race values from the precomputed table -----------------
//
// When every robot marble is home or within the table's region (the last
// squares before home, plus the hub), each way of playing the roll is scored
// by the table's exact expected turns to finish from the resulting position,
// converted to move-score points, minus the danger cost (opponents can still
// pass through those squares) plus the bump bonus. See src/EndgameTable.js.
function pickWithTable(game, playerIndex, threats) {
  const six = game.dice.includes(6); // a 6 means this turn continues
  const evaluate = after => {
    const entry = lookup(after.players[playerIndex]);
    if (!entry) return -1e6;           // left the region (only when forced)
    const turns = entry[0] === 0 ? 0 : (six ? entry[0] - 1 : entry[0]);
    let score = -TURN_POINTS * turns;
    // Opponent marbles sent back to base by this roll stop being threats.
    const removed = new Set();
    game.players.forEach((p, o) => {
      if (o === playerIndex) return;
      p.marbles.forEach((m, id) => {
        if (m.zone !== 'base' && after.players[o].marbles[id].zone === 'base') {
          removed.add(`${o}:${id}`);
          score += bumpValue(game, o, m);
        }
      });
    });
    if (threats) score -= risk(after, playerIndex, marbleLocs(after, playerIndex), removed, threats);
    return score;
  };
  const apply = (g, mv) => { const g2 = structuredClone(g); applyMove(g2, playerIndex, mv); return g2; };

  let best = null, bestScore = -Infinity;
  for (const first of candidateMoves(game, playerIndex)) {
    const g1 = apply(game, first);
    let score;
    const second = g1.winner != null ? [] : candidateMoves(g1, playerIndex);
    if (second.length === 0) score = evaluate(g1);
    else score = Math.max(...second.map(m2 => evaluate(apply(g1, m2))));
    if (score > bestScore) { bestScore = score; best = first; }
  }
  return best;
}

// Points per turn when converting table values (expected turns) into move
// scores. A turn covers ~8.4 pips on average (about 1.2 rolls of 7) and a pip
// is worth 5 points elsewhere in the scoring, hence ~42.
const TURN_POINTS = 42;

// Best move for the unused die(s) in this position, and its score net of the
// danger it leaves the robot's marbles in. With no move available, the score
// is NO_MOVE_SCORE net of the danger of staying put.
//   locs:    the robot's marble locations in this position (location keys)
//   removed: opponent marbles already bumped this roll (no longer a threat)
function bestSingleMove(game, playerIndex, locs, removed, threats) {
  let move = null, score = -Infinity;
  for (const m of candidateMoves(game, playerIndex)) {
    let s = scoreMove(game, playerIndex, m);
    if (s < WIN_SCORE && threats) {
      s -= risk(game, playerIndex, withMove(locs, m), bumpedBy(game, playerIndex, m, removed), threats);
    }
    if (s > score) { score = s; move = m; }
  }
  if (move) return { move, score };
  const stay = threats ? risk(game, playerIndex, locs, removed, threats) : 0;
  return { move: null, score: NO_MOVE_SCORE - stay };
}

// ---- Danger model -----------------------------------------------------------
//
// For each opponent and each die value 1–6, ask the rules engine where that
// opponent's marbles could land with that single die (track, star track, hub
// entry, leaving base or the hub). A robot marble on such a square can be
// bumped before the robot moves again. Hits needing both dice on one marble
// are ignored (an approximation that keeps this fast). Opponents' reach
// doesn't depend on the robot's marbles (only a player's own marbles block),
// so it is computed once per decision; an opponent marble the robot bumps
// this roll is no longer a threat.
//
// Cost of a robot marble = P(hit) × (progress lost if sent back to base),
// in the same units as move scores (5 per pip), × RISK_WEIGHT.

// Tuned by self-play vs the planning robot without it: 0.375 won in 2-, 3-,
// 4- and 6-player games (+1–2 points); 1 or more made the robot too timid.
const RISK_WEIGHT = 0.375;

const locKey = loc =>
  loc.zone === 'track' ? `t${loc.space}` : loc.zone === 'center' ? 'c' : loc.zone;

function marbleLocs(game, playerIndex) {
  return game.players[playerIndex].marbles.map(m => locKey(marbleLoc(m)));
}

function withMove(locs, move) {
  const next = locs.slice();
  next[move.marbleId] = locKey(moveDest(move));
  return next;
}

// Opponent marbles sitting where this move lands (they get bumped).
function bumpedBy(game, playerIndex, move, removed) {
  const out = new Set(removed);
  const target = locKey(moveDest(move));
  if (target[0] !== 't' && target !== 'c') return out; // only track and hub landings bump
  game.players.forEach((p, o) => {
    if (o === playerIndex) return;
    p.marbles.forEach((m, id) => { if (locKey(marbleLoc(m)) === target) out.add(`${o}:${id}`); });
  });
  return out;
}

// Map: location key → [{ opp, src: "opp:marbleId", die }]
function threatMap(game, playerIndex) {
  const map = new Map();
  game.players.forEach((_, opp) => {
    if (opp === playerIndex) return;
    for (let die = 1; die <= 6; die++) {
      const probe = { ...game, dice: [die, die], diceUsed: [false, false] };
      for (const mv of allLegalMoves(probe, opp)[0] ?? []) {
        if (mv.toZone === 'home') continue;
        const key = locKey(moveDest(mv));
        if (!map.has(key)) map.set(key, []);
        map.get(key).push({ opp, src: `${opp}:${mv.marbleId}`, die });
      }
    }
  });
  return map;
}

function risk(game, playerIndex, locs, removed, threats) {
  const cfg = game.players[playerIndex].config;
  const baseDist = distToHome(cfg, { zone: 'base' });
  let total = 0;
  for (const key of locs) {
    if (key !== 'c' && key[0] !== 't') continue; // base and home are safe
    const hits = threats.get(key);
    if (!hits) continue;
    // Die values that hit this square, per opponent still able to.
    const byOpp = new Map();
    for (const h of hits) {
      if (removed.has(h.src)) continue;
      if (!byOpp.has(h.opp)) byOpp.set(h.opp, new Set());
      byOpp.get(h.opp).add(h.die);
    }
    let safe = 1;
    for (const dice of byOpp.values()) safe *= ((6 - dice.size) / 6) ** 2; // neither die hits
    const pHit = 1 - safe;
    if (pHit === 0) continue;
    const loc = key === 'c' ? { zone: 'center' } : { zone: 'track', space: Number(key.slice(1)) };
    const lost = Math.max(0, baseDist - distToHome(cfg, loc));
    total += pHit * lost * 5 * RISK_WEIGHT;
  }
  return total;
}

// Legal moves for every unused die. Optional moves (pass home and go around
// again) are never worth it — better to wait next to home and burn the die.
function candidateMoves(game, playerIndex) {
  if (game.phase === 'GAME_OVER') return [];
  const legal = allLegalMoves(game, playerIndex);
  const out = [];
  for (const dieIdx of [0, 1]) {
    if (game.diceUsed[dieIdx]) continue;
    // Optional moves (going round past your own home) only when they hit
    // someone — e.g. hopping round the star track into an occupied hub.
    for (const m of (legal[dieIdx] || [])) if (!m.optional || landsOnOpponent(game, playerIndex, m)) out.push(m);
  }
  return out;
}

function landsOnOpponent(game, playerIndex, move) {
  if (move.toZone !== 'track' && move.toZone !== 'center') return false;
  return game.players.some((p, o) => o !== playerIndex && p.marbles.some(m =>
    move.toZone === 'center' ? m.zone === 'center' : m.zone === 'track' && m.space === move.toSpace));
}

function scoreMove(game, playerIndex, move) {
  const player = game.players[playerIndex];
  const cfg    = player.config; // arm-mapped config, not raw PLAYER_CONFIG index
  const marble = player.marbles[move.marbleId];

  if (move.type === 'moveHome') {
    // isLast: every OTHER marble is already in home — moving this one wins.
    const isLast = player.marbles.every((m, i) => i === move.marbleId || m.zone === 'home');
    if (move.toSlot === 4 && isLast) return WIN_SCORE;
    // Paying off home debt (see homeDebt) is progress: each slot climbed now
    // is an exact roll not needed later.
    const debtBefore = homeDebt(homeSlots(player));
    const debtAfter  = homeDebt(homeSlots(player, move.marbleId, move.toSlot));
    return 200 + HOME_STEP * (debtBefore - debtAfter);
  }

  if (move.toZone === 'home') {
    // Entering home: progress to the entry, plus a bonus for reaching home,
    // minus any debt the new layout adds. Entering slot 1 under an empty
    // slot 4 leaves marbles that must climb one exact roll at a time.
    const debtBefore = homeDebt(homeSlots(player));
    const debtAfter  = homeDebt([...homeSlots(player), move.toSlot]);
    const gain = distToHome(cfg, marbleLoc(marble)); // pips to the entry, all covered
    return 200 + 5 * gain + homeEnterBonus(game.players.length) - HOME_STEP * (debtAfter - debtBefore);
  }

  // Everything else is positional: reward how much the move shortens the
  // marble's estimated trip home. Shortcuts count; positions that need an
  // exact roll to make progress cost extra.
  const before = distToHome(cfg, marbleLoc(marble));
  const after  = distToHome(cfg, moveDest(move));
  // Landing on an opponent sends them back to base: a bonus on top of the
  // move's own positional value, not a flat override. A flat 800 made the
  // robot chase bumps into bad positions — with planning it lost in games of
  // 3+ players, where a bump sets back only one of several rivals.
  let bump = 0;
  // Landing on an opponent — on a track square or in the hub — bumps it.
  if (move.toZone === 'track' || move.toZone === 'center') {
    game.players.forEach((p, o) => {
      if (o === playerIndex) return;
      for (const m of p.marbles) {
        const hit = move.toZone === 'center' ? m.zone === 'center' : m.zone === 'track' && m.space === move.toSpace;
        if (hit) bump += bumpValue(game, o, m);
      }
    });
  }
  return 200 + 5 * (before - after) + bump;
}

// What a bump is worth: the progress the victim loses (its trip from base to
// where it stood), at BUMP_K of the robot's own per-pip value, shared out over
// the opponents (setting back one of several rivals helps less). Sending a
// marble that is one step from home back to base is worth far more than
// hitting one that just came out. Self-play against the flat +50 it replaced:
// 2 players 53.8%, 3 players 34.0%, 4 players 25.0% (even = 50 / 33.3 / 25).
const BUMP_K = 0.75;
function bumpValue(game, o, m) {
  const cfg = game.players[o].config;
  const lost = distToHome(cfg, { zone: 'base' }) - distToHome(cfg, m.zone === 'center' ? { zone: 'center' } : m);
  return BUMP_K * 5 * Math.max(0, lost) / (game.players.length - 1);
}

// ---- Home layout ------------------------------------------------------------
//
// Marbles in home can't pass each other and can't overshoot slot 4, so they
// must end up filling slots 4, 3, 2, 1 from the deepest down. Every slot a
// marble still has to climb to its final slot needs an exact roll later.
// Debt = total of those climbs. E.g. h1 h2 h3 → final h2 h3 h4 → debt 3;
// h2 h4 → final h3 h4 → debt 1.
function homeDebt(slots) {
  return [...slots].sort((a, b) => b - a).reduce((d, slot, i) => d + (4 - i - slot), 0);
}
// Home slots of a player's marbles, optionally with one marble moved to a new slot.
function homeSlots(player, movedId = -1, toSlot = 0) {
  return player.marbles.flatMap((m, i) =>
    i === movedId ? [toSlot] : m.zone === 'home' ? [m.slot] : []);
}
// Value of one slot of home debt, and the bonus for getting a marble home.
// Tuned by self-play against the robot without home debt (old scoring: flat
// 550+ for entering home, ~234 for moving inside it): step 60 / bonus 50 won
// 57.7% of 2-player, 38.5% of 3-player and 26.7% of 4-player games. With 5–6
// players a bigger entry bonus is needed to break even (getting a marble home
// also takes it out of reach of many opponents).
const HOME_STEP = 60;
const homeEnterBonus = players => (players >= 5 ? 150 : 50);

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


// ---- Features for the position evaluator (src/Evaluator.js) ----------------

// A player's race length: the robot's distance-to-home estimate summed over
// their marbles (star shortcuts and the hub included; base marbles count the
// trip from base).
export function racePips(game, playerIndex) {
  const cfg = game.players[playerIndex].config;
  let total = 0;
  for (const m of game.players[playerIndex].marbles) total += distToHome(cfg, marbleLoc(m));
  return total;
}

// Expected pips this player loses to being hit before their next turn (the
// robot's single-die threat model: every opponent's next roll).
export function dangerPips(game, playerIndex) {
  const threats = threatMap(game, playerIndex);
  return risk(game, playerIndex, marbleLocs(game, playerIndex), new Set(), threats) / (5 * RISK_WEIGHT);
}
