// GameEngine.js — authoritative rule engine for TurboMarbles
// All game logic lives here. No I/O, no WebSocket knowledge.

import {
  TRACK_SIZE, HOME_SLOTS, MARBLES_PER_PLAYER,
  PLAYER_CONFIG, ARM_MAP, ALL_STARS,
} from '../public/js/constants.js';

// Re-export so consumers that import from GameEngine.js continue to work.
export { TRACK_SIZE, HOME_SLOTS, MARBLES_PER_PLAYER, PLAYER_CONFIG, ARM_MAP, ALL_STARS };

export const CENTER = 'center'; // zone name for the center circle

// --- Marble location helpers ---

export function marbleInBase(marble)   { return marble.zone === 'base'; }
export function marbleOnTrack(marble)  { return marble.zone === 'track'; }
export function marbleInHome(marble)   { return marble.zone === 'home'; }
export function marbleAtCenter(marble) { return marble.zone === 'center'; }

// Advance a track position by n steps (1-indexed, wraps 1–84)
export function advanceTrack(space, n) {
  return ((space - 1 + n) % TRACK_SIZE) + 1;
}

// How many track steps from `from` to `to` going clockwise
export function trackDistance(from, to) {
  return ((to - from + TRACK_SIZE) % TRACK_SIZE) || TRACK_SIZE;
}

// --- State factory ---

export function createGame(players, armIndices) {
  // players: array of { id, name, color, isRobot }
  // armIndices: optional explicit arm index per player (overrides ARM_MAP default)
  // Assign player indices and configs; use ARM_MAP so each player occupies the
  // arm slot appropriate for the player count (opposite for 2p, evenly spaced for 3p, etc.)
  const n = players.length;
  const armMap = armIndices ?? ARM_MAP[n] ?? players.map((_, i) => i);
  const gamePlayers = players.map((p, i) => ({
    ...p,
    index: i,
    config: PLAYER_CONFIG[armMap[i]],
    marbles: Array.from({ length: MARBLES_PER_PLAYER }, (_, m) => ({
      id: m,
      zone: 'base',
      space: null,   // track space (1-84) when zone==='track'
      slot: null,    // home slot (1-4) when zone==='home'
      starEligible: false, // true when sitting on own star space
    })),
  }));

  return {
    players: gamePlayers,
    turnIndex: 0,
    // Phase state machine:
    //   IN_TURN      — waiting for the current player to roll
    //   AWAITING_MOVE — player has rolled; waiting for move(s) or forfeit
    //   EXTRA_ROLL   — player rolled a 6 and earned a bonus roll (back to IN_TURN flow)
    //   GAME_OVER    — a player has moved all marbles into home
    phase: 'IN_TURN',
    dice: null,           // [die0, die1] after roll; null at start of turn
    diceUsed: [false, false],
    winner: null,         // playerIndex of the winner, or null
  };
}

// --- Legal move computation ---

// Returns all legal moves for a single marble and die combination.
// Each move object has at minimum: { type, dieIndex, marbleId }
// plus zone-specific fields (toStar, toSlot, toZone, toSpace).
//
// Move types by zone:
//   base    → exitBase      (die 1 or 6, start space must be clear of own marble)
//   center  → exitCenter    (die 1 only; land exactly on any star not blocked by own marble)
//   track   → enterCenter   (dieVal = stepsToAnyStar + 1; marble diverts 1 step into center
//                            instead of continuing past the star)
//             moveStar      (marble is starEligible; travels K stars clockwise on the star
//                            track, then optionally continues on main track with remaining
//                            dieVal−K steps; toZone/toSpace describe the final position)
//             move          (normal step forward on main track; may enter home stretch)
//   home    → moveHome      (advance within home slots; cannot overshoot HOME_SLOTS)
export function legalMovesForDie(state, playerIndex, dieIndex, marbleId) {
  const player = state.players[playerIndex];
  const dieVal = state.dice[dieIndex];
  const marble = player.marbles[marbleId];
  const moves = [];

  if (marbleInBase(marble)) {
    if (dieVal === 1 || dieVal === 6) {
      // Can only exit if start space is not blocked by own marble
      if (!ownMarbleAt(player, { zone: 'track', space: player.config.start })) {
        moves.push({ type: 'exitBase', dieIndex, marbleId, toZone: 'track', toSpace: player.config.start });
      }
    }
    return moves;
  }

  if (marbleAtCenter(marble)) {
    // Exit requires die=1 — the center hub is exactly 1 step from any star.
    if (dieVal === 1) {
      for (const cfg of PLAYER_CONFIG) {
        if (!ownMarbleAt(player, { zone: 'track', space: cfg.star })) {
          moves.push({ type: 'exitCenter', dieIndex, marbleId, toZone: 'track', toSpace: cfg.star, toStar: cfg.star });
        }
      }
    }
    // die=6: full circuit of all 6 stars, returning to center (strategic no-op)
    if (dieVal === 6) {
      moves.push({ type: 'circleCenter', dieIndex, marbleId, toZone: 'center' });
    }
    return moves;
  }

  if (marbleOnTrack(marble)) {
    // Enter center: the center hub is 1 step past any star on a shortcut branch.
    // Any marble on the main track whose die count lands it exactly 1 step past
    // any star (dieVal = stepsToThatStar + 1) may divert into center instead.
    const enterStarSpace = canEnterCenter(player, marble, dieVal);
    if (enterStarSpace !== null) {
      moves.push({ type: 'enterCenter', dieIndex, marbleId, toZone: 'center', viaStarSpace: enterStarSpace });
    }

    // Star-track movement: when sitting on any star (starEligible), the marble
    // may travel around the inner star circle instead of the main track.
    // Each step on the star track advances to the next star clockwise.
    // After K star-steps the marble may either stop on that star or exit onto
    // the main track and continue the remaining (dieVal−K) steps from there.
    if (marble.starEligible) {
      moves.push(...legalMovesViaStarTrack(state, player, marble, dieIndex, marbleId));
    }

    // Normal main-track movement (may redirect into home stretch)
    const dest = computeTrackMove(state, player, marble, dieVal);
    if (dest) {
      moves.push({ type: 'move', dieIndex, marbleId, ...dest });
      // If the move enters home, also offer passing the home entry and continuing on track
      if (dest.toZone === 'home') {
        const passHome = computeTrackMove(state, player, marble, dieVal, true);
        if (passHome) moves.push({ type: 'move', dieIndex, marbleId, ...passHome });
      }
    }

    return moves;
  }

  if (marbleInHome(marble)) {
    const targetSlot = marble.slot + dieVal;
    if (targetSlot <= HOME_SLOTS) {
      // Cannot be blocked by own marble in the path
      if (!homePathBlocked(player, marble.slot, targetSlot)) {
        moves.push({ type: 'moveHome', dieIndex, marbleId, toZone: 'home', toSlot: targetSlot });
      }
    }
    // Overshoot (targetSlot > HOME_SLOTS) or blocked → no move available
    return moves;
  }

  return moves;
}

// Returns the star space to divert through when a marble can enter the center hub,
// or null if no such divert is available.  The center is 1 step past ANY star on a
// shortcut branch, so the marble needs exactly (stepsToThatStar + 1) die steps.
// Special-cased guards per star:
//   - the player's homeEntry must not lie along the path before that star
//   - no own marble may block any step of the path up to (and onto) that star
// Note: when the marble IS already on a star, stepsToThatStar is 0 (not 84),
// so dieVal=1 correctly allows entering center from that star.
function canEnterCenter(player, marble, dieVal) {
  const { homeEntry } = player.config;
  for (const starSpace of ALL_STARS) {
    // Distance to this star: 0 if already there, clockwise distance otherwise
    const stepsToStar = marble.space === starSpace ? 0 : trackDistance(marble.space, starSpace);
    if (dieVal !== stepsToStar + 1) continue;

    // homeEntry must not lie on the path before the star
    if (stepsToStar > 0) {
      const stepsToHomeEntry = trackDistance(marble.space, homeEntry);
      if (stepsToHomeEntry <= stepsToStar) continue;
    }

    // Every step toward (and onto) the star must be clear of own marbles
    let pos = marble.space;
    let blocked = false;
    for (let i = 0; i < stepsToStar; i++) {
      pos = advanceTrack(pos, 1);
      if (ownMarbleAtSpace(player, pos)) { blocked = true; break; }
    }
    if (!blocked) return starSpace;
  }
  return null;
}

// The ordered list of star spaces going clockwise around the star track.
const STAR_TRACK = PLAYER_CONFIG.map(c => c.star); // [8, 22, 36, 50, 64, 78]

// Computes all legal moveStar (and enterCenter) moves available via the star track
// for a marble that is currently sitting on a star space (starEligible).
//
// The marble may travel K steps clockwise around the star circle (K = 1..min(dieVal,5)).
// Each step advances to the next star.  An own marble on a star blocks further traversal
// (same rule as on the main track).  After K star-steps the marble can:
//   - stop on that star  (remaining === 0)                     → moveStar
//   - enter the center   (remaining === 1, center is 1 step)   → enterCenter
//   - continue on the main track for remaining steps           → moveStar (toZone from computeTrackMove)
function legalMovesViaStarTrack(state, player, marble, dieIndex, marbleId) {
  const dieVal = state.dice[dieIndex];
  const moves = [];
  const startIdx = STAR_TRACK.indexOf(marble.space);
  if (startIdx === -1) return moves; // safety: marble not on a star

  for (let k = 1; k <= Math.min(dieVal, 5); k++) {
    const exitStar = STAR_TRACK[(startIdx + k) % 6];

    // Own marble on this star blocks further traversal around the ring
    if (ownMarbleAtSpace(player, exitStar)) break;

    const remaining = dieVal - k;

    // Build the list of star spaces visited so far (for path animation)
    const starsPath = [];
    for (let i = 1; i <= k; i++) starsPath.push(STAR_TRACK[(startIdx + i) % 6]);

    if (remaining === 0) {
      // Stop on this star
      moves.push({ type: 'moveStar', dieIndex, marbleId, toZone: 'track', toSpace: exitStar, starsPath });
    } else if (remaining === 1) {
      // Enter center from this star (center is exactly 1 step from any star)
      moves.push({ type: 'enterCenter', dieIndex, marbleId, toZone: 'center', viaStarSpace: exitStar, starsPath: [...starsPath] });
      // OR continue 1 step on main track from this star
      const tempMarble = { zone: 'track', space: exitStar };
      const dest = computeTrackMove(state, player, tempMarble, 1);
      if (dest) moves.push({ type: 'moveStar', dieIndex, marbleId, toZone: dest.toZone, toSpace: dest.toSpace, toSlot: dest.toSlot, starsPath });
    } else {
      // Continue on main track with remaining steps from exitStar
      const tempMarble = { zone: 'track', space: exitStar };
      const dest = computeTrackMove(state, player, tempMarble, remaining);
      if (dest) moves.push({ type: 'moveStar', dieIndex, marbleId, toZone: dest.toZone, toSpace: dest.toSpace, toSlot: dest.toSlot, starsPath });
    }
  }
  return moves;
}

// Compute where a track marble ends up after moving dieVal steps clockwise.
// Returns { toZone, toSpace?, toSlot? } or null if the move is blocked.
//
// When ignoreHome=true, the player chooses to pass their home entry and continue
// on the main track (going around the board again instead of entering home).
//
// Special cases (checked in order, unless ignoreHome=true):
//  1. The path crosses the player's homeEntry — redirect into the home stretch.
//     stepsIntoHome = remaining steps after entering home.
//     stepsIntoHome === 0  → lands on the entry square → slot 1
//     stepsIntoHome  > 0  → advances that many slots deeper into home
//     Overshoot (targetSlot > HOME_SLOTS) or blocked → null (no move)
//  2. An own marble occupies any square along the path → blocked → null.
function computeTrackMove(state, player, marble, dieVal, ignoreHome = false) {
  const { homeEntry } = player.config;
  let pos = marble.space;

  for (let step = 1; step <= dieVal; step++) {
    const next = advanceTrack(pos, 1);

    // Check: does this step cross or land on homeEntry?
    if (!ignoreHome && (pos === homeEntry || (crossesHome(pos, homeEntry, next)))) {
      const stepsToEntry = (marble.space === homeEntry) ? 0 : trackDistance(marble.space, homeEntry);
      const stepsIntoHome = dieVal - stepsToEntry;
      if (stepsIntoHome === 0) {
        // Lands exactly on homeEntry — enters slot 1
        if (!homePathBlocked(player, 0, 1)) {
          return { toZone: 'home', toSlot: 1 };
        }
        return null;
      }
      const targetSlot = stepsIntoHome;
      if (targetSlot <= HOME_SLOTS && !homePathBlocked(player, 0, targetSlot)) {
        return { toZone: 'home', toSlot: targetSlot };
      }
      return null; // overshoot or blocked
    }

    // A player's own marble blocks movement through and onto any track square.
    if (ownMarbleAtSpace(player, next)) return null;

    pos = next;
  }

  return { toZone: 'track', toSpace: pos };
}

// Returns true if a single clockwise step from `prev` to `next` crosses the
// player's homeEntry boundary.  Handles the track wrap-around (space 84 → 1).
//   No wrap  (next > prev): homeEntry is crossed if it sits strictly between prev and next.
//   Wrapped  (next < prev): homeEntry is crossed if it's beyond prev OR at/before next.
function crossesHome(prev, homeEntry, next) {
  if (next > prev) return prev < homeEntry && homeEntry <= next;
  return prev < homeEntry || homeEntry <= next;
}

// Returns true if the player already has a marble at the given location.
function ownMarbleAt(player, loc) {
  return player.marbles.some(m => {
    if (m.zone !== loc.zone) return false;
    if (loc.zone === 'track')  return m.space === loc.space;
    if (loc.zone === 'home')   return m.slot  === loc.slot;
    return true; // center — only one marble can be in center
  });
}

function ownMarbleAtSpace(player, space) {
  return player.marbles.some(m => m.zone === 'track' && m.space === space);
}

function homePathBlocked(player, fromSlot, toSlot) {
  for (let s = fromSlot + 1; s <= toSlot; s++) {
    if (player.marbles.some(m => m.zone === 'home' && m.slot === s)) return true;
  }
  return false;
}

// All legal moves for a player given the current dice state.
// Returns { dieIndex -> moves[] } for each unused die.
export function allLegalMoves(state, playerIndex) {
  const result = {};
  for (let dieIdx = 0; dieIdx < 2; dieIdx++) {
    if (state.diceUsed[dieIdx]) continue;
    const moves = [];
    const player = state.players[playerIndex];
    for (let m = 0; m < MARBLES_PER_PLAYER; m++) {
      moves.push(...legalMovesForDie(state, playerIndex, dieIdx, m));
    }
    result[dieIdx] = moves;
  }
  return result;
}

// --- Path computation for animation ---

// Returns an ordered array of { zone, space?, slot?, playerIndex? } waypoints
// representing every intermediate position a marble passes through during a move.
// Must be called BEFORE state is mutated (reads current marble position).
function computeMovePath(state, playerIndex, move) {
  const player = state.players[playerIndex];
  const marble = player.marbles[move.marbleId];
  const dieVal = state.dice[move.dieIndex];
  const { homeEntry } = player.config;
  const path = [];

  if (move.type === 'exitBase') {
    path.push({ zone: 'track', space: player.config.start });
    return path;
  }

  if (move.type === 'move') {
    if (move.toZone === 'track') {
      let pos = marble.space;
      for (let i = 0; i < dieVal; i++) {
        pos = advanceTrack(pos, 1);
        path.push({ zone: 'track', space: pos });
      }
    } else {
      // track → home: walk track steps to homeEntry, then home slots
      const stepsToHome = trackDistance(marble.space, homeEntry);
      let pos = marble.space;
      for (let i = 0; i < stepsToHome; i++) {
        pos = advanceTrack(pos, 1);
        path.push({ zone: 'track', space: pos });
      }
      for (let s = 1; s <= move.toSlot; s++) {
        path.push({ zone: 'home', slot: s, playerIndex });
      }
    }
    return path;
  }

  if (move.type === 'moveHome') {
    for (let s = marble.slot + 1; s <= move.toSlot; s++) {
      path.push({ zone: 'home', slot: s, playerIndex });
    }
    return path;
  }

  if (move.type === 'enterCenter') {
    if (move.starsPath) {
      // Arrived via star track — starsPath lists each star visited
      for (const s of move.starsPath) path.push({ zone: 'track', space: s });
    } else if (move.viaStarSpace !== undefined) {
      // Arrived from main track through viaStarSpace — walk there first
      const stepsToStar = marble.space === move.viaStarSpace ? 0
        : trackDistance(marble.space, move.viaStarSpace);
      let pos = marble.space;
      for (let i = 0; i < stepsToStar; i++) {
        pos = advanceTrack(pos, 1);
        path.push({ zone: 'track', space: pos });
      }
    }
    path.push({ zone: 'center' });
    return path;
  }

  if (move.type === 'exitCenter') {
    path.push({ zone: 'track', space: move.toStar });
    return path;
  }

  if (move.type === 'circleCenter') {
    return path; // strategic no-op — no visual waypoints
  }

  if (move.type === 'moveStar') {
    const starsPath = move.starsPath ?? [];
    for (const s of starsPath) path.push({ zone: 'track', space: s });

    const exitStar = starsPath.length > 0 ? starsPath[starsPath.length - 1] : marble.space;
    const k = starsPath.length;
    const remaining = dieVal - k;

    if (move.toZone === 'track' && remaining > 0) {
      let pos = exitStar;
      for (let i = 0; i < remaining; i++) {
        pos = advanceTrack(pos, 1);
        path.push({ zone: 'track', space: pos });
      }
    } else if (move.toZone === 'home') {
      const stepsToHome = trackDistance(exitStar, homeEntry);
      let pos = exitStar;
      for (let i = 0; i < stepsToHome; i++) {
        pos = advanceTrack(pos, 1);
        path.push({ zone: 'track', space: pos });
      }
      for (let s = 1; s <= move.toSlot; s++) {
        path.push({ zone: 'home', slot: s, playerIndex });
      }
    }
    return path;
  }

  return path;
}

// --- Apply a move (mutates state, returns events array) ---

export function applyMove(state, playerIndex, move) {
  const events = [];
  const player = state.players[playerIndex];
  const marble = player.marbles[move.marbleId];

  // Compute animation path before mutating state
  const path = computeMovePath(state, playerIndex, move);

  if (move.type === 'exitBase') {
    const dest = player.config.start;
    const bumped = findMarbleAt(state, playerIndex, 'track', dest);
    if (bumped) { bumpMarble(state, bumped, events); }
    marble.zone = 'track';
    marble.space = dest;
    marble.starEligible = ALL_STARS.has(dest);
    events.push({ event: 'marbleMoved', playerIndex, marbleId: move.marbleId,
      from: { zone: 'base' }, to: { zone: 'track', space: dest }, path });

  } else if (move.type === 'move') {
    const from = { zone: 'track', space: marble.space };
    if (move.toZone === 'track') {
      const bumped = findMarbleAt(state, playerIndex, 'track', move.toSpace);
      if (bumped) { bumpMarble(state, bumped, events); }
      marble.space = move.toSpace;
      marble.starEligible = ALL_STARS.has(move.toSpace);
      events.push({ event: 'marbleMoved', playerIndex, marbleId: move.marbleId,
        from, to: { zone: 'track', space: move.toSpace }, path });
    } else {
      // entering home
      marble.zone = 'home';
      marble.space = null;
      marble.slot = move.toSlot;
      marble.starEligible = false;
      events.push({ event: 'marbleMoved', playerIndex, marbleId: move.marbleId,
        from, to: { zone: 'home', slot: move.toSlot }, path });
    }

  } else if (move.type === 'moveHome') {
    const from = { zone: 'home', slot: marble.slot };
    marble.slot = move.toSlot;
    events.push({ event: 'marbleMoved', playerIndex, marbleId: move.marbleId,
      from, to: { zone: 'home', slot: move.toSlot }, path });

  } else if (move.type === 'enterCenter') {
    const from = { zone: 'track', space: marble.space };
    const bumped = findMarbleAtCenter(state, playerIndex);
    if (bumped) { bumpMarble(state, bumped, events); }
    marble.zone = 'center';
    marble.space = null;
    marble.starEligible = false;
    events.push({ event: 'marbleMoved', playerIndex, marbleId: move.marbleId,
      from, to: { zone: 'center' }, path });

  } else if (move.type === 'exitCenter') {
    const from = { zone: 'center' };
    const bumped = findMarbleAt(state, playerIndex, 'track', move.toStar);
    if (bumped) { bumpMarble(state, bumped, events); }
    marble.zone = 'track';
    marble.space = move.toStar;
    marble.starEligible = true;
    events.push({ event: 'marbleMoved', playerIndex, marbleId: move.marbleId,
      from, to: { zone: 'track', space: move.toStar }, path });

  } else if (move.type === 'circleCenter') {
    // Marble does a full circuit of all 6 stars and returns to center — strategic no-op.
    events.push({ event: 'marbleMoved', playerIndex, marbleId: move.marbleId,
      from: { zone: 'center' }, to: { zone: 'center' }, path });

  } else if (move.type === 'moveStar') {
    // Marble traveled along the star track (K steps to a star, then optionally
    // continued on the main track).  Only the final landing position is bumped.
    const from = { zone: 'track', space: marble.space };
    if (move.toZone === 'track') {
      const bumped = findMarbleAt(state, playerIndex, 'track', move.toSpace);
      if (bumped) { bumpMarble(state, bumped, events); }
      marble.zone = 'track';
      marble.space = move.toSpace;
      marble.starEligible = ALL_STARS.has(move.toSpace);
      events.push({ event: 'marbleMoved', playerIndex, marbleId: move.marbleId,
        from, to: { zone: 'track', space: move.toSpace }, path });
    } else {
      // continued from star track into home stretch
      marble.zone = 'home';
      marble.space = null;
      marble.slot = move.toSlot;
      marble.starEligible = false;
      events.push({ event: 'marbleMoved', playerIndex, marbleId: move.marbleId,
        from, to: { zone: 'home', slot: move.toSlot }, path });
    }
  }

  state.diceUsed[move.dieIndex] = true;

  // Check win: all 4 marbles in the home zone.
  // Note: this checks zone only, not that every marble is in slot 4 (the final
  // slot).  A marble entering slot 1–3 counts toward the win total.  This is
  // intentional — a player wins as soon as all marbles have entered home,
  // regardless of which slot they occupy.
  if (player.marbles.every(m => m.zone === 'home')) {
    state.phase = 'GAME_OVER';
    state.winner = playerIndex;
    events.push({ event: 'gameOver', winnerIndex: playerIndex });
  }

  return events;
}

// --- Dice ---

export function rollDice() {
  return [
    Math.floor(Math.random() * 6) + 1,
    Math.floor(Math.random() * 6) + 1,
  ];
}

// After both dice used: does this roll earn an extra roll?
export function earnsExtraRoll(dice) {
  return dice[0] === 6 || dice[1] === 6;
}

// --- Bump helper ---

function bumpMarble(state, { ownerIndex, marbleId }, events) {
  const marble = state.players[ownerIndex].marbles[marbleId];
  const from = marble.zone === 'center'
    ? { zone: 'center' }
    : { zone: marble.zone, space: marble.space };
  marble.zone = 'base';
  marble.space = null;
  marble.slot = null;
  marble.starEligible = false;
  events.push({ event: 'marbleBumped', ownerIndex, marbleId, from });
}

function findMarbleAt(state, excludePlayer, zone, space) {
  for (let pi = 0; pi < state.players.length; pi++) {
    if (pi === excludePlayer) continue;
    for (let mi = 0; mi < MARBLES_PER_PLAYER; mi++) {
      const m = state.players[pi].marbles[mi];
      if (m.zone === zone && m.space === space) {
        return { ownerIndex: pi, marbleId: mi };
      }
    }
  }
  return null;
}

function findMarbleAtCenter(state, excludePlayer) {
  for (let pi = 0; pi < state.players.length; pi++) {
    if (pi === excludePlayer) continue;
    for (let mi = 0; mi < MARBLES_PER_PLAYER; mi++) {
      if (state.players[pi].marbles[mi].zone === 'center') {
        return { ownerIndex: pi, marbleId: mi };
      }
    }
  }
  return null;
}

// --- Turn advancement ---

export function nextTurn(state) {
  state.turnIndex = (state.turnIndex + 1) % state.players.length;
  state.dice = null;
  state.diceUsed = [false, false];
  state.phase = 'IN_TURN';
}

export function startExtraRoll(state) {
  state.dice = null;
  state.diceUsed = [false, false];
  state.phase = 'EXTRA_ROLL';
}
