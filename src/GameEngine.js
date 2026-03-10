// GameEngine.js — authoritative rule engine for TurboMarbles
// All game logic lives here. No I/O, no WebSocket knowledge.

// Board constants
export const TRACK_SIZE = 84;         // total squares in the outer ring (1-indexed)
export const HOME_SLOTS = 4;          // slots in each player's home stretch (1–4)
export const MARBLES_PER_PLAYER = 4;  // marbles per player
export const CENTER = 'center';       // zone name for the center circle

// Per-player constants indexed by player index 0-5
export const PLAYER_CONFIG = [
  { color: 'yellow', start: 1,  star: 8,  homeEntry: 84 },
  { color: 'orange', start: 15, star: 22, homeEntry: 14 },
  { color: 'pink',   start: 29, star: 36, homeEntry: 28 },
  { color: 'white',  start: 43, star: 50, homeEntry: 42 },
  { color: 'green',  start: 57, star: 64, homeEntry: 56 },
  { color: 'blue',   start: 71, star: 78, homeEntry: 70 },
];

export const ALL_STARS = new Set(PLAYER_CONFIG.map(p => p.star));

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

export function createGame(players) {
  // players: array of { id, name, color, isRobot }
  // Assign player indices and configs
  const gamePlayers = players.map((p, i) => ({
    ...p,
    index: i,
    config: PLAYER_CONFIG[i],
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
//   center  → exitCenter    (die 1 only, choose any star not blocked by own marble)
//   track   → enterCenter   (die 1, marble must be starEligible — sitting on own star)
//             move          (normal step forward; may enter home stretch)
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
        moves.push({ type: 'exitBase', dieIndex, marbleId });
      }
    }
    return moves;
  }

  if (marbleAtCenter(marble)) {
    if (dieVal === 1) {
      // Can exit to any star (that isn't blocked by own marble)
      for (const cfg of PLAYER_CONFIG) {
        if (!ownMarbleAt(player, { zone: 'track', space: cfg.star })) {
          moves.push({ type: 'exitCenter', dieIndex, marbleId, toStar: cfg.star });
        }
      }
    }
    return moves;
  }

  if (marbleOnTrack(marble)) {
    // Option A: enter center via star (marble must be sitting on its own star)
    if (marble.starEligible && dieVal === 1) {
      moves.push({ type: 'enterCenter', dieIndex, marbleId });
    }

    // Option B: normal track movement (may redirect into home stretch)
    const dest = computeTrackMove(state, player, marble, dieVal);
    if (dest) moves.push({ type: 'move', dieIndex, marbleId, ...dest });

    return moves;
  }

  if (marbleInHome(marble)) {
    const targetSlot = marble.slot + dieVal;
    if (targetSlot <= HOME_SLOTS) {
      // Cannot be blocked by own marble in the path
      if (!homePathBlocked(player, marble.slot, targetSlot)) {
        moves.push({ type: 'moveHome', dieIndex, marbleId, toSlot: targetSlot });
      }
    }
    // Overshoot (targetSlot > HOME_SLOTS) or blocked → no move available
    return moves;
  }

  return moves;
}

// Compute where a track marble ends up after moving dieVal steps clockwise.
// Returns { toZone, toSpace?, toSlot? } or null if the move is blocked.
//
// Special cases (checked in order):
//  1. The path crosses the player's homeEntry — redirect into the home stretch.
//     stepsIntoHome = remaining steps after entering home.
//     stepsIntoHome === 0  → lands on the entry square → slot 1
//     stepsIntoHome  > 0  → advances that many slots deeper into home
//     Overshoot (targetSlot > HOME_SLOTS) or blocked → null (no move)
//  2. An own marble occupies any square along the path → blocked → null.
function computeTrackMove(state, player, marble, dieVal) {
  const { start, homeEntry } = player.config;
  let pos = marble.space;

  for (let step = 1; step <= dieVal; step++) {
    const next = advanceTrack(pos, 1);

    // Check: does this step cross or land on homeEntry?
    if (pos === homeEntry || (crossesHome(pos, homeEntry, next))) {
      const stepsToEntry = trackDistance(marble.space, homeEntry);
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
  if (next > prev) return prev < homeEntry && homeEntry < next;
  return prev < homeEntry || homeEntry <= next;
}

// Returns true if the player already has a marble at the given location.
// Space is only compared for 'track' locations; this function is currently
// only called with track locations.  If you ever call it with a 'home' or
// 'center' loc, add the appropriate space/slot comparison here — the current
// fallback (true) would incorrectly match ANY marble in that zone.
function ownMarbleAt(player, loc) {
  return player.marbles.some(m =>
    m.zone === loc.zone &&
    (loc.zone === 'track' ? m.space === loc.space : true)
  );
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

// --- Apply a move (mutates state, returns events array) ---

export function applyMove(state, playerIndex, move) {
  const events = [];
  const player = state.players[playerIndex];
  const marble = player.marbles[move.marbleId];

  if (move.type === 'exitBase') {
    const dest = player.config.start;
    const bumped = findMarbleAt(state, playerIndex, 'track', dest);
    if (bumped) { bumpMarble(state, bumped, events); }
    marble.zone = 'track';
    marble.space = dest;
    marble.starEligible = (dest === player.config.star);
    events.push({ event: 'marbleMoved', playerIndex, marbleId: move.marbleId,
      from: { zone: 'base' }, to: { zone: 'track', space: dest } });

  } else if (move.type === 'move') {
    const from = { zone: 'track', space: marble.space };
    if (move.toZone === 'track') {
      const bumped = findMarbleAt(state, playerIndex, 'track', move.toSpace);
      if (bumped) { bumpMarble(state, bumped, events); }
      marble.space = move.toSpace;
      marble.starEligible = (move.toSpace === player.config.star);
      events.push({ event: 'marbleMoved', playerIndex, marbleId: move.marbleId,
        from, to: { zone: 'track', space: move.toSpace } });
    } else {
      // entering home
      marble.zone = 'home';
      marble.space = null;
      marble.slot = move.toSlot;
      marble.starEligible = false;
      events.push({ event: 'marbleMoved', playerIndex, marbleId: move.marbleId,
        from, to: { zone: 'home', slot: move.toSlot } });
    }

  } else if (move.type === 'moveHome') {
    const from = { zone: 'home', slot: marble.slot };
    marble.slot = move.toSlot;
    events.push({ event: 'marbleMoved', playerIndex, marbleId: move.marbleId,
      from, to: { zone: 'home', slot: move.toSlot } });

  } else if (move.type === 'enterCenter') {
    const from = { zone: 'track', space: marble.space };
    const bumped = findMarbleAtCenter(state, playerIndex);
    if (bumped) { bumpMarble(state, bumped, events); }
    marble.zone = 'center';
    marble.space = null;
    marble.starEligible = false;
    events.push({ event: 'marbleMoved', playerIndex, marbleId: move.marbleId,
      from, to: { zone: 'center' } });

  } else if (move.type === 'exitCenter') {
    const from = { zone: 'center' };
    const bumped = findMarbleAt(state, playerIndex, 'track', move.toStar);
    if (bumped) { bumpMarble(state, bumped, events); }
    marble.zone = 'track';
    marble.space = move.toStar;
    marble.starEligible = true;
    events.push({ event: 'marbleMoved', playerIndex, marbleId: move.marbleId,
      from, to: { zone: 'track', space: move.toStar } });
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
