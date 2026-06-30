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
const COLORS = ['#2288f0','#e8208c','#ff7800','#f5d000','#44bb44','#e0e0e0'];
const DARK_C  = ['#1155cc','#a01060','#c05000','#b09800','#228822','#909090'];

const STAR_GOLD = '#f5c842';
const STEP = (2 * Math.PI) / ALL_ARMS;

let canvas, ctx, W, CX, CY;
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
  const size = Math.max(200, Math.min(
    rect.width  > 0 ? rect.width  : window.innerWidth  - 230,
    rect.height > 0 ? rect.height : window.innerHeight - 10,
    window.innerHeight - 10
  ));
  if (canvas.width === size) return;
  canvas.width  = size;
  canvas.height = size;
  W  = size;
  CX = CY = size / 2;
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

function armAngle(ai) { return ai * STEP + Math.PI / 2; }

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

export function drawBoard(gameState) {
  if (!ctx || !W) return;
  const n = gameState?.players?.length ?? ALL_ARMS;
  playerToArm = ARM_MAP[n] ?? Array.from({ length: n }, (_, i) => i);

  ctx.clearRect(0, 0, W, W);
  drawBackground();
  drawBase(n);       // drawn first so arm strips and track paint over its inner edge
  drawAllArms(n);
  drawTrackRail();
  drawTrack(n);
  drawHome(n);
  drawCenter();
  if (gameState) drawMarbles(gameState);
}

// ---- Background: dark navy board with brass rim ----

function drawBackground() {
  ctx.fillStyle = '#050b1e';
  ctx.fillRect(0, 0, W, W);

  // Outer brass/gold rim circle
  const rimR = W * 0.493;
  ctx.beginPath();
  ctx.arc(CX, CY, rimR, 0, Math.PI * 2);
  ctx.strokeStyle = '#c8920a';
  ctx.lineWidth   = W * 0.009;
  ctx.stroke();

  // Inner thin accent ring
  ctx.beginPath();
  ctx.arc(CX, CY, rimR - W * 0.006, 0, Math.PI * 2);
  ctx.strokeStyle = '#f5c84280';
  ctx.lineWidth   = W * 0.002;
  ctx.stroke();

  // Board surface: dark navy radial gradient
  const grad = ctx.createRadialGradient(CX, CY * 0.85, 0, CX, CY, rimR);
  grad.addColorStop(0,   '#1e2f60');
  grad.addColorStop(0.45, '#121e4a');
  grad.addColorStop(1,   '#07101e');
  ctx.beginPath();
  ctx.arc(CX, CY, rimR - W * 0.009, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();
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
    ], color + 'ff', null);

    fillQuad([
      pt(COL_TOP,          -COL_OFF + COL_HW),
      pt(COL_TOP,          -COL_OFF - COL_HW),
      pt(R_OUTER + COL_HW, -COL_OFF - COL_HW),
      pt(R_OUTER + COL_HW, -COL_OFF + COL_HW),
    ], color + 'ff', null);

    fillQuad([
      pt(R_OUTER - COL_HW, -COL_OFF - COL_HW),
      pt(R_OUTER - COL_HW,  COL_OFF + COL_HW),
      pt(R_OUTER + COL_HW,  COL_OFF + COL_HW),
      pt(R_OUTER + COL_HW, -COL_OFF - COL_HW),
    ], color + 'ff', null);

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
  if (strokeStyle) { ctx.strokeStyle = strokeStyle; ctx.lineWidth = lineWidth; ctx.stroke(); }
}

// ---- Track rail: subtle path line ----

function drawTrackRail() {
  // Inner star-track ring through the 6 stars
  ctx.save();
  ctx.beginPath();
  ctx.arc(CX, CY, GEO.STAR_RING, 0, Math.PI * 2);
  ctx.strokeStyle = 'rgba(245,200,66,0.25)';
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
  ctx.strokeStyle = 'rgba(255,255,255,0.10)';
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
      ctx.fillStyle = '#c8920a30';
      ctx.fill();
      // Gold disc
      ctx.beginPath();
      ctx.arc(p.x, p.y, R * 1.5, 0, Math.PI * 2);
      ctx.fillStyle = '#c8920a';
      ctx.fill();
      ctx.strokeStyle = STAR_GOLD;
      ctx.lineWidth   = 2;
      ctx.stroke();
      // 6-pointed star inset
      drawStar6(p.x, p.y, R * 1.1, STAR_GOLD, '#8a5e00');
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
      ctx.stroke();
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
      ctx.fillStyle = '#06080f';
      ctx.fill();
      // Subtle outer rim
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth   = 1;
      ctx.stroke();
      // Inner highlight arc (top-left quadrant) simulates concave depression
      ctx.beginPath();
      ctx.arc(p.x - R * 0.12, p.y - R * 0.12, R * 0.68, Math.PI * 1.05, Math.PI * 1.75);
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
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
      ctx.fillStyle = '#06080f';
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.lineWidth   = 1.5;
      ctx.stroke();
      if (isActive) {
        ctx.beginPath();
        ctx.arc(p.x - R * 0.15, p.y - R * 0.15, R * 1.0, Math.PI * 1.05, Math.PI * 1.75);
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
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
      ctx.fillStyle = '#06080f';
      ctx.fill();
      ctx.strokeStyle = color + ringAlpha;
      ctx.lineWidth   = 2.5;
      ctx.stroke();
      if (isActive) {
        ctx.beginPath();
        ctx.arc(p.x - R * 0.12, p.y - R * 0.12, R * 0.9, Math.PI * 1.05, Math.PI * 1.75);
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
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
  ctx.fillStyle = '#06101e';
  ctx.fill();
  ctx.strokeStyle = '#c8920a';
  ctx.lineWidth   = 3;
  ctx.stroke();

  // Six colored wedge sections (one per arm color)
  const wedgeR = outerR * 0.82;
  for (let i = 0; i < 6; i++) {
    const startAng = (i / 6) * Math.PI * 2 - Math.PI / 2;
    const endAng   = ((i + 1) / 6) * Math.PI * 2 - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(CX, CY);
    ctx.arc(CX, CY, wedgeR, startAng, endAng);
    ctx.closePath();
    ctx.fillStyle = COLORS[i] + 'cc';
    ctx.fill();
  }

  // Brass dividers between wedges
  for (let i = 0; i < 6; i++) {
    const ang = (i / 6) * Math.PI * 2 - Math.PI / 2;
    ctx.beginPath();
    ctx.moveTo(CX, CY);
    ctx.lineTo(CX + Math.cos(ang) * wedgeR, CY + Math.sin(ang) * wedgeR);
    ctx.strokeStyle = '#c8920acc';
    ctx.lineWidth   = 1.5;
    ctx.stroke();
  }

  // Center landing space — dark hole with white ring, matching other marble holes.
  const holeR = W * 0.022;
  ctx.beginPath();
  ctx.arc(CX, CY, holeR, 0, Math.PI * 2);
  ctx.fillStyle = '#06080f';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.90)';
  ctx.lineWidth   = 3;
  ctx.stroke();
}

// ---- Marbles: glass sphere with specular highlight ----

function drawMarbles(gameState) {
  const R = W * 0.019;
  for (const player of gameState.players) {
    const ai    = playerToArm[player.index] ?? player.index;
    const color = COLORS[ai];
    for (const marble of player.marbles) {
      const pos = marblePosition(marble, player.index);
      if (!pos) continue;
      const isAnimating = animatingMarble &&
        animatingMarble.playerIndex === player.index &&
        animatingMarble.marbleId   === marble.id;
      const r = isAnimating ? R * 1.25 : R;

      // Drop shadow
      ctx.beginPath();
      ctx.arc(pos.x + r * 0.18, pos.y + r * 0.22, r * 0.88, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fill();

      // Glow for animating marble
      if (isAnimating) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r * 1.7, 0, Math.PI * 2);
        ctx.fillStyle = color + '44';
        ctx.fill();
      }

      // Main marble body with radial gradient (dark at edge, bright at highlight)
      const grad = ctx.createRadialGradient(
        pos.x - r * 0.32, pos.y - r * 0.32, r * 0.04,
        pos.x,            pos.y,             r
      );
      grad.addColorStop(0,    isAnimating ? '#ffffff' : lighten(color, 0.75));
      grad.addColorStop(0.25, lighten(color, 0.45));
      grad.addColorStop(0.65, color);
      grad.addColorStop(1,    darken(color, 0.25));
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.fillStyle   = grad;
      ctx.fill();

      // Contrast ring: thicker and brighter in home/center where the background
      // is the same player color, making marbles hard to see.
      const inLowContrast = marble.zone === 'home' || marble.zone === 'center';
      if (isAnimating) {
        ctx.strokeStyle = '#ffffcc';
        ctx.lineWidth   = 2;
      } else if (inLowContrast) {
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth   = 2;
      } else {
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth   = 1;
      }
      ctx.stroke();

      // Specular highlight — small bright spot (glass sphere reflection)
      const specR = r * 0.24;
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

export function highlightSpaces(spaces) {
  const R = W * 0.020;
  for (const sp of spaces) {
    const pos = getSpacePosition(sp);
    if (!pos) continue;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, R * 1.5, 0, Math.PI * 2);
    ctx.fillStyle   = '#00ff8844';
    ctx.fill();
    ctx.strokeStyle = '#00ff88ee';
    ctx.lineWidth   = 2;
    ctx.stroke();
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
