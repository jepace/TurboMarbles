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

// ---- Square names -----------------------------------------------------------
//
// Squares are named after the coloured U they sit in, by one letter (B P O Y
// G W) and a number, with an arrow for the side of the U, in the direction of
// travel:
//
//   B↓5 … B↓1   coming DOWN Blue's right side from the previous colour's star
//   B0          Blue's home entry
//   B↑1         Blue's start
//   B↑2 … B↑7   on and UP Blue's left side
//   B★          Blue's star
//
// B↓k is k steps before Blue's home entry; B↑k is k−1 steps after Blue's
// start. After a star comes the next colour's ↓5 (B★ → P↓5).
export const COLOR_LETTERS = PLAYER_CONFIG.map(p => p.color[0].toUpperCase()); // B P O Y G W
export const UP = '\u2191', DOWN = '\u2193', STAR_MARK = '\u2605';

export function spaceName(space) {
  const arm = Math.floor((space - 1) / 14);
  const k = ((space - 1) % 14) + 1;                     // 1..14 within the arm's block
  if (k === 8) return COLOR_LETTERS[arm] + STAR_MARK;
  if (k < 8) return COLOR_LETTERS[arm] + UP + k;
  // 9..14 sit in the NEXT colour's U, before its start: 14 is its home entry.
  const before = 14 - k;                                // 5 … 0
  return COLOR_LETTERS[(arm + 1) % 6] + (before === 0 ? '0' : DOWN + before);
}

// Inverse of spaceName. Accepts "B↓3", "B↑4", "B0", "B★"; returns the track
// number 1–84, or null if the text isn't a square name.
export function parseSpaceName(text) {
  const m = /^([A-Za-z])(★|0|[↑↓]\d)$/.exec(String(text).trim());
  if (!m) return null;
  const arm = COLOR_LETTERS.indexOf(m[1].toUpperCase());
  if (arm === -1) return null;
  const prev = ((arm + 5) % 6) * 14;                    // previous arm's block
  if (m[2] === STAR_MARK) return arm * 14 + 8;
  if (m[2] === '0') return prev + 14;
  const n = Number(m[2].slice(1));
  if (m[2][0] === UP && n >= 1 && n <= 7) return arm * 14 + n;
  if (m[2][0] === DOWN && n >= 1 && n <= 5) return prev + 14 - n;
  return null;
}
