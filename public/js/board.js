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

const BG_BLUE     = '#1565c0';
const STAR_GOLD   = '#ffd600';
const CENTER_PINK = '#e91e63';
const STEP = (2 * Math.PI) / ALL_ARMS;

let canvas, ctx, W, CX, CY;
let trackPos  = [];
let homePos   = [];
let basePos   = [];
let centerPos = { x: 0, y: 0 };
let bubbles   = [];
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
  computeBubbles();
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

    // Junction angles: where this arm meets the previous and next arm.
    // Adjacent arms are 60° apart; junction is the midpoint angle = ±30° from arm axis.
    // Space base+1 must land at prev_junction so it's co-located with space (base-1) from the
    // prior arm. Similarly space base+14 must land at next_junction = space (base+15) start.
    const prev_ang = ang - Math.PI / 6;
    const next_ang = ang + Math.PI / 6;
    const prev_jx  = CX + Math.cos(prev_ang) * R_OUTER;
    const prev_jy  = CY + Math.sin(prev_ang) * R_OUTER;
    const next_jx  = CX + Math.cos(next_ang) * R_OUTER;
    const next_jy  = CY + Math.sin(next_ang) * R_OUTER;

    // Column tops (unchanged — flanking the star near arm axis)
    const lcx = CX + dx * R_COL_TOP - px * COL_OFF;
    const lcy = CY + dy * R_COL_TOP - py * COL_OFF;
    const rcx = CX + dx * R_COL_TOP + px * COL_OFF;
    const rcy = CY + dy * R_COL_TOP + py * COL_OFF;

    // Left column: spaces base+1 … base+7 (7 spaces)
    // Lerp from prev_junction (t=0, outermost) to left_col_top (t=1, innermost)
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
    // Lerp from right_col_top (t=0, innermost) to next_junction (t=1, outermost)
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

function computeBubbles() {
  bubbles = [];
  let s = 0x12345678;
  const rand = () => { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return (s >>> 0) / 0xffffffff; };
  for (let i = 0; i < 200; i++) {
    bubbles.push({ x: rand() * W, y: rand() * W, r: W * (0.007 + rand() * 0.018), a: 0.08 + rand() * 0.18 });
  }
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

function drawBackground() {
  ctx.fillStyle = BG_BLUE;
  ctx.fillRect(0, 0, W, W);
  for (const b of bubbles) {
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(25,118,210,${b.a.toFixed(2)})`;
    ctx.fill();
  }
}

function drawAllArms(n) {
  const { R_OUTER, R_COL_TOP, R_STAR, COL_OFF, R_HOME_OUT, R_HOME_IN } = GEO;

  const COL_HW  = COL_OFF * 0.80;
  const HOME_HW = COL_OFF * 0.52;

  const activeSet = new Set(playerToArm.slice(0, n));

  for (let ai = 0; ai < ALL_ARMS; ai++) {
    const ang      = armAngle(ai);
    const dx       = Math.cos(ang), dy = Math.sin(ang);
    const px       = -Math.sin(ang), py = Math.cos(ang);
    const color    = COLORS[ai];
    const isActive = activeSet.has(ai);
    const colAlpha  = isActive ? 'bb' : '33';
    const homeAlpha = isActive ? '66' : '18';

    // Left column strip at -COL_OFF
    fillQuad([
      { x: CX + dx * R_OUTER  + px * (-COL_OFF + COL_HW), y: CY + dy * R_OUTER  + py * (-COL_OFF + COL_HW) },
      { x: CX + dx * R_OUTER  + px * (-COL_OFF - COL_HW), y: CY + dy * R_OUTER  + py * (-COL_OFF - COL_HW) },
      { x: CX + dx * R_COL_TOP + px * (-COL_OFF - COL_HW), y: CY + dy * R_COL_TOP + py * (-COL_OFF - COL_HW) },
      { x: CX + dx * R_COL_TOP + px * (-COL_OFF + COL_HW), y: CY + dy * R_COL_TOP + py * (-COL_OFF + COL_HW) },
    ], color + colAlpha, '#00000033');

    // Right column strip at +COL_OFF
    fillQuad([
      { x: CX + dx * R_OUTER  + px * ( COL_OFF - COL_HW), y: CY + dy * R_OUTER  + py * ( COL_OFF - COL_HW) },
      { x: CX + dx * R_OUTER  + px * ( COL_OFF + COL_HW), y: CY + dy * R_OUTER  + py * ( COL_OFF + COL_HW) },
      { x: CX + dx * R_COL_TOP + px * ( COL_OFF + COL_HW), y: CY + dy * R_COL_TOP + py * ( COL_OFF + COL_HW) },
      { x: CX + dx * R_COL_TOP + px * ( COL_OFF - COL_HW), y: CY + dy * R_COL_TOP + py * ( COL_OFF - COL_HW) },
    ], color + colAlpha, '#00000033');

    // Home corridor strip along arm axis
    fillQuad([
      { x: CX + dx * R_HOME_OUT + px *  HOME_HW, y: CY + dy * R_HOME_OUT + py *  HOME_HW },
      { x: CX + dx * R_HOME_OUT - px *  HOME_HW, y: CY + dy * R_HOME_OUT - py *  HOME_HW },
      { x: CX + dx * R_HOME_IN  - px *  HOME_HW, y: CY + dy * R_HOME_IN  - py *  HOME_HW },
      { x: CX + dx * R_HOME_IN  + px *  HOME_HW, y: CY + dy * R_HOME_IN  + py *  HOME_HW },
    ], color + homeAlpha, null);

    // Apex triangle: top of left col → star → top of right col
    const lTop = { x: CX + dx * R_COL_TOP - px * COL_OFF, y: CY + dy * R_COL_TOP - py * COL_OFF };
    const rTop = { x: CX + dx * R_COL_TOP + px * COL_OFF, y: CY + dy * R_COL_TOP + py * COL_OFF };
    const apex = { x: CX + dx * R_STAR,                   y: CY + dy * R_STAR };
    ctx.beginPath();
    ctx.moveTo(lTop.x, lTop.y);
    ctx.lineTo(apex.x, apex.y);
    ctx.lineTo(rTop.x, rTop.y);
    ctx.closePath();
    ctx.fillStyle = color + (isActive ? '99' : '28');
    ctx.fill();
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

function drawTrackRail() {
  ctx.beginPath();
  for (let i = 1; i <= TRACK_SIZE; i++) {
    const p = trackPos[i];
    if (!p) continue;
    i === 1 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth   = W * 0.015;
  ctx.lineJoin    = 'round';
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth   = W * 0.006;
  ctx.stroke();
}

function drawTrack() {
  const R = W * 0.018;

  for (let i = 1; i <= TRACK_SIZE; i++) {
    const p = trackPos[i];
    if (!p) continue;

    if (STAR_SPACES.has(i)) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, R * 1.8, 0, Math.PI * 2);
      ctx.fillStyle   = '#7a5000cc';
      ctx.fill();
      ctx.strokeStyle = STAR_GOLD;
      ctx.lineWidth   = 2;
      ctx.stroke();
      drawStar8(p.x, p.y, R * 1.3, STAR_GOLD);
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
      ctx.fillStyle   = '#1a3a8faa';
      ctx.fill();
      ctx.strokeStyle = '#ffffffaa';
      ctx.lineWidth   = 1;
      ctx.stroke();
    }
  }
}

function drawHomeAndBase(n) {
  const R = W * 0.018;
  const activeSet = new Set(playerToArm.slice(0, n));

  for (let ai = 0; ai < ALL_ARMS; ai++) {
    const isActive = activeSet.has(ai);
    const color    = COLORS[ai];

    for (let s = 1; s <= HOME_SLOTS; s++) {
      const p = homePos[ai]?.[s];
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, R * 1.25, 0, Math.PI * 2);
      ctx.fillStyle   = '#00000055';
      ctx.fill();
      ctx.strokeStyle = color + (isActive ? 'dd' : '44');
      ctx.lineWidth   = 2;
      ctx.stroke();
    }

    for (let mi = 0; mi < MARBLES_PER_PLAYER; mi++) {
      const p = basePos[ai]?.[mi];
      if (!p) continue;
      ctx.beginPath();
      ctx.arc(p.x, p.y, R * 1.55, 0, Math.PI * 2);
      ctx.fillStyle   = '#00000055';
      ctx.fill();
      ctx.strokeStyle = color + (isActive ? 'aa' : '33');
      ctx.lineWidth   = 1.5;
      ctx.stroke();
    }
  }
}

function drawCenter() {
  const outerR = W * 0.065;
  const innerR = W * 0.025;

  ctx.beginPath();
  ctx.arc(CX, CY, outerR, 0, Math.PI * 2);
  ctx.fillStyle   = '#0a1040';
  ctx.fill();
  ctx.strokeStyle = '#4060cc';
  ctx.lineWidth   = 2;
  ctx.stroke();

  ctx.save();
  ctx.translate(CX, CY);

  for (let i = 0; i < 6; i++) {
    ctx.save();
    ctx.rotate(i * Math.PI / 3 + Math.PI / 12);
    ctx.beginPath();
    ctx.ellipse(0, outerR * 0.52, outerR * 0.28, outerR * 0.54, 0, 0, Math.PI * 2);
    ctx.fillStyle   = CENTER_PINK;
    ctx.fill();
    ctx.strokeStyle = '#ad004066';
    ctx.lineWidth   = 1;
    ctx.stroke();
    ctx.restore();
  }

  ctx.beginPath();
  ctx.arc(0, 0, innerR, 0, Math.PI * 2);
  ctx.fillStyle   = STAR_GOLD;
  ctx.fill();
  ctx.strokeStyle = '#c8a000';
  ctx.lineWidth   = 1.5;
  ctx.stroke();

  ctx.restore();
}

function drawMarbles(gameState) {
  const R = W * 0.016;
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
      ctx.arc(pos.x + 2, pos.y + 2, r, 0, Math.PI * 2);
      ctx.fillStyle = '#0008';
      ctx.fill();

      // Glow for animating marble
      if (isAnimating) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, r * 1.6, 0, Math.PI * 2);
        ctx.fillStyle = color + '44';
        ctx.fill();
      }

      // Marble with radial gradient
      const grad = ctx.createRadialGradient(
        pos.x - r * 0.3, pos.y - r * 0.3, r * 0.05,
        pos.x, pos.y, r
      );
      grad.addColorStop(0, isAnimating ? '#ffffff' : lighten(color));
      grad.addColorStop(0.35, lighten(color));
      grad.addColorStop(1, color);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.fillStyle   = grad;
      ctx.fill();
      ctx.strokeStyle = isAnimating ? '#ffffcccc' : '#fff5';
      ctx.lineWidth   = isAnimating ? 2 : 1;
      ctx.stroke();
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

function drawStar8(cx, cy, R, color) {
  const r = R * 0.4;
  ctx.beginPath();
  for (let i = 0; i < 16; i++) {
    const ang = (i * Math.PI) / 8 - Math.PI / 2;
    const rad = i % 2 === 0 ? R : r;
    const x   = cx + Math.cos(ang) * rad;
    const y   = cy + Math.sin(ang) * rad;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle   = color;
  ctx.fill();
  ctx.strokeStyle = '#ff8f00';
  ctx.lineWidth   = 1;
  ctx.stroke();
}

function lighten(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const m = (a, t) => Math.round(a + (255 - a) * t);
  return `rgb(${m(r, 0.5)},${m(g, 0.5)},${m(b, 0.5)})`;
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
  const R = W * 0.018;
  for (const sp of spaces) {
    const pos = getSpacePosition(sp);
    if (!pos) continue;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, R * 1.4, 0, Math.PI * 2);
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
