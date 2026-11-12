// board.js — TurboMarbles board renderer
// See board-spec.md for the authoritative layout reference before editing this file.
//
// Each arm is a wide U (see board-drawing in the repo root). For arm a, base = a*14,
// prev = previous arm's base ((a+5)%6 * 14):
//
//             [CS]
//   [b+8*]    [H4]     [p+8*]      ← stars on inner ring, SHARED with adjacent arms
//   [b+7]     [H3]     [p+9]
//   [b+6]     [H2]     [p+10]
//   [b+5]     [H1]     [p+11]
//   [b+4]              [p+12]
//   [b+3][b+2][b+1][p+14][p+13]    ← bottom row at R_OUTER; b+1 = start
//      [B1] [B2] [B3] [B4]         ← base, 1×4 row outside the U
//
// The left column (perp +COL_OFF) rises to this arm's own star (base+8); the right
// column (perp -COL_OFF) descends from the PREVIOUS arm's star (prev+8). Each star
// sits on the boundary ray between two arms, at radius STAR_RING, and belongs to
// both columns at once — the 6 stars form the inner star-track ring.

import {
  TRACK_SIZE, ALL_ARMS, MARBLES_PER_PLAYER, HOME_SLOTS,
  ARM_MAP, ALL_STARS as STAR_SPACES, PLAYER_CONFIG,
} from './constants.js';

// spaceNumber → arm index, for the 6 start spaces and 6 home entry spaces
const START_SPACES      = new Map(PLAYER_CONFIG.map((p, i) => [p.start,      i]));
const HOME_ENTRY_SPACES = new Map(PLAYER_CONFIG.map((p, i) => [p.homeEntry,  i]));

// arms 0-5: blue, pink, orange, yellow, green, white (clockwise from bottom)
export const DEFAULT_PALETTE = ['#2288f0','#e8208c','#ff7800','#f5d000','#44bb44','#e0e0e0'];
const BASE_COLORS = DEFAULT_PALETTE.slice();
const BASE_DARK   = ['#1155cc','#a01060','#c05000','#b09800','#228822','#909090'];
const COLORS = BASE_COLORS.slice();
const DARK_C = BASE_DARK.slice();
let curShift = 0;
// A viewer's palette: the display colour of each arm (arm order as in
// PLAYER_CONFIG: blue, pink, orange, yellow, green, white). Display only.
export function setPalette(hexes) {
  const ok = Array.isArray(hexes) && hexes.length === 6 && hexes.every(h => /^#[0-9a-f]{6}$/i.test(h));
  const src = ok ? hexes : DEFAULT_PALETTE;
  for (let i = 0; i < 6; i++) { BASE_COLORS[i] = src[i].toLowerCase(); BASE_DARK[i] = mix(BASE_COLORS[i], '#000000', 0.42); }
  applyArmColors();
}

// ---- Board themes: every colour the board is drawn with ----
// texture: a procedural surface for the disc (wood grain, felt, stone); glow: neon strokes.
export const THEMES = {
  midnight: { page: '#050b1e', disc: ['#1e2f60', '#121e4a', '#07101e'], rim: '#c8920a', rimInner: '#f5c84280', hole: '#06080f', holeEdge: 'rgba(0,0,0,0.6)', holeHi: 'rgba(255,255,255,0.28)',
    blend: '#16203a', outlineBlend: '#0d1530', rail: 'rgba(255,255,255,0.10)', starRing: 'rgba(245,200,66,0.25)', star: '#f5c842', starDisc: '#c8920a', starDark: '#8a5e00', starGlow: '#c8920a30',
    hubBg: '#06101e', hubRing: '#c8920a', centerRing: 'rgba(255,255,255,0.90)', labelBg: 'rgba(8,12,24,0.88)', labelFg: '#eef2fa', num: 'rgba(255,255,255,0.36)', numStar: 'rgba(70,40,0,0.6)',
    socket: 'rgba(8,12,24,0.95)', shadow: 'rgba(0,0,0,0.45)' },
  daylight: { lightBoard: true, page: '#e9edf3', disc: ['#ffffff', '#f1f3f7', '#d6dbe5'], rim: '#9aa3b2', rimInner: '#ffffffa0', hole: '#cfd5df', holeEdge: 'rgba(40,50,70,0.35)', holeHi: 'rgba(0,0,0,0.10)',
    blend: '#f4f6fa', outlineBlend: '#ffffff', rail: 'rgba(0,0,0,0.08)', starRing: 'rgba(180,130,20,0.35)', star: '#f6c445', starDisc: '#d99a10', starDark: '#7a5208', starGlow: '#f0b42930',
    hubBg: '#ffffff', hubRing: '#9aa3b2', centerRing: 'rgba(60,70,90,0.8)', labelBg: 'rgba(255,255,255,0.94)', labelFg: '#1a2233', num: 'rgba(0,0,0,0.38)', numStar: 'rgba(70,40,0,0.6)',
    socket: 'rgba(255,255,255,0.92)', shadow: 'rgba(0,0,0,0.22)' },
  wood: { page: '#1a1009', disc: ['#c08a52', '#a8713e', '#764a24'], texture: 'wood', rim: '#e0b870', rimInner: '#f6e2b080', hole: '#3a2412', holeEdge: 'rgba(0,0,0,0.55)', holeHi: 'rgba(255,230,190,0.20)',
    blend: '#8a5a30', outlineBlend: '#7a4e28', rail: 'rgba(40,20,5,0.22)', starRing: 'rgba(60,30,5,0.35)', star: '#f0cc70', starDisc: '#b8862a', starDark: '#5a3a10', starGlow: '#e0b87040',
    hubBg: '#5a3a1c', hubRing: '#e0b870', centerRing: 'rgba(255,235,200,0.85)', labelBg: 'rgba(40,24,10,0.9)', labelFg: '#fbefdc', num: 'rgba(255,240,215,0.5)', numStar: 'rgba(70,40,0,0.6)',
    socket: 'rgba(40,24,10,0.95)', shadow: 'rgba(20,10,0,0.5)' },
  neon: { page: '#000000', disc: ['#0c0c18', '#06060c', '#000000'], rim: '#ff2bd6', rimInner: '#00f0ffa0', hole: '#000000', holeEdge: 'rgba(0,240,255,0.6)', holeHi: 'rgba(0,240,255,0.10)',
    blend: '#000000', outlineBlend: '#02020a', rail: 'rgba(0,240,255,0.16)', starRing: 'rgba(255,43,214,0.5)', star: '#fff36b', starDisc: '#1c1800', starDark: '#fff36b', starGlow: '#fff36b30',
    hubBg: '#000000', hubRing: '#00f0ff', centerRing: '#ff2bd6', labelBg: 'rgba(0,0,0,0.85)', labelFg: '#ffffff', num: 'rgba(0,240,255,0.6)', numStar: 'rgba(255,243,107,0.9)',
    socket: 'rgba(0,0,0,0.95)', shadow: 'rgba(0,0,0,0)', glow: 1, outlineTracks: true },
  felt: { page: '#0a1d12', disc: ['#358552', '#2a7344', '#1a4e2e'], texture: 'felt', rim: '#7a5432', rimInner: '#b0885880', hole: '#0e2a19', holeEdge: 'rgba(0,0,0,0.5)', holeHi: 'rgba(255,255,255,0.12)',
    blend: '#1d4f31', outlineBlend: '#173f27', rail: 'rgba(255,255,255,0.07)', starRing: 'rgba(245,200,66,0.3)', star: '#f5c842', starDisc: '#c8920a', starDark: '#8a5e00', starGlow: '#c8920a30',
    hubBg: '#123a24', hubRing: '#b08858', centerRing: 'rgba(255,255,255,0.85)', labelBg: 'rgba(10,30,18,0.9)', labelFg: '#eef6ee', num: 'rgba(255,255,255,0.4)', numStar: 'rgba(70,40,0,0.6)',
    socket: 'rgba(10,30,18,0.95)', shadow: 'rgba(0,0,0,0.45)' },
  stone: { lightBoard: true, page: '#131518', disc: ['#e4e4e0', '#cfcfca', '#a0a09b'], texture: 'stone', rim: '#596069', rimInner: '#ffffff70', hole: '#5d5f63', holeEdge: 'rgba(0,0,0,0.45)', holeHi: 'rgba(255,255,255,0.28)',
    blend: '#c9c9c4', outlineBlend: '#d8d8d4', rail: 'rgba(0,0,0,0.10)', starRing: 'rgba(120,90,20,0.35)', star: '#f5c842', starDisc: '#c8920a', starDark: '#8a5e00', starGlow: '#c8920a30',
    hubBg: '#76787c', hubRing: '#40454d', centerRing: 'rgba(255,255,255,0.9)', labelBg: 'rgba(30,32,36,0.9)', labelFg: '#f2f2f2', num: 'rgba(0,0,0,0.42)', numStar: 'rgba(70,40,0,0.6)',
    socket: 'rgba(60,62,66,0.95)', shadow: 'rgba(0,0,0,0.3)' },
};
let T = THEMES.midnight;
export function setTheme(name) { T = THEMES[name] ?? THEMES.midnight; textureCache = null; applyArmColors(); }

// Procedural textures for the disc (drawn once per theme and board size).
let textureCache = null;
function rng(seed) { return () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }; }
function discTexture() {
  if (!T.texture) return null;
  const size = Math.ceil(W);
  if (textureCache?.size === size && textureCache.kind === T.texture) return textureCache.canvas;
  const c = document.createElement('canvas'); c.width = c.height = size;
  const g = c.getContext('2d'), rnd = rng(7);
  if (T.texture === 'wood') {
    g.fillStyle = T.disc[1]; g.fillRect(0, 0, size, size);
    // Grain: long wavy lines, darker and lighter, plus a couple of knots.
    for (let i = 0; i < 170; i++) {
      const y0 = rnd() * size, amp = size * (0.004 + rnd() * 0.012), freq = (1 + rnd() * 2.5) * Math.PI / size, ph = rnd() * 6;
      g.beginPath();
      for (let x = 0; x <= size; x += 6) g.lineTo(x, y0 + Math.sin(x * freq + ph) * amp + Math.sin(x * freq * 3.1 + ph) * amp * 0.3);
      const dark = rnd() < 0.7;
      g.strokeStyle = dark ? `rgba(60,30,8,${0.06 + rnd() * 0.16})` : `rgba(255,220,170,${0.04 + rnd() * 0.10})`;
      g.lineWidth = 0.6 + rnd() * size * 0.004; g.stroke();
    }
    for (let k = 0; k < 3; k++) {
      const x = rnd() * size, y = rnd() * size, rad = size * (0.012 + rnd() * 0.02);
      for (let j = 6; j > 0; j--) { g.beginPath(); g.ellipse(x, y, rad * j / 3, rad * j / 5, 0, 0, Math.PI * 2); g.strokeStyle = `rgba(70,35,10,${0.06 + j * 0.02})`; g.lineWidth = 1.2; g.stroke(); }
    }
  } else if (T.texture === 'felt') {
    g.fillStyle = T.disc[1]; g.fillRect(0, 0, size, size);
    const img = g.getImageData(0, 0, size, size), d = img.data;
    for (let i = 0; i < d.length; i += 4) { const n = (rnd() - 0.5) * 26; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
    g.putImageData(img, 0, 0);
  } else if (T.texture === 'stone') {
    g.fillStyle = T.disc[1]; g.fillRect(0, 0, size, size);
    for (let i = 0; i < 260; i++) { const x = rnd() * size, y = rnd() * size, rr = size * (0.01 + rnd() * 0.05); g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.fillStyle = `rgba(${rnd() < 0.5 ? '255,255,255' : '90,90,85'},${0.03 + rnd() * 0.05})`; g.fill(); }
    // Veins: random walks.
    for (let v = 0; v < 9; v++) {
      let x = rnd() * size, y = rnd() * size, a = rnd() * Math.PI * 2;
      g.beginPath(); g.moveTo(x, y);
      for (let st = 0; st < 120; st++) { a += (rnd() - 0.5) * 0.6; x += Math.cos(a) * size * 0.008; y += Math.sin(a) * size * 0.008; g.lineTo(x, y); }
      g.strokeStyle = `rgba(80,80,90,${0.10 + rnd() * 0.18})`; g.lineWidth = 0.6 + rnd() * 1.8; g.stroke();
    }
  }
  textureCache = { size, kind: T.texture, canvas: c };
  return c;
}
// Neon: strokes glow in their own colour.
// Lite (stream page lite=1, no graphics card): no glow; blurred shadows are the costliest thing to draw.
let lite = false;
export function setLite(on) { lite = !!on; }
function glowOn(color, k = 1) { if (T.glow && !lite) { ctx.shadowColor = color; ctx.shadowBlur = W * 0.014 * T.glow * k; } }
function glowOff() { if (T.glow) { ctx.shadowBlur = 0; ctx.shadowColor = 'transparent'; } }
// Each viewer may see their own arm in a favourite colour: the colours turn
// round the ring by `shift` arms, keeping their order (display only).
// Board look (a user preference). Track strips: 'muted' (default: colour
// blended toward the background), 'solid', 'deep', 'outline'. Marbles:
// 'socket' (default: in a dark socket), 'classic', 'dark' (black ring), 'white' (white ring).
let trackStyle = 'muted', marbleStyle = 'socket', finish = 'glossy';
export const FINISHES = ['glossy', 'glass', 'swirl', 'matte', 'metal', 'pearl'];
export function setBoardLook({ track, marbles, theme, finish: fin, palette } = {}) {
  trackStyle = ['muted', 'solid', 'deep', 'outline'].includes(track) ? track : 'muted';
  marbleStyle = ['socket', 'classic', 'dark', 'white'].includes(marbles) ? marbles : 'socket';
  finish = FINISHES.includes(fin) ? fin : 'glossy';
  if (theme !== undefined) setTheme(theme);
  if (palette !== undefined) setPalette(palette);
}
function mix(hex, toHex, t) {
  const c = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
  const a = c(hex), b = c(toHex);
  return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
function trackPaint(color) {
  if (T.outlineTracks || trackStyle === 'outline') return [mix(color, T.outlineBlend, 0.85), color, Math.max(2, W * 0.004)];
  if (trackStyle === 'solid')   return [color + 'ff', null];
  if (trackStyle === 'deep')    return [mix(color, '#000000', 0.6), null];
  return [mix(color, T.blend, 0.45), null];
}
// On light boards a very light seat colour (white) would vanish: darken it a little there.
function onTheme(hex) {
  if (!T.lightBoard) return hex;
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.8 ? mix(hex, '#5a6272', 0.45) : hex;
}
// Which colour each arm is painted in: armColor[arm] = a colour index (palette
// order: blue, pink, orange, yellow, green, white). Players' colours aren't tied
// to their seats, so a game sets this from its players (setArmColors).
let armColor = [0, 1, 2, 3, 4, 5];
function applyArmColors() {
  for (let i = 0; i < 6; i++) { COLORS[i] = onTheme(BASE_COLORS[armColor[i]]); DARK_C[i] = onTheme(BASE_DARK[armColor[i]]); }
}
// byArm: { arm: colourIndex } for the seated arms; the empty arms get the
// colours left over, in order, so all six stay different.
export function setArmColors(byArm = {}) {
  const used = new Set(Object.values(byArm));
  const spare = [0, 1, 2, 3, 4, 5].filter(c => !used.has(c));
  armColor = [0, 1, 2, 3, 4, 5].map(a => byArm[a] ?? spare.shift() ?? a);
  applyArmColors();
}
// The colours turned round the ring (the Board page preview's "my colour").
export function setColorShift(shift = 0) {
  curShift = shift;
  armColor = [0, 1, 2, 3, 4, 5].map(i => (i + shift + 6) % 6);
  applyArmColors();
}

// (star colours come from the theme: T.star …)
let hubInstant = false;
const STEP = (2 * Math.PI) / ALL_ARMS;

let canvas, ctx, W, CX, CY;
let layoutFor = null;   // the canvas the current layout was computed for
let trackPos  = [];
let homePos   = [];
let basePos   = [];
let centerPos = { x: 0, y: 0 };
let playerToArm = [0, 1, 2, 3, 4, 5];
let marbleOverrides = {};
let animatingMarble = null; // { playerIndex, marbleId }
let GEO = {};

export function init(canvasEl) {
  canvas = canvasEl;
  ctx    = canvas.getContext('2d');
  resize();
}

export function resize() {
  if (!canvas) return;
  const par  = canvas.parentElement;
  const rect = par ? par.getBoundingClientRect() : { width: 0, height: 0 };
  // The visible viewport (visualViewport on iPad/iPhone, where window
  // heights can include space under the browser toolbars).
  const visH = window.visualViewport?.height ?? window.innerHeight;
  const size = Math.max(200, Math.floor(Math.min(
    rect.width  > 0 ? rect.width  : window.innerWidth  - 230,
    rect.height > 0 ? rect.height : visH - 10,
    visH - 10
  )));
  // Same size and already laid out for this canvas: nothing to do. (The Board
  // page's preview borrows the renderer, so the layout may be another canvas's.)
  if (canvas.width === size && W === size && layoutFor === canvas) return;
  canvas.width  = size;
  canvas.height = size;
  W  = size;
  CX = CY = size / 2;
  layoutFor = canvas;
  computeLayout();
}

export function setMarbleOverride(playerIndex, marbleId, pos) {
  if (!marbleOverrides[playerIndex]) marbleOverrides[playerIndex] = {};
  marbleOverrides[playerIndex][marbleId] = pos;
}

export function clearMarbleOverride(playerIndex, marbleId) {
  if (marbleOverrides[playerIndex]) delete marbleOverrides[playerIndex][marbleId];
}

export function clearAllMarbleOverrides() {
  for (const key of Object.keys(marbleOverrides)) delete marbleOverrides[key];
  animatingMarble = null;
}

export function getBasePosition(playerIndex, marbleId) {
  const ai = playerToArm[playerIndex] ?? playerIndex;
  return basePos[ai]?.[marbleId] ?? null;
}

export function setAnimatingMarble(playerIndex, marbleId) {
  animatingMarble = { playerIndex, marbleId };
}

export function clearAnimatingMarble() {
  animatingMarble = null;
}

// The arm drawn at the bottom of the screen: each player sees their own arm
// at the bottom (setViewArm). Purely a view rotation — every position,
// hit-test and arrow comes from armAngle, so they all turn together.
let viewArm = 0;
function armAngle(ai) { return (ai - viewArm) * STEP + Math.PI / 2; }
export function setViewArm(arm) {
  const a = ((arm % ALL_ARMS) + ALL_ARMS) % ALL_ARMS;
  if (!Number.isInteger(a) || a === viewArm) return;
  viewArm = a;
  if (W) computeLayout();
}

function computeLayout() {
  const STAR_RING = W * 0.18;                  // radius of the inner star-track ring
  const COL_OFF   = STAR_RING / 2;             // perp offset of U columns from arm axis
  const COL_TOP   = COL_OFF * Math.sqrt(3);    // along-axis coord of star row (row 1)
  const R_OUTER   = W * 0.40;                  // bottom row of each U (row 6)
  const ROW_STEP  = (R_OUTER - COL_TOP) / 5;   // along-axis spacing of column rows 1–6
  const BASE_R    = W * 0.452;                 // base row radius (outside the U)
  const BASE_G    = W * 0.044;                 // spacing between base slots

  GEO = { STAR_RING, COL_OFF, COL_TOP, R_OUTER, ROW_STEP, BASE_R, BASE_G };

  trackPos = new Array(TRACK_SIZE + 1);
  homePos  = [];
  basePos  = [];

  for (let arm = 0; arm < ALL_ARMS; arm++) {
    const ang  = armAngle(arm);
    const dx   = Math.cos(ang), dy = Math.sin(ang);
    const px   = -Math.sin(ang), py = Math.cos(ang);
    const base = arm * 14;
    const prev = ((arm + 5) % ALL_ARMS) * 14;

    // Point at along-axis distance r, perpendicular offset p (positive = left
    // column side, i.e. toward the next arm clockwise).
    const pt   = (r, p) => ({ x: CX + dx * r + px * p, y: CY + dy * r + py * p });
    // Along-axis coordinate of column row k (1 = star row … 6 = bottom row)
    const rowR = (k) => COL_TOP + ROW_STEP * (k - 1);

    // Bottom row of this arm's U: [base+3][base+2][base+1][prev+14][prev+13]
    trackPos[base + 1] = pt(R_OUTER, 0);             // start, on the arm axis
    trackPos[base + 2] = pt(R_OUTER, COL_OFF / 2);
    trackPos[base + 3] = pt(R_OUTER, COL_OFF);       // corner, bottom of left column

    // Left column rises to this arm's own star (rows 5 → 2)
    for (let i = 0; i < 4; i++) trackPos[base + 4 + i] = pt(rowR(5 - i), COL_OFF);

    // Star (row 1): on the boundary ray shared with the next arm's right column.
    // (COL_TOP, COL_OFF) ≡ radius STAR_RING at angle ang + 30°.
    trackPos[base + 8] = pt(COL_TOP, COL_OFF);

    // Right column of this U descends from the PREVIOUS arm's star (rows 2 → 6)
    for (let i = 0; i < 4; i++) trackPos[prev + 9 + i] = pt(rowR(2 + i), -COL_OFF);
    trackPos[prev + 13] = pt(R_OUTER, -COL_OFF);     // corner, bottom of right column
    trackPos[prev + 14] = pt(R_OUTER, -COL_OFF / 2); // home entry, next to start

    // Home corridor: on the arm axis, aligned with column rows 4 (H1) … 1 (H4)
    homePos[arm] = new Array(HOME_SLOTS + 1);
    for (let s = 1; s <= HOME_SLOTS; s++) homePos[arm][s] = pt(rowR(5 - s), 0);

    // Base: 1×4 row outside the bottom edge; slot 0 on the left from the
    // player's seat (positive perp), matching B1…B4 in board-drawing
    basePos[arm] = [];
    for (let mi = 0; mi < MARBLES_PER_PLAYER; mi++) {
      basePos[arm].push(pt(BASE_R, (1.5 - mi) * BASE_G));
    }
  }

  centerPos = { x: CX, y: CY };
}

// ---- Square numbers ----
// Optional small numbers in the track holes and on the stars (each player's
// own countdown to home; see constants.js). fn(space) → text, or null = off.
let labelFn = null;
export function setSquareLabels(fn) { labelFn = fn; }
// Name tags by each player's base (who is who on the board): fn(playerIndex) → text.
let seatLabelFn = null;
export function setSeatLabels(fn) { seatLabelFn = fn; }
function drawSeatLabels(gameState) {
  if (!seatLabelFn || !gameState?.players) return;
  const { BASE_R, BASE_G } = GEO;
  const fs = Math.max(10, W * 0.019);
  ctx.save();
  ctx.font = `600 ${fs}px system-ui, sans-serif`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const p of gameState.players) {
    const text = seatLabelFn(p.index);
    if (!text) continue;
    const ai = playerToArm[p.index] ?? p.index;
    const ang = armAngle(ai), dx = Math.cos(ang), dy = Math.sin(ang), px = -Math.sin(ang), py = Math.cos(ang);
    // Beside the base row, on the side away from the start square's home entry.
    const off = BASE_G * 2.1 + fs * 0.4;
    const w = ctx.measureText(text).width + fs * 0.9, h = fs * 1.5;
    const cx0 = CX + dx * BASE_R + px * off, cy0 = CY + dy * BASE_R + py * off;
    // Push the pill sideways (along the rim) by half its width so it clears the base.
    const pad = 3;
    const cx = Math.min(W - w / 2 - pad, Math.max(w / 2 + pad, cx0 + px * (w / 2)));
    const cy = Math.min(W - h / 2 - pad, Math.max(h / 2 + pad, cy0 + py * (w / 2)));
    ctx.fillStyle = T.labelBg;
    ctx.strokeStyle = COLORS[ai];
    ctx.lineWidth = Math.max(1.5, W * 0.0025);
    ctx.beginPath();
    ctx.roundRect(cx - w / 2, cy - h / 2, w, h, h / 2);
    ctx.fill(); ctx.stroke();
    ctx.fillStyle = T.labelFg;
    ctx.fillText(text, cx, cy + 1);
  }
  ctx.restore();
}
function drawSquareLabels(n) {
  if (!labelFn) return;
  const activeSet = new Set(playerToArm.slice(0, n));   // arms in play draw arrows
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let s = 1; s <= TRACK_SIZE; s++) {
    const p = trackPos[s];
    if (!p) continue;
    // Start and home-entry squares of the colours in play keep their
    // direction arrows instead of a number (always 83 and 0 for that colour;
    // hover shows them). Unused colours have no arrows, so they get numbers.
    if (activeSet.has(START_SPACES.get(s)) || activeSet.has(HOME_ENTRY_SPACES.get(s))) continue;
    const star = STAR_SPACES.has(s);
    ctx.font = `600 ${Math.round(W * (star ? 0.015 : 0.0165))}px system-ui, sans-serif`;
    ctx.fillStyle = star ? T.numStar : T.num;
    ctx.fillText(String(labelFn(s)), p.x, p.y + (star ? W * 0.001 : 1));
  }
  ctx.restore();
}

// ---- Hub occupant colour ----
// The hub's six wedges take the colour of whoever sits in the hub, blending
// over HUB_FADE_MS when someone arrives, leaves or is bumped out by another.
// A marble counts once its move animation has finished (no override left).
const HUB_FADE_MS = 500;
let hubKey = 'none', hubFrom = null, hubTo = null, hubT0 = 0, hubLastState = null, hubTimer = false;
const hexToRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
// The occupant's arm, null when empty, or undefined while a marble is still
// moving into the hub (keep the current colour until it lands — a bump goes
// straight from the old occupant's colour to the new one's).
function hubOccupantArm(gameState) {
  for (const p of gameState?.players ?? []) {
    for (const m of p.marbles) {
      if (m.zone !== 'center') continue;
      if (marbleOverrides[p.index]?.[m.id]) return undefined;
      return playerToArm[p.index] ?? p.index;
    }
  }
  return null;
}
function hubWedgeColors(instant) {
  const arm = hubOccupantArm(hubLastState);
  if (arm === undefined && hubTo && !instant) return currentHub(performance.now());
  const key = arm == null ? 'none' : String(arm);
  const target = Array.from({ length: 6 }, (_, i) => hexToRgb(COLORS[arm == null ? i : arm]));
  const now = performance.now();
  if (!hubTo) { hubFrom = hubTo = target; hubKey = key; }
  if (key !== hubKey) {
    hubFrom = currentHub(now);
    hubTo = target; hubKey = key; hubT0 = now;
    if (instant) hubFrom = target;
    else if (!hubTimer) {
      hubTimer = true;
      const tick = () => {
        if (performance.now() - hubT0 < HUB_FADE_MS) { drawBoard(hubLastState); requestAnimationFrame(tick); }
        else { hubTimer = false; drawBoard(hubLastState); }
      };
      requestAnimationFrame(tick);
    }
  }
  return currentHub(now);
}
function currentHub(now) {
  const t = Math.min(1, Math.max(0, (now - hubT0) / HUB_FADE_MS));
  const e = t * t * (3 - 2 * t);                // smoothstep
  return hubTo.map((c, i) => c.map((v, k) => Math.round(hubFrom[i][k] + (v - hubFrom[i][k]) * e)));
}

// opts.instantHub: switch the hub colour without fading (analysis replay,
// where the caller draws arrows on top afterwards).
export function drawBoard(gameState, opts = {}) {
  if (!ctx || !W) return;
  hubLastState = gameState;
  hubInstant = !!opts.instantHub;
  const n = gameState?.players?.length ?? ALL_ARMS;
  // Each player's seat: their own arm (any arm; colours are separate), else the usual seats.
  const usual = ARM_MAP[n] ?? Array.from({ length: n }, (_, i) => i);
  playerToArm = Array.from({ length: n }, (_, i) => (Number.isInteger(gameState?.players?.[i]?.arm) ? gameState.players[i].arm : usual[i]));

  ctx.clearRect(0, 0, W, W);
  drawBackground();
  drawBase(n);       // drawn first so arm strips and track paint over its inner edge
  drawAllArms(n);
  drawTrackRail();
  drawTrack(n);
  drawHome(n);
  drawCenter();
  drawSquareLabels(n);  // under the marbles, so a marble hides its square's number
  if (gameState) drawMarbles(gameState);
  drawRimOverlay();  // repaint rim on top so base panel corners don't poke through
  if (!opts.noSeatLabels) drawSeatLabels(gameState);
}

// ---- Rim overlay: repainted on top so base/arm corners don't poke through ----

function drawRimOverlay() {
  const rimR = W * 0.493;
  // Mask everything outside the rim with the background colour
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, W);
  ctx.arc(CX, CY, rimR, 0, Math.PI * 2, true); // clockwise hole
  ctx.fillStyle = T.page;
  ctx.fill();
  ctx.restore();
  // Repaint the brass ring on top
  ctx.beginPath();
  ctx.arc(CX, CY, rimR, 0, Math.PI * 2);
  ctx.strokeStyle = T.rim;
  ctx.lineWidth   = W * 0.009;
  glowOn(T.rim); ctx.stroke(); glowOff();
  ctx.beginPath();
  ctx.arc(CX, CY, rimR - W * 0.006, 0, Math.PI * 2);
  ctx.strokeStyle = T.rimInner;
  ctx.lineWidth   = W * 0.002;
  ctx.stroke();
}

// ---- Background: dark navy board with brass rim ----

function drawBackground() {
  ctx.fillStyle = T.page;
  ctx.fillRect(0, 0, W, W);

  // Outer rim circle
  const rimR = W * 0.493;
  ctx.beginPath();
  ctx.arc(CX, CY, rimR, 0, Math.PI * 2);
  ctx.strokeStyle = T.rim;
  ctx.lineWidth   = W * 0.009;
  ctx.stroke();

  // Inner thin accent ring
  ctx.beginPath();
  ctx.arc(CX, CY, rimR - W * 0.006, 0, Math.PI * 2);
  ctx.strokeStyle = T.rimInner;
  ctx.lineWidth   = W * 0.002;
  ctx.stroke();

  // Board surface: the theme's texture (wood, felt, stone) or colour, shaded toward the edge.
  ctx.save();
  ctx.beginPath();
  ctx.arc(CX, CY, rimR - W * 0.009, 0, Math.PI * 2);
  ctx.clip();
  const tex = discTexture();
  if (tex) ctx.drawImage(tex, 0, 0, W, W);
  const grad = ctx.createRadialGradient(CX, CY * 0.85, 0, CX, CY, rimR);
  if (tex) { grad.addColorStop(0, 'rgba(255,255,255,0.10)'); grad.addColorStop(0.6, 'rgba(0,0,0,0)'); grad.addColorStop(1, 'rgba(0,0,0,0.35)'); }
  else { grad.addColorStop(0, T.disc[0]); grad.addColorStop(0.45, T.disc[1]); grad.addColorStop(1, T.disc[2]); }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, W);
  ctx.restore();
}

// ---- Arm zones: solid opaque colored strips ----

function drawAllArms(n) {
  const { COL_OFF, COL_TOP, R_OUTER, ROW_STEP } = GEO;

  const COL_HW  = W * 0.030;   // half-width of the U track strips
  const HOME_HW = W * 0.026;   // half-width of the home corridor strip

  const activeSet = new Set(playerToArm.slice(0, n));

  for (let ai = 0; ai < ALL_ARMS; ai++) {
    const ang      = armAngle(ai);
    const dx       = Math.cos(ang), dy = Math.sin(ang);
    const px       = -Math.sin(ang), py = Math.cos(ang);
    const pt       = (r, p) => ({ x: CX + dx * r + px * p, y: CY + dy * r + py * p });
    const color    = COLORS[ai];
    const isActive = activeSet.has(ai);

    // Track strips: always full color (no overlap blending issues since they're opaque)
    fillQuad([
      pt(COL_TOP,          COL_OFF - COL_HW),
      pt(COL_TOP,          COL_OFF + COL_HW),
      pt(R_OUTER + COL_HW, COL_OFF + COL_HW),
      pt(R_OUTER + COL_HW, COL_OFF - COL_HW),
    ], ...trackPaint(color));

    fillQuad([
      pt(COL_TOP,          -COL_OFF + COL_HW),
      pt(COL_TOP,          -COL_OFF - COL_HW),
      pt(R_OUTER + COL_HW, -COL_OFF - COL_HW),
      pt(R_OUTER + COL_HW, -COL_OFF + COL_HW),
    ], ...trackPaint(color));

    fillQuad([
      pt(R_OUTER - COL_HW, -COL_OFF - COL_HW),
      pt(R_OUTER - COL_HW,  COL_OFF + COL_HW),
      pt(R_OUTER + COL_HW,  COL_OFF + COL_HW),
      pt(R_OUTER + COL_HW, -COL_OFF - COL_HW),
    ], ...trackPaint(color));

    // Home corridor strip: dimmed for non-playing arms
    const homeIn  = COL_TOP - HOME_HW;
    const homeOut = COL_TOP + ROW_STEP * 3 + HOME_HW;
    fillQuad([
      pt(homeOut,  HOME_HW),
      pt(homeOut, -HOME_HW),
      pt(homeIn,  -HOME_HW),
      pt(homeIn,   HOME_HW),
    ], color + (isActive ? 'ee' : '30'), null);
  }
}

function fillQuad(pts, fillStyle, strokeStyle, lineWidth = 1.5) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  if (fillStyle)   { ctx.fillStyle = fillStyle; ctx.fill(); }
  if (strokeStyle) { ctx.strokeStyle = strokeStyle; ctx.lineWidth = lineWidth; glowOn(strokeStyle); ctx.stroke(); glowOff(); }
}

// ---- Track rail: subtle path line ----

function drawTrackRail() {
  // Inner star-track ring through the 6 stars
  ctx.save();
  ctx.beginPath();
  ctx.arc(CX, CY, GEO.STAR_RING, 0, Math.PI * 2);
  ctx.strokeStyle = T.starRing;
  ctx.lineWidth   = W * 0.006;
  ctx.setLineDash([W * 0.02, W * 0.014]);
  ctx.stroke();
  ctx.restore();

  ctx.beginPath();
  for (let i = 1; i <= TRACK_SIZE; i++) {
    const p = trackPos[i];
    if (!p) continue;
    i === 1 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
  ctx.strokeStyle = T.rail;
  ctx.lineWidth   = W * 0.010;
  ctx.lineJoin    = 'round';
  ctx.stroke();
}

// ---- Track spaces: drilled-hole look ----

function drawTrack(n = ALL_ARMS) {
  const R = W * 0.020;
  const activeSet = new Set(playerToArm.slice(0, n));

  for (let i = 1; i <= TRACK_SIZE; i++) {
    const p = trackPos[i];
    if (!p) continue;

    if (STAR_SPACES.has(i)) {
      // Gold shortcut marker — bold circle with 6-pointed star
      // Outer glow ring
      ctx.beginPath();
      ctx.arc(p.x, p.y, R * 2.0, 0, Math.PI * 2);
      ctx.fillStyle = T.starGlow;
      ctx.fill();
      // Gold disc
      ctx.beginPath();
      ctx.arc(p.x, p.y, R * 1.5, 0, Math.PI * 2);
      ctx.fillStyle = T.starDisc;
      ctx.fill();
      ctx.strokeStyle = T.star;
      ctx.lineWidth   = 2;
      glowOn(T.star); ctx.stroke(); glowOff();
      // 6-pointed star inset
      drawStar6(p.x, p.y, R * 1.1, T.star, T.starDark);
    } else if (START_SPACES.has(i) && activeSet.has(START_SPACES.get(i))) {
      const ai    = START_SPACES.get(i);
      const color = COLORS[ai];
      const dark  = DARK_C[ai];
      // Colored disc — same radius as a regular hole so it never overlaps neighbours
      ctx.beginPath();
      ctx.arc(p.x, p.y, R * 1.05, 0, Math.PI * 2);
      ctx.fillStyle = dark;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth   = 2;
      glowOn(color); ctx.stroke(); glowOff();
      // Arrow pointing clockwise along the track (in the arm's perpendicular direction)
      const ang = armAngle(ai);
      const tdx = Math.cos(ang),    tdy = Math.sin(ang);    // radial (arm axis)
      const tpx = -Math.sin(ang),   tpy = Math.cos(ang);    // clockwise tangent
      const tr  = R * 0.40;
      ctx.beginPath();
      ctx.moveTo(p.x + tpx * tr,                         p.y + tpy * tr);
      ctx.lineTo(p.x - tpx * tr * 0.55 - tdx * tr * 0.9, p.y - tpy * tr * 0.55 - tdy * tr * 0.9);
      ctx.lineTo(p.x - tpx * tr * 0.55 + tdx * tr * 0.9, p.y - tpy * tr * 0.55 + tdy * tr * 0.9);
      ctx.closePath();
      ctx.fillStyle = color + 'dd';
      ctx.fill();
    } else if (HOME_ENTRY_SPACES.has(i) && activeSet.has(HOME_ENTRY_SPACES.get(i))) {
      const ai    = HOME_ENTRY_SPACES.get(i);
      const color = COLORS[ai];
      const dark  = DARK_C[ai];
      // Dark hole base
      ctx.beginPath();
      ctx.arc(p.x, p.y, R * 1.05, 0, Math.PI * 2);
      ctx.fillStyle = dark;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth   = 2;
      ctx.stroke();
      // Arrow pointing inward along the arm axis (toward the home corridor)
      const ang = armAngle(ai);
      const idx = -Math.cos(ang),  idy = -Math.sin(ang); // inward radial
      const ipx = -Math.sin(ang),  ipy =  Math.cos(ang); // perpendicular (for base width)
      const tr  = R * 0.40;
      ctx.beginPath();
      ctx.moveTo(p.x + idx * tr,                         p.y + idy * tr);
      ctx.lineTo(p.x - idx * tr * 0.55 - ipx * tr * 0.9, p.y - idy * tr * 0.55 - ipy * tr * 0.9);
      ctx.lineTo(p.x - idx * tr * 0.55 + ipx * tr * 0.9, p.y - idy * tr * 0.55 + ipy * tr * 0.9);
      ctx.closePath();
      ctx.fillStyle = color + 'dd';
      ctx.fill();
    } else {
      // Drilled hole: near-black fill with inner highlight arc for depth
      ctx.beginPath();
      ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
      ctx.fillStyle = T.hole;
      ctx.fill();
      // Subtle outer rim
      ctx.strokeStyle = T.holeEdge;
      ctx.lineWidth   = T.glow ? 1.5 : 1;
      glowOn(T.holeEdge, 0.5); ctx.stroke(); glowOff();
      // Inner highlight arc (top-left quadrant) simulates concave depression
      ctx.beginPath();
      ctx.arc(p.x - R * 0.12, p.y - R * 0.12, R * 0.68, Math.PI * 1.05, Math.PI * 1.75);
      ctx.strokeStyle = T.holeHi;
      ctx.lineWidth   = R * 0.38;
      ctx.stroke();
    }
  }
}

// 6-pointed star (12 vertices, alternating outer/inner radii at 30° each)
function drawStar6(cx, cy, R, fillColor, strokeColor) {
  const r = R * 0.45;
  ctx.beginPath();
  for (let i = 0; i < 12; i++) {
    const ang = (i * Math.PI) / 6 - Math.PI / 2;
    const rad = i % 2 === 0 ? R : r;
    const x   = cx + Math.cos(ang) * rad;
    const y   = cy + Math.sin(ang) * rad;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle   = fillColor;
  ctx.fill();
  ctx.strokeStyle = strokeColor;
  ctx.lineWidth   = 1;
  ctx.stroke();
}

// ---- Home slots + Base panels ----

// Base panels are drawn early (below the track) so the track overlaps them
// rather than the other way around. Home slots are drawn later (drawHome).
function drawBase(n) {
  const R = W * 0.020;
  const { BASE_R, BASE_G } = GEO;
  const activeSet = new Set(playerToArm.slice(0, n));

  for (let ai = 0; ai < ALL_ARMS; ai++) {
    const isActive = activeSet.has(ai);
    const color    = COLORS[ai];
    const dark     = DARK_C[ai];
    const ang      = armAngle(ai);
    const dx       = Math.cos(ang), dy = Math.sin(ang);
    const px       = -Math.sin(ang), py = Math.cos(ang);

    // -- Base panel: solid colored background behind the 1×4 marble row --
    const panW  = BASE_G * 2.10;  // half-width of panel (covers 4 slots at ±1.5·BASE_G)
    const panH1 = BASE_G * 0.80;  // inward overhang from BASE_R
    const panH2 = BASE_G * 0.80;  // outward overhang from BASE_R
    const panAlpha = isActive ? 'ff' : '30';

    fillQuad([
      { x: CX + dx * (BASE_R - panH1) + px * ( panW), y: CY + dy * (BASE_R - panH1) + py * ( panW) },
      { x: CX + dx * (BASE_R - panH1) + px * (-panW), y: CY + dy * (BASE_R - panH1) + py * (-panW) },
      { x: CX + dx * (BASE_R + panH2) + px * (-panW), y: CY + dy * (BASE_R + panH2) + py * (-panW) },
      { x: CX + dx * (BASE_R + panH2) + px * ( panW), y: CY + dy * (BASE_R + panH2) + py * ( panW) },
    ], color + panAlpha, null);

    // -- Marble holes on base panel --
    for (let mi = 0; mi < MARBLES_PER_PLAYER; mi++) {
      const p = basePos[ai]?.[mi];
      if (!p) continue;
      // Drilled hole (same style as track spaces but slightly larger)
      ctx.beginPath();
      ctx.arc(p.x, p.y, R * 1.08, 0, Math.PI * 2);
      ctx.fillStyle = T.hole;
      ctx.fill();
      ctx.strokeStyle = T.holeEdge;
      ctx.lineWidth   = 1.5;
      ctx.stroke();
      if (isActive) {
        ctx.beginPath();
        ctx.arc(p.x - R * 0.15, p.y - R * 0.15, R * 1.0, Math.PI * 1.05, Math.PI * 1.75);
        ctx.strokeStyle = T.holeHi;
        ctx.lineWidth   = R * 0.45;
        ctx.stroke();
      }
    }
  }
}

function drawHome(n) {
  const R = W * 0.020;
  const activeSet = new Set(playerToArm.slice(0, n));

  for (let ai = 0; ai < ALL_ARMS; ai++) {
    const isActive = activeSet.has(ai);
    const color    = COLORS[ai];
    const dark     = DARK_C[ai];

    // -- Home slots: dark drilled holes with colored border ring --
    const ringAlpha = isActive ? 'cc' : '30';
    for (let s = 1; s <= HOME_SLOTS; s++) {
      const p = homePos[ai]?.[s];
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, R * 1.15, 0, Math.PI * 2);
      ctx.fillStyle = T.hole;
      ctx.fill();
      ctx.strokeStyle = color + ringAlpha;
      ctx.lineWidth   = 2.5;
      if (isActive) glowOn(color, 0.7);
      ctx.stroke(); glowOff();
      if (isActive) {
        ctx.beginPath();
        ctx.arc(p.x - R * 0.12, p.y - R * 0.12, R * 0.9, Math.PI * 1.05, Math.PI * 1.75);
        ctx.strokeStyle = T.holeHi;
        ctx.lineWidth   = R * 0.40;
        ctx.stroke();
      }
    }
  }
}

// ---- Center hub: colored wedge sections + gold star ----

function drawCenter() {
  const outerR = W * 0.075;
  const innerR = W * 0.028;

  // Outer ring (dark navy, brass border)
  ctx.beginPath();
  ctx.arc(CX, CY, outerR, 0, Math.PI * 2);
  ctx.fillStyle = T.hubBg;
  ctx.fill();
  ctx.strokeStyle = T.hubRing;
  ctx.lineWidth   = 3;
  glowOn(T.hubRing); ctx.stroke(); glowOff();

  // Six colored wedge sections (one per arm color; all the occupant's color
  // while someone is in the hub)
  const wedgeR = outerR * 0.82;
  const wedges = hubWedgeColors(hubInstant);
  for (let i = 0; i < 6; i++) {
    const startAng = (i / 6) * Math.PI * 2 - Math.PI / 2 - viewArm * STEP;
    const endAng   = ((i + 1) / 6) * Math.PI * 2 - Math.PI / 2 - viewArm * STEP;
    ctx.beginPath();
    ctx.moveTo(CX, CY);
    ctx.arc(CX, CY, wedgeR, startAng, endAng);
    ctx.closePath();
    const [r, g, b] = wedges[i];
    ctx.fillStyle = `rgba(${r},${g},${b},0.8)`;
    ctx.fill();
  }

  // Brass dividers between wedges
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2 - Math.PI / 2 - viewArm * STEP;
    ctx.beginPath();
    ctx.moveTo(CX, CY);
    ctx.lineTo(CX + Math.cos(ang) * wedgeR, CY + Math.sin(ang) * wedgeR);
    ctx.strokeStyle = T.hubRing + 'cc';
    ctx.lineWidth   = 1.5;
    ctx.stroke();
  }

  // Center landing space — dark hole with white ring, matching other marble holes.
  const holeR = W * 0.022;
  ctx.beginPath();
  ctx.arc(CX, CY, holeR, 0, Math.PI * 2);
  ctx.fillStyle = T.hole;
  ctx.fill();
  ctx.strokeStyle = T.centerRing;
  ctx.lineWidth   = 3;
  glowOn(T.centerRing); ctx.stroke(); glowOff();
}

// ---- Marbles: glass sphere with specular highlight ----

function drawMarbles(gameState) {
  const R = W * 0.019;
  // Two passes: the moving marble last, so it travels over the marbles it passes.
  for (const pass of [0, 1])
  for (const player of gameState.players) {
    const ai    = playerToArm[player.index] ?? player.index;
    const color = COLORS[ai];
    for (const marble of player.marbles) {
      const pos = marblePosition(marble, player.index);
      if (!pos) continue;
      const isAnimating = animatingMarble &&
        animatingMarble.playerIndex === player.index &&
        animatingMarble.marbleId   === marble.id;
      if (!!isAnimating !== (pass === 1)) continue;
      const r = isAnimating ? R * 1.25 : R;

      // Drop shadow
      ctx.beginPath();
      ctx.arc(pos.x + r * 0.18, pos.y + r * 0.22, r * 0.88, 0, Math.PI * 2);
      ctx.fillStyle = T.shadow;
      ctx.fill();

      // Glow for animating marble
      if (isAnimating) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r * 1.7, 0, Math.PI * 2);
        ctx.fillStyle = color + '44';
        ctx.fill();
      }

      // Contrast backing: a dark socket a little larger than the marble.
      if (marbleStyle === 'socket') {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r * 1.2, 0, Math.PI * 2);
        ctx.fillStyle = T.socket;
        ctx.fill();
      }
      // Main marble body in the chosen finish.
      glowOn(color, 0.8);
      paintMarbleBody(pos, r, color, isAnimating, player.index * 4 + marble.id);
      glowOff();

      // Contrast ring: thicker and brighter in home/center where the background
      // is the same player color, making marbles hard to see.
      const inLowContrast = marble.zone === 'home' || marble.zone === 'center';
      if (isAnimating) {
        ctx.strokeStyle = '#ffffcc';
        ctx.lineWidth   = 2;
      } else if (marbleStyle === 'dark') {
        ctx.strokeStyle = 'rgba(0,0,0,0.9)';
        ctx.lineWidth   = Math.max(2, r * 0.16);
      } else if (marbleStyle === 'white') {
        ctx.strokeStyle = 'rgba(255,255,255,0.9)';
        ctx.lineWidth   = Math.max(1.5, r * 0.12);
      } else if (inLowContrast) {
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth   = 2;
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth   = 1;
      }
      ctx.stroke();

      // Specular highlight — small bright spot (glass sphere reflection); none on matte.
      if (finish === 'matte') continue;
      const specR = r * (finish === 'glass' ? 0.3 : finish === 'metal' ? 0.18 : 0.24);
      const specX = pos.x - r * 0.30;
      const specY = pos.y - r * 0.30;
      const specG = ctx.createRadialGradient(specX, specY, 0, specX, specY, specR);
      specG.addColorStop(0, 'rgba(255,255,255,0.92)');
      specG.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.beginPath();
      ctx.arc(specX, specY, specR, 0, Math.PI * 2);
      ctx.fillStyle = specG;
      ctx.fill();
    }
  }
}

// The marble's body: glossy (default), glass (see-through), swirl (a cat's eye
// ribbon of colour in clear glass), matte, metal (bright bands) or pearl (soft sheen).
function paintMarbleBody(pos, r, color, isAnimating, seed) {
  const g = (stops, x0 = -0.32, y0 = -0.32) => {
    const gr = ctx.createRadialGradient(pos.x + r * x0, pos.y + r * y0, r * 0.04, pos.x, pos.y, r);
    for (const [t, c] of stops) gr.addColorStop(t, c);
    return gr;
  };
  ctx.beginPath(); ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
  if (finish === 'glass') {
    ctx.fillStyle = g([[0, 'rgba(255,255,255,0.85)'], [0.3, rgba(color, 0.45)], [0.8, rgba(color, 0.7)], [1, darken(color, 0.35)]]);
    ctx.fill();
    // A bright caustic on the far side.
    ctx.beginPath(); ctx.arc(pos.x + r * 0.32, pos.y + r * 0.36, r * 0.36, 0, Math.PI * 2);
    ctx.fillStyle = g([[0, 'rgba(255,255,255,0.45)'], [1, 'rgba(255,255,255,0)']], 0.32, 0.36);
    ctx.fill();
  } else if (finish === 'swirl') {
    ctx.fillStyle = g([[0, 'rgba(255,255,255,0.95)'], [0.5, 'rgba(225,235,245,0.75)'], [1, 'rgba(150,160,175,0.95)']]);
    ctx.fill();
    // The cat's-eye ribbon: two curved vanes of colour, turned differently per marble.
    ctx.save(); ctx.beginPath(); ctx.arc(pos.x, pos.y, r * 0.98, 0, Math.PI * 2); ctx.clip();
    ctx.translate(pos.x, pos.y); ctx.rotate((seed * 1.7) % (Math.PI * 2));
    for (const sgn of [1, -1]) {
      ctx.beginPath();
      ctx.moveTo(-r, 0);
      ctx.bezierCurveTo(-r * 0.35, -r * 1.25 * sgn, r * 0.35, r * 1.05 * sgn, r, 0);
      ctx.bezierCurveTo(r * 0.35, r * 0.15 * sgn, -r * 0.35, -r * 0.35 * sgn, -r, 0);
      ctx.fillStyle = sgn > 0 ? color : darken(color, 0.2);
      ctx.fill();
    }
    ctx.restore();
  } else if (finish === 'matte') {
    ctx.fillStyle = g([[0, lighten(color, 0.25)], [0.7, color], [1, darken(color, 0.2)]], -0.2, -0.2);
    ctx.fill();
  } else if (finish === 'metal') {
    const lg = ctx.createLinearGradient(pos.x - r, pos.y - r, pos.x + r, pos.y + r);
    lg.addColorStop(0, lighten(color, 0.7)); lg.addColorStop(0.35, darken(color, 0.15)); lg.addColorStop(0.5, lighten(color, 0.85));
    lg.addColorStop(0.62, darken(color, 0.35)); lg.addColorStop(1, lighten(color, 0.4));
    ctx.fillStyle = lg; ctx.fill();
  } else if (finish === 'pearl') {
    ctx.fillStyle = g([[0, '#ffffff'], [0.35, lighten(color, 0.6)], [0.8, lighten(color, 0.3)], [1, color]]);
    ctx.fill();
    // A faint rainbow sheen.
    ctx.beginPath(); ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
    const sh = ctx.createLinearGradient(pos.x - r, pos.y + r, pos.x + r, pos.y - r);
    sh.addColorStop(0, 'rgba(255,120,200,0.18)'); sh.addColorStop(0.5, 'rgba(120,220,255,0.18)'); sh.addColorStop(1, 'rgba(255,240,140,0.18)');
    ctx.fillStyle = sh; ctx.fill();
  } else {
    ctx.fillStyle = g([[0, isAnimating ? '#ffffff' : lighten(color, 0.75)], [0.25, lighten(color, 0.45)], [0.65, color], [1, darken(color, 0.25)]]);
    ctx.fill();
  }
  // The ring stroke below follows the current path: put the outline back.
  ctx.beginPath(); ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
}
function rgba(hex, a) { const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); return `rgba(${r},${g},${b},${a})`; }

function marblePosition(marble, playerIndex) {
  const ai       = playerToArm[playerIndex] ?? playerIndex;
  const override = marbleOverrides[playerIndex]?.[marble.id];
  if (override)                return override;
  if (marble.zone === 'base')  return basePos[ai]?.[marble.id];
  if (marble.zone === 'track') return trackPos[marble.space];
  if (marble.zone === 'home')  return homePos[ai]?.[marble.slot];
  if (marble.zone === 'center') return centerPos;
  return null;
}

function lighten(hex, t = 0.5) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const m = (a) => Math.round(a + (255 - a) * t);
  return `rgb(${m(r)},${m(g)},${m(b)})`;
}

function darken(hex, t = 0.25) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const m = (a) => Math.round(a * (1 - t));
  return `rgb(${m(r)},${m(g)},${m(b)})`;
}

export function hitTestMarble(gameState, cx, cy) {
  if (!gameState) return null;
  const R = W * 0.024;
  for (const player of gameState.players) {
    for (const marble of player.marbles) {
      const pos = marblePosition(marble, player.index);
      if (!pos) continue;
      const dx = cx - pos.x, dy = cy - pos.y;
      if (dx * dx + dy * dy <= R * R) return { playerIndex: player.index, marbleId: marble.id };
    }
  }
  return null;
}

// What is drawn at canvas point (cx, cy): a track square, home slot, base
// slot or the hub — or null. Used for the hover tooltip.
//   { kind: 'track', space } | { kind: 'home', arm, slot } | { kind: 'base', arm }
//   | { kind: 'hub' }
export function spaceAt(cx, cy) {
  const R = W * 0.026;
  const near = p => p && (cx - p.x) ** 2 + (cy - p.y) ** 2 <= R * R;
  for (let s = 1; s < trackPos.length; s++) if (near(trackPos[s])) return { kind: 'track', space: s };
  for (let a = 0; a < ALL_ARMS; a++) {
    for (let k = 1; k <= HOME_SLOTS; k++) if (near(homePos[a]?.[k])) return { kind: 'home', arm: a, slot: k };
    for (const p of basePos[a] ?? []) if (near(p)) return { kind: 'base', arm: a };
  }
  if ((cx - centerPos.x) ** 2 + (cy - centerPos.y) ** 2 <= (W * 0.045) ** 2) return { kind: 'hub' };
  return null;
}

// style 'two' = reachable only by using both dice on the marble (dashed blue).
export function highlightSpaces(spaces, style) {
  const R = W * 0.020;
  const two = style === 'two';
  for (const sp of spaces) {
    const pos = getSpacePosition(sp);
    if (!pos) continue;
    ctx.save();
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, R * 1.5, 0, Math.PI * 2);
    ctx.fillStyle   = two ? '#40a0ff33' : '#00ff8844';
    ctx.fill();
    ctx.strokeStyle = two ? '#60b8ffee' : '#00ff88ee';
    ctx.lineWidth   = 2;
    if (two) ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.restore();
  }
}

export function highlightMarbleAt(marble, playerIndex) {
  if (!marble) return;
  const pos = marblePosition(marble, playerIndex);
  if (!pos) return;
  const R = W * 0.024;
  ctx.save();
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, R, 0, Math.PI * 2);
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth   = 2.5;
  ctx.setLineDash([6, 3]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

export function getSpacePosition(space) {
  if (!space) return null;
  if (space.zone === 'track')  return trackPos[space.space] ?? null;
  if (space.zone === 'center') return centerPos;
  if (space.zone === 'home') {
    const ai = playerToArm[space.playerIndex] ?? space.playerIndex;
    return homePos[ai]?.[space.slot] ?? null;
  }
  return null;
}

// ---- Move arrows (analysis replay) ----
// For each moved marble: a faded ghost where it started and a curved arrow to
// where it ended. moves: [{ from, to, playerIndex, bumped }] (marble objects).
// Bumped marbles (sent back to base) get a red dashed arrow.
export function drawMoveArrows(moves) {
  if (!ctx) return;
  const R = W * 0.019;
  for (const mv of moves) {
    const a = marblePosition(mv.from, mv.playerIndex);
    const b = marblePosition(mv.to, mv.playerIndex);
    if (!a || !b) continue;
    const color = mv.bumped ? '#ff3040' : COLORS[playerToArm[mv.playerIndex] ?? mv.playerIndex];
    // Ghost at the start square.
    ctx.save();
    ctx.beginPath();
    ctx.arc(a.x, a.y, R, 0, Math.PI * 2);
    ctx.fillStyle = color + '55';
    ctx.fill();
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.setLineDash([]);
    // Curved arrow, bent to one side so it doesn't hide the squares it crosses.
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    if (len < 1) { ctx.restore(); continue; }
    const ux = dx / len, uy = dy / len;
    const sx = a.x + ux * R, sy = a.y + uy * R;          // leave the ghost
    const ex = b.x - ux * R * 1.25, ey = b.y - uy * R * 1.25; // stop at the marble
    const bend = Math.min(len * 0.2, W * 0.05);
    const cx = (sx + ex) / 2 - uy * bend, cy = (sy + ey) / 2 + ux * bend;
    const stroke = (w, c, dash) => {
      ctx.beginPath(); ctx.moveTo(sx, sy); ctx.quadraticCurveTo(cx, cy, ex, ey);
      ctx.lineWidth = w; ctx.strokeStyle = c; ctx.setLineDash(dash); ctx.stroke(); ctx.setLineDash([]);
    };
    stroke(6, 'rgba(0,0,0,0.7)', mv.bumped ? [8, 5] : []);
    stroke(3, color, mv.bumped ? [8, 5] : []);
    // Arrowhead along the curve's end tangent.
    const tx = ex - cx, ty = ey - cy, tl = Math.hypot(tx, ty) || 1;
    const hx = tx / tl, hy = ty / tl, H = R * 1.1;
    ctx.beginPath();
    ctx.moveTo(ex + hx * 2, ey + hy * 2);
    ctx.lineTo(ex - hx * H - hy * H * 0.6, ey - hy * H + hx * H * 0.6);
    ctx.lineTo(ex - hx * H + hy * H * 0.6, ey - hy * H - hx * H * 0.6);
    ctx.closePath();
    ctx.fillStyle = color; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = 'rgba(0,0,0,0.8)'; ctx.stroke();
    // Die value at the middle of the arrow.
    if (mv.label != null) {
      const mx = 0.25 * sx + 0.5 * cx + 0.25 * ex, my = 0.25 * sy + 0.5 * cy + 0.25 * ey;
      const r = R * 0.75;
      ctx.beginPath();
      ctx.roundRect(mx - r, my - r, 2 * r, 2 * r, r * 0.3);
      ctx.fillStyle = '#fff'; ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = color; ctx.stroke();
      ctx.fillStyle = '#111';
      ctx.font = `bold ${Math.round(r * 1.4)}px system-ui, sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(mv.label), mx, my + 1);
    }
    ctx.restore();
  }
}
