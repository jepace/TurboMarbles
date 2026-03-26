// constants.js — single source of truth for board/game constants
// Imported by: src/GameEngine.js, public/js/board.js, public/js/main.js, cli.mjs
//
// DO NOT change values here without also updating board-spec.md.
// DO NOT duplicate these values in any other file.

export const TRACK_SIZE         = 84;  // total spaces in the outer ring (1-indexed)
export const HOME_SLOTS         = 4;   // slots in each player's home stretch
export const MARBLES_PER_PLAYER = 4;   // marbles per player
export const ALL_ARMS           = 6;   // total arms on the board

// Per-arm constants, indexed 0–5 clockwise from the bottom arm.
// Colors:  blue, pink, orange, yellow, green, white
export const PLAYER_CONFIG = [
  { color: 'blue',   start: 1,  star: 8,  homeEntry: 84 },
  { color: 'pink',   start: 15, star: 22, homeEntry: 14 },
  { color: 'orange', start: 29, star: 36, homeEntry: 28 },
  { color: 'yellow', start: 43, star: 50, homeEntry: 42 },
  { color: 'green',  start: 57, star: 64, homeEntry: 56 },
  { color: 'white',  start: 71, star: 78, homeEntry: 70 },
];

// ARM_MAP[n][i] = arm index for player i in an n-player game.
export const ARM_MAP = {
  2: [0, 3],
  3: [0, 2, 4],
  4: [0, 1, 3, 4],
  5: [0, 1, 2, 3, 4],
  6: [0, 1, 2, 3, 4, 5],
};

// Derived: star space numbers (one per arm, at arm*14+8)
export const ALL_STARS = new Set(PLAYER_CONFIG.map(p => p.star));

// Derived: color name per arm index (for UI color pickers and labels)
export const ARM_COLORS = PLAYER_CONFIG.map(p => p.color);
