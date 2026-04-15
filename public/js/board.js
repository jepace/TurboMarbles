// board.js — TurboMarbles board renderer
// See board-spec.md for the authoritative layout reference before editing this file.
//
// Space numbering (84 spaces total, 6 arms × 14):
//   arm a, base = a*14
//   base+1        = start (outermost, left col bottom)
//   base+2..+7    = left column (6 spaces, outer→inner), at -COL_OFF from arm axis
//   base+8        = STAR (apex, on arm axis, innermost)
//   base+9..+14   = right column (6 spaces, inner→outer), at +COL_OFF from arm axis

import {
  TRACK_SIZE, ALL_ARMS, MARBLES_PER_PLAYER, HOME_SLOTS,
  ARM_MAP, ALL_STARS as STAR_SPACES,
} from './constants.js';

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

export function setAnimatingMarble(playerIndex, marbleId) {
  animatingMarble = { playerIndex, marbleId };
}

export function clearAnimatingMarble() {
  animatingMarble = null;
}

function armAngle(ai) { return ai * STEP + Math.PI / 2; }

function computeLayout() {
  const R_OUTER    = W * 0.40;
  const R_COL_TOP  = W * 0.22;
  const R_STAR     = W * 0.16;
  const COL_OFF    = W * 0.052;
  const R_HOME_OUT = W * 0.36;
  const R_HOME_IN  = W * 0.24;
  const BASE_R     = W * 0.455;
  const BASE_G     = W * 0.038;

  GEO = { R_OUTER, R_COL_TOP, R_STAR, COL_OFF, R_HOME_OUT, R_HOME_IN, BASE_R, BASE_G };

  trackPos = new Array(TRACK_SIZE + 1);
  homePos  = [];
  basePos  = [];

  for (let arm = 0; arm < ALL_ARMS; arm++) {
    const ang  = armAngle(arm);
    const dx   = Math.cos(ang), dy = Math.sin(ang);
    const px   = -Math.sin(ang), py = Math.cos(ang);
    const base = arm * 14;

    const prev_ang = ang - Math.PI / 6;
    const next_ang = ang + Math.PI / 6;
    const prev_jx  = CX + Math.cos(prev_ang) * R_OUTER;
    const prev_jy  = CY + Math.sin(prev_ang) * R_OUTER;
    const next_jx  = CX + Math.cos(next_ang) * R_OUTER;
    const next_jy  = CY + Math.sin(next_ang) * R_OUTER;

    const lcx = CX + dx * R_COL_TOP - px * COL_OFF;
    const lcy = CY + dy * R_COL_TOP - py * COL_OFF;
    const rcx = CX + dx * R_COL_TOP + px * COL_OFF;
    const rcy = CY + dy * R_COL_TOP + py * COL_OFF;

    // Left column: spaces base+1 … base+7 (7 spaces)
    for (let i = 0; i < 7; i++) {
      const t = i / 6;
      trackPos[base + 1 + i] = {
        x: prev_jx + (lcx - prev_jx) * t,
        y: prev_jy + (lcy - prev_jy) * t,
      };
    }

    // Space base+8: star apex, on arm axis
    trackPos[base + 8] = { x: CX + dx * R_STAR, y: CY + dy * R_STAR };

    // Right column: spaces base+9 … base+14 (6 spaces)
    for (let i = 0; i < 6; i++) {
      const t = i / 5;
      trackPos[base + 9 + i] = {
        x: rcx + (next_jx - rcx) * t,
        y: rcy + (next_jy - rcy) * t,
      };
    }

    // Home slots 1–4, along arm axis from outer to inner
    homePos[arm] = new Array(HOME_SLOTS + 1);
    for (let s = 1; s <= HOME_SLOTS; s++) {
      const t = (s - 1) / (HOME_SLOTS - 1);
      const r = R_HOME_OUT + (R_HOME_IN - R_HOME_OUT) * t;
      homePos[arm][s] = { x: CX + dx * r, y: CY + dy * r };
    }

    // Base: 2×2 grid of 4 slots just outside the track
    basePos[arm] = [];
    for (let mi = 0; mi < MARBLES_PER_PLAYER; mi++) {
      const row = Math.floor(mi / 2);
      const col = mi % 2;
      const dr  = (row - 0.5) * BASE_G;
      const dp  = (col - 0.5) * BASE_G;
      basePos[arm].push({
        x: CX + dx * (BASE_R + dr) + px * dp,
        y: CY + dy * (BASE_R + dr) + py * dp,
      });
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
  drawAllArms(n);
  drawTrackRail();
  drawTrack();
  drawHomeAndBase(n);
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
  const { R_OUTER, R_COL_TOP, R_STAR, COL_OFF, R_HOME_OUT, R_HOME_IN } = GEO;

  const COL_HW  = COL_OFF * 0.94;
  const HOME_HW = COL_OFF * 0.65;

  const activeSet = new Set(playerToArm.slice(0, n));

  for (let ai = 0; ai < ALL_ARMS; ai++) {
    const ang      = armAngle(ai);
    const dx       = Math.cos(ang), dy = Math.sin(ang);
    const px       = -Math.sin(ang), py = Math.cos(ang);
    const color    = COLORS[ai];
    const dark     = DARK_C[ai];
    const isActive = activeSet.has(ai);
    const colAlpha  = isActive ? 'ff' : '38';
    const homeAlpha = isActive ? 'ee' : '28';

    // Left column strip at -COL_OFF
    fillQuad([
      { x: CX + dx * R_OUTER   + px * (-COL_OFF + COL_HW), y: CY + dy * R_OUTER   + py * (-COL_OFF + COL_HW) },
      { x: CX + dx * R_OUTER   + px * (-COL_OFF - COL_HW), y: CY + dy * R_OUTER   + py * (-COL_OFF - COL_HW) },
      { x: CX + dx * R_COL_TOP + px * (-COL_OFF - COL_HW), y: CY + dy * R_COL_TOP + py * (-COL_OFF - COL_HW) },
      { x: CX + dx * R_COL_TOP + px * (-COL_OFF + COL_HW), y: CY + dy * R_COL_TOP + py * (-COL_OFF + COL_HW) },
    ], color + colAlpha, dark + (isActive ? '99' : '44'), 1.5);

    // Right column strip at +COL_OFF
    fillQuad([
      { x: CX + dx * R_OUTER   + px * ( COL_OFF - COL_HW), y: CY + dy * R_OUTER   + py * ( COL_OFF - COL_HW) },
      { x: CX + dx * R_OUTER   + px * ( COL_OFF + COL_HW), y: CY + dy * R_OUTER   + py * ( COL_OFF + COL_HW) },
      { x: CX + dx * R_COL_TOP + px * ( COL_OFF + COL_HW), y: CY + dy * R_COL_TOP + py * ( COL_OFF + COL_HW) },
      { x: CX + dx * R_COL_TOP + px * ( COL_OFF - COL_HW), y: CY + dy * R_COL_TOP + py * ( COL_OFF - COL_HW) },
    ], color + colAlpha, dark + (isActive ? '99' : '44'), 1.5);

    // Home corridor strip along arm axis
    fillQuad([
      { x: CX + dx * R_HOME_OUT + px *  HOME_HW, y: CY + dy * R_HOME_OUT + py *  HOME_HW },
      { x: CX + dx * R_HOME_OUT - px *  HOME_HW, y: CY + dy * R_HOME_OUT - py *  HOME_HW },
      { x: CX + dx * R_HOME_IN  - px *  HOME_HW, y: CY + dy * R_HOME_IN  - py *  HOME_HW },
      { x: CX + dx * R_HOME_IN  + px *  HOME_HW, y: CY + dy * R_HOME_IN  + py *  HOME_HW },
    ], color + homeAlpha, dark + (isActive ? '99' : '30'), 1);

    // Apex triangle: top of left col → star → top of right col
    const lTop = { x: CX + dx * R_COL_TOP - px * COL_OFF, y: CY + dy * R_COL_TOP - py * COL_OFF };
    const rTop = { x: CX + dx * R_COL_TOP + px * COL_OFF, y: CY + dy * R_COL_TOP + py * COL_OFF };
    const apex = { x: CX + dx * R_STAR,                   y: CY + dy * R_STAR };
    ctx.beginPath();
    ctx.moveTo(lTop.x, lTop.y);
    ctx.lineTo(apex.x, apex.y);
    ctx.lineTo(rTop.x, rTop.y);
    ctx.closePath();
    ctx.fillStyle = color + (isActive ? 'ee' : '28');
    ctx.fill();
    if (isActive) {
      ctx.strokeStyle = dark + 'aa';
      ctx.lineWidth   = 1;
      ctx.stroke();
    }
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

function drawTrack() {
  const R = W * 0.020;

  for (let i = 1; i <= TRACK_SIZE; i++) {
    const p = trackPos[i];
    if (!p) continue;

    if (STAR_SPACES.has(i)) {
      // Gold shortcut marker — bold circle with 6-pointed star
      // Outer glow ring
      ctx.beginPath();
      ctx.arc(p.x, p.y, R * 2.6, 0, Math.PI * 2);
      ctx.fillStyle = '#c8920a30';
      ctx.fill();
      // Gold disc
      ctx.beginPath();
      ctx.arc(p.x, p.y, R * 2.0, 0, Math.PI * 2);
      ctx.fillStyle = '#c8920a';
      ctx.fill();
      ctx.strokeStyle = STAR_GOLD;
      ctx.lineWidth   = 2;
      ctx.stroke();
      // 6-pointed star inset
      drawStar6(p.x, p.y, R * 1.35, STAR_GOLD, '#8a5e00');
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

function drawHomeAndBase(n) {
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

    // -- Home slots --
    for (let s = 1; s <= HOME_SLOTS; s++) {
      const p = homePos[ai]?.[s];
      if (!p) continue;
      // Filled slot with player color
      ctx.beginPath();
      ctx.arc(p.x, p.y, R * 1.45, 0, Math.PI * 2);
      ctx.fillStyle   = color + (isActive ? '88' : '18');
      ctx.fill();
      ctx.strokeStyle = dark + (isActive ? 'cc' : '30');
      ctx.lineWidth   = 2;
      ctx.stroke();
      // Inner highlight arc
      if (isActive) {
        ctx.beginPath();
        ctx.arc(p.x - R * 0.12, p.y - R * 0.12, R * 0.9, Math.PI * 1.05, Math.PI * 1.75);
        ctx.strokeStyle = 'rgba(255,255,255,0.18)';
        ctx.lineWidth   = R * 0.40;
        ctx.stroke();
      }
    }

    // -- Base panel: solid colored background behind the 2×2 marble grid --
    const panW  = BASE_G * 1.65;  // half-width of panel
    const panH1 = BASE_G * 1.30;  // inward overhang from BASE_R
    const panH2 = BASE_G * 1.55;  // outward overhang from BASE_R
    const panAlpha = isActive ? 'ff' : '30';
    const panBorder = isActive ? dark + 'ff' : dark + '40';

    fillQuad([
      { x: CX + dx * (BASE_R - panH1) + px * ( panW), y: CY + dy * (BASE_R - panH1) + py * ( panW) },
      { x: CX + dx * (BASE_R - panH1) + px * (-panW), y: CY + dy * (BASE_R - panH1) + py * (-panW) },
      { x: CX + dx * (BASE_R + panH2) + px * (-panW), y: CY + dy * (BASE_R + panH2) + py * (-panW) },
      { x: CX + dx * (BASE_R + panH2) + px * ( panW), y: CY + dy * (BASE_R + panH2) + py * ( panW) },
    ], color + panAlpha, panBorder, 2.5);

    // Darker inner band across top of panel (label area on classic board)
    const bandH = BASE_G * 0.42;
    fillQuad([
      { x: CX + dx * (BASE_R - panH1)        + px * ( panW), y: CY + dy * (BASE_R - panH1)        + py * ( panW) },
      { x: CX + dx * (BASE_R - panH1)        + px * (-panW), y: CY + dy * (BASE_R - panH1)        + py * (-panW) },
      { x: CX + dx * (BASE_R - panH1 + bandH) + px * (-panW), y: CY + dy * (BASE_R - panH1 + bandH) + py * (-panW) },
      { x: CX + dx * (BASE_R - panH1 + bandH) + px * ( panW), y: CY + dy * (BASE_R - panH1 + bandH) + py * ( panW) },
    ], dark + (isActive ? 'cc' : '20'), null);

    // -- Marble holes on base panel --
    for (let mi = 0; mi < MARBLES_PER_PLAYER; mi++) {
      const p = basePos[ai]?.[mi];
      if (!p) continue;
      // Drilled hole (same style as track spaces but larger)
      ctx.beginPath();
      ctx.arc(p.x, p.y, R * 1.55, 0, Math.PI * 2);
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

  // Inner dark ring to frame the center star
  ctx.beginPath();
  ctx.arc(CX, CY, innerR * 1.6, 0, Math.PI * 2);
  ctx.fillStyle = '#06101e';
  ctx.fill();
  ctx.strokeStyle = '#c8920a88';
  ctx.lineWidth   = 1.5;
  ctx.stroke();

  // Gold 6-pointed star in the center
  drawStar6(CX, CY, innerR * 1.25, STAR_GOLD, '#8a6000');

  // Bright gold dot at absolute center
  ctx.beginPath();
  ctx.arc(CX, CY, innerR * 0.35, 0, Math.PI * 2);
  ctx.fillStyle = '#fff8d0';
  ctx.fill();
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
      ctx.strokeStyle = isAnimating ? '#ffffcc' : 'rgba(255,255,255,0.35)';
      ctx.lineWidth   = isAnimating ? 2 : 1;
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
