// RobotPlayer.js — heuristic robot player
// Strategy priority (highest first):
//   1. Win move (place last marble in final home slot)
//   2. Bump an opponent
//   3. Advance furthest marble toward home
//   4. Exit base
//   5. Use shortcut
//   6. Any legal move

import { allLegalMoves, PLAYER_CONFIG, TRACK_SIZE, advanceTrack } from './GameEngine.js';

export function robotTakeTurn(game, playerIndex, applyCallback) {
  for (let pass = 0; pass < 2; pass++) {
    if (game.diceUsed[0] && game.diceUsed[1]) break;
    const legal = allLegalMoves(game, playerIndex);

    let chosen = null;
    let bestScore = -Infinity;

    for (const dieIdx of [0, 1]) {
      if (game.diceUsed[dieIdx]) continue;
      for (const move of (legal[dieIdx] || [])) {
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
  const cfg = PLAYER_CONFIG[playerIndex];

  switch (move.type) {
    case 'moveHome': {
      const isLast = player.marbles.filter((m, i) =>
        i !== move.marbleId && (m.zone === 'home' || m.zone === 'base')).length === 0;
      if (move.toSlot === 4 && isLast) return 10000; // win
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
