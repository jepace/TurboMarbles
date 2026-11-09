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
//   B↓0         Blue's home entry
//   B↑0         Blue's start
//   B↑1 … B↑6   on and UP Blue's left side
//   B★          Blue's star
//
// B↓k is k steps before Blue's home entry; B↑k is k steps after Blue's
// start. After a star comes the next colour's ↓5 (B★ → P↓5).
export const COLOR_LETTERS = PLAYER_CONFIG.map(p => p.color[0].toUpperCase()); // B P O Y G W
export const UP = '\u2191', DOWN = '\u2193', STAR_MARK = '\u2605';

export function spaceName(space) {
  const arm = Math.floor((space - 1) / 14);
  const k = ((space - 1) % 14) + 1;                     // 1..14 within the arm's block
  if (k === 8) return COLOR_LETTERS[arm] + STAR_MARK;
  if (k < 8) return COLOR_LETTERS[arm] + UP + (k - 1);   // start = ↑0
  // 9..14 sit in the NEXT colour's U, before its start: 14 is its home entry.
  const before = 14 - k;                                // 5 … 0
  return COLOR_LETTERS[(arm + 1) % 6] + DOWN + before;   // entry = ↓0
}

// Inverse of spaceName. Accepts "B↓3", "B↑4", "B↓0", "B★" (and legacy "B0"); returns the track
// number 1–84, or null if the text isn't a square name.
export function parseSpaceName(text) {
  const m = /^([A-Za-z])(★|0|[↑↓]\d)$/.exec(String(text).trim());
  if (!m) return null;
  const arm = COLOR_LETTERS.indexOf(m[1].toUpperCase());
  if (arm === -1) return null;
  const prev = ((arm + 5) % 6) * 14;                    // previous arm's block
  if (m[2] === STAR_MARK) return arm * 14 + 8;
  if (m[2] === '0') return prev + 14;                   // legacy bare 0 = entry
  const n = Number(m[2].slice(1));
  if (m[2][0] === UP && n >= 0 && n <= 6) return arm * 14 + n + 1;
  if (m[2][0] === DOWN && n >= 0 && n <= 5) return prev + 14 - n;
  return null;
}

// ---- Pip count ---------------------------------------------------------------
//
// A raw pip count, like backgammon's: the squares a player's marbles still
// have to travel, with no allowance for needing a 1 or 6, exact landings or
// tidiness.
//   track:  the walk to the home entry (the long way — no shortcuts)
//   star:   hop along the star track to the approach star (the star just
//           before your arm; 1 per star), then 6 down to the entry
//   hub:    1 out onto the approach star, then 6 down (7)
//   base:   one more than the start square
//   home:   plus the empty home slots' numbers (4+3+2+1 = 10 with none home)
export function pipCount(arm, marbles) {
  const cfg = PLAYER_CONFIG[arm];
  const approach = PLAYER_CONFIG[(arm + 5) % 6].star;
  const starIdx = st => PLAYER_CONFIG.findIndex(c => c.star === st);
  const walk = sq => (cfg.homeEntry - sq + TRACK_SIZE) % TRACK_SIZE;
  const fromSquare = sq => ALL_STARS.has(sq) ? (starIdx(approach) - starIdx(sq) + 6) % 6 + 6 : walk(sq);
  let pips = 0;
  const filled = new Set();
  for (const m of marbles) {
    if (m.zone === 'home') filled.add(m.slot);
    else if (m.zone === 'center') pips += 7;
    else if (m.zone === 'base') pips += walk(cfg.start) + 1;
    else pips += fromSquare(m.space);
  }
  for (let s = 1; s <= HOME_SLOTS; s++) if (!filled.has(s)) pips += s;
  return pips;
}

// ---- Countdown numbering (what players see) -----------------------------------
//
// Like backgammon, every player numbers the track from their own side: a
// square's number is how far it is from that player's home entry, walking
// (0 = the home entry, 83 = the start square). Each player sees their own
// numbers on the board; the move log uses the mover's numbers. Home slots
// are h1–h4; also 'hub' and 'base'. (spaceName above is the old colour-based
// name, kept for internal tools and tests.)
export const armOf = playerConfigOrColor => {
  const c = typeof playerConfigOrColor === 'string' ? playerConfigOrColor : playerConfigOrColor?.color;
  return PLAYER_CONFIG.findIndex(p => p.color === c);
};
export function countdown(arm, space) {
  return (PLAYER_CONFIG[arm].homeEntry - space + TRACK_SIZE) % TRACK_SIZE;
}
export function fromCountdown(arm, n) {
  if (!Number.isInteger(n) || n < 0 || n >= TRACK_SIZE) return null;
  return ((PLAYER_CONFIG[arm].homeEntry - n - 1 + TRACK_SIZE) % TRACK_SIZE) + 1;
}
// A location in `arm`'s numbers: "30", "h2", "hub", "base".
// The number shown for a square: the pips it takes from there into h1 (1 =
// the home entry, 84 = the start square), like backgammon's point numbers.
export const squareNumber = (arm, space) => countdown(arm, space) + 1;
export const fromSquareNumber = (arm, n) => fromCountdown(arm, n - 1);
export function locName(loc, arm) {
  if (!loc) return '?';
  if (loc.zone === 'track') return String(squareNumber(arm, loc.space));
  if (loc.zone === 'home') return `h${loc.slot}`;
  if (loc.zone === 'center') return 'hub';
  return 'base';
}
export function parseLocName(tok, arm) {
  tok = String(tok).replace('*', '').trim();
  if (tok === 'base') return { zone: 'base' };
  if (tok === 'hub') return { zone: 'center' };
  const h = tok.match(/^h([1-4])$/);
  if (h) return { zone: 'home', slot: +h[1] };
  if (/^\d+$/.test(tok)) { const s = fromSquareNumber(arm, +tok); return s ? { zone: 'track', space: s } : null; }
  const s = parseSpaceName(tok);                     // old colour names still accepted
  return s ? { zone: 'track', space: s } : null;
}
