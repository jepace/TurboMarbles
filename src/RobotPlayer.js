// RobotPlayer.js — heuristic robot player
// WIN_SCORE must be higher than any non-winning score so the robot always
// chooses a winning move first, regardless of other heuristic values.
const WIN_SCORE = 10000;

// Strategy priority (highest first):
//   1. Win move (place last marble in final home slot)
//   2. Bump an opponent
//   3. Advance furthest marble toward home
//   4. Exit base
//   5. Use shortcut
//   6. Any legal move

import { allLegalMoves, TRACK_SIZE } from './GameEngine.js';

// Pick the single best move for the next unused die, or null to forfeit.
export function pickNextRobotMove(game, playerIndex) {
  if (game.diceUsed[0] && game.diceUsed[1]) return null;
  const legal = allLegalMoves(game, playerIndex);
  let chosen = null, bestScore = -Infinity;
  for (const dieIdx of [0, 1]) {
    if (game.diceUsed[dieIdx]) continue;
    for (const move of (legal[dieIdx] || [])) {
      // Optional moves (pass home and go around again) are never worth it:
      // better to wait next to home and burn the die.
      if (move.optional) continue;
      const s = scoreMove(game, playerIndex, move);
      if (s > bestScore) { bestScore = s; chosen = move; }
    }
  }
  return chosen; // null means forfeit the next unused die
}

export function robotTakeTurn(game, playerIndex, applyCallback) {
  for (let pass = 0; pass < 2; pass++) {
    if (game.diceUsed[0] && game.diceUsed[1]) break;
    const legal = allLegalMoves(game, playerIndex);

    let chosen = null;
    let bestScore = -Infinity;

    for (const dieIdx of [0, 1]) {
      if (game.diceUsed[dieIdx]) continue;
      for (const move of (legal[dieIdx] || [])) {
        if (move.optional) continue; // see pickNextRobotMove
        const s = scoreMove(game, playerIndex, move);
        if (s > bestScore) { bestScore = s; chosen = move; }
      }
    }

    if (!chosen) {
      // Forfeit first unused die
      const dieIdx = game.diceUsed[0] ? 1 : 0;
      game.diceUsed[dieIdx] = true;
      applyCallback(null);
    } else {
      applyCallback(chosen);
    }
  }
}

function scoreMove(game, playerIndex, move) {
  const player = game.players[playerIndex];
  const cfg = game.players[playerIndex].config; // use arm-mapped config, not raw PLAYER_CONFIG index

  switch (move.type) {
    case 'moveHome': {
      // isLast: every OTHER marble is already in home — moving this one wins.
      // (Previous bug: condition was inverted, checking home||base instead of !home)
      const isLast = player.marbles.every((m, i) =>
        i === move.marbleId || m.zone === 'home');
      if (move.toSlot === 4 && isLast) return WIN_SCORE;
      return 600 + move.toSlot * 40;
    }

    case 'move': {
      if (move.toZone === 'home') return 550 + move.toSlot * 40;
      if (bumpsOpponent(game, playerIndex, move.toSpace, 'track')) return 800;
      // Progress: how far from player's start (mod 84)
      return 200 + progress(cfg.start, move.toSpace);
    }

    case 'exitCenter': {
      if (bumpsOpponent(game, playerIndex, move.toStar, 'track')) return 750;
      return 300 + progress(cfg.start, move.toStar);
    }

    case 'exitBase':
      return 400;

    case 'enterCenter':
      return 250;

    case 'moveStar': {
      if (move.toZone === 'home') return 550 + move.toSlot * 40;
      if (move.toZone === 'track') {
        if (bumpsOpponent(game, playerIndex, move.toSpace, 'track')) return 800;
        return 200 + progress(cfg.start, move.toSpace);
      }
      return 0;
    }

    default:
      return 0;
  }
}

// Distance from playerStart going clockwise — 0 to 83
function progress(start, space) {
  return ((space - start + TRACK_SIZE) % TRACK_SIZE);
}

function bumpsOpponent(game, playerIndex, space, zone) {
  return game.players.some((p, pi) =>
    pi !== playerIndex &&
    p.marbles.some(m => m.zone === zone && m.space === space)
  );
}
