// board.js — Aggravation-style canvas rendering for TurboMarbles

const TRACK_SIZE = 84;
const ALL_ARMS   = 6;
const MARBLES_PER_PLAYER = 4;
const HOME_SLOTS = 4;

// Hex colors indexed by arm index 0–5 (matches PLAYER_CONFIG order)
const COLORS = ['#f5d000','#ff7800','#e8208c','#e0e0e0','#44bb44','#2288f0'];
const DARK_C  = ['#b09800','#c05000','#a01060','#909090','#228822','#1155cc'];

// Same ARM_MAP as GameEngine.js — determines which arm each player occupies
const ARM_MAP = {
  2: [0, 3],
  3: [0, 2, 4],
  4: [0, 1, 3, 4],
  5: [0, 1, 2, 3, 4],
  6: [0, 1, 2, 3, 4, 5],
};

const STAR_SPACES = new Set([8, 22, 36, 50, 64, 78]);
const BG_BLUE     = '#1565c0';
const STAR_GOLD   = '#ffd600';
const CENTER_PINK = '#e91e63';

let canvas, ctx, W, H, CX, CY;
let trackPos = [];
let homePos  = [];   // [armIndex][slot 1..4]
let basePos  = [];   // [armIndex][0..3]
let centerPos = {};
let bubbles = [];

// Updated at the start of each drawBoard call from gameState.players.length
let playerToArm = [0, 1, 2, 3, 4, 5];

export function init(canvasEl) {
  canvas = canvasEl;
  ctx = canvas.getContext('2d');
  resize();
  window.addEventListener('resize', resize);
}

export function resize() {
  const rect = canvas.parentElement.getBoundingClientRect();
  const size = Math.min(rect.width, rect.height);
  canvas.width  = size;
  canvas.height = size;
  W = H = size;
  CX = W / 2;
  CY = H / 2;
  computeLayout();
  computeBubbles();
}

// ---------- Layout -----------------------------------------------------------

function computeLayout() {
  const STEP     = (2 * Math.PI) / ALL_ARMS;
  const ARM_OUT  = W * 0.43;
  const ARM_IN   = W * 0.115;
  const BASE_OUT = ARM_OUT + W * 0.155;

  // Track: 84 spaces laid out in a perfect circle
  trackPos = new Array(TRACK_SIZE + 1);
  for (let i = 1; i <= TRACK_SIZE; i++) {
    const ai   = Math.floor((i - 1) / 14);
    const pos  = (i - 1) % 14;
    const frac = (pos - 6.5) / TRACK_SIZE;
    const ang  = ai * STEP + Math.PI / 2 + frac * 2 * Math.PI;
    trackPos[i] = { x: CX + Math.cos(ang) * ARM_OUT, y: CY + Math.sin(ang) * ARM_OUT };
  }

  // Home and base positions for all 6 arm slots
  homePos = [];
  basePos = [];
  for (let ai = 0; ai < ALL_ARMS; ai++) {
    const ang  = ai * STEP + Math.PI / 2;
    const perp = ang + Math.PI / 2;

    // Home: 4 slots in a line along arm axis, inner section
    homePos[ai] = new Array(HOME_SLOTS + 1);
    const span = ARM_OUT - ARM_IN;
    for (let s = 1; s <= HOME_SLOTS; s++) {
      const d = ARM_IN + (s - 0.5) * span / (HOME_SLOTS + 0.5);
      homePos[ai][s] = { x: CX + Math.cos(ang) * d, y: CY + Math.sin(ang) * d };
    }

    // Base: 2×2 grid beyond track ring
    const BC   = ARM_OUT + W * 0.078;
    const GRID = W * 0.034;
    basePos[ai] = [];
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 2; col++) {
        const sign = col === 0 ? -1 : 1;
        const d    = BC + (row === 0 ? -GRID * 0.5 : GRID * 0.5);
        basePos[ai].push({
          x: CX + Math.cos(ang) * d + Math.cos(perp) * sign * GRID * 0.5,
          y: CY + Math.sin(ang) * d + Math.sin(perp) * sign * GRID * 0.5,
        });
      }
    }
  }

  centerPos = { x: CX, y: CY };
}

function computeBubbles() {
  bubbles = [];
  let s = 0x12345678;
  function rand() { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return (s >>> 0) / 0xffffffff; }
  for (let i = 0; i < 300; i++) {
    bubbles.push({ x: rand() * W, y: rand() * H, r: W * (0.007 + rand() * 0.018), a: 0.1 + rand() * 0.25 });
  }
}

// ---------- Draw -------------------------------------------------------------

export function drawBoard(gameState) {
  const n = gameState?.players?.length ?? ALL_ARMS;
  playerToArm = ARM_MAP[n] ?? [0, 1, 2, 3, 4, 5];

  ctx.clearRect(0, 0, W, H);
  drawBackground();
  drawArms(n);
  drawTrack(n);
  drawHomeAndBase(n);
  drawCenter();
  if (gameState) drawMarbles(gameState);
}

function drawBackground() {
  ctx.fillStyle = BG_BLUE;
  ctx.fillRect(0, 0, W, H);
  for (const b of bubbles) {
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(25,118,210,${b.a.toFixed(2)})`;
    ctx.fill();
  }
}

function drawArms(n) {
  const STEP    = (2 * Math.PI) / ALL_ARMS;
  const ARM_OUT  = W * 0.43;
  const ARM_IN   = W * 0.115;
  const BASE_OUT = ARM_OUT + W * 0.155;
  const ARM_W    = W * 0.14;

  const activeSet = new Set(playerToArm.slice(0, n));

  for (let ai = 0; ai < ALL_ARMS; ai++) {
    const ang = ai * STEP + Math.PI / 2;
    ctx.save();
    ctx.translate(CX, CY);
    ctx.rotate(ang);

    if (activeSet.has(ai)) {
      const color = COLORS[ai];
      const dark  = DARK_C[ai];
      // Gradient across arm width for slight 3-D look
      const grad = ctx.createLinearGradient(-ARM_W / 2, 0, ARM_W / 2, 0);
      grad.addColorStop(0,   dark);
      grad.addColorStop(0.18, color);
      grad.addColorStop(0.82, color);
      grad.addColorStop(1,   dark);
      ctx.beginPath();
      ctx.rect(-ARM_W / 2, ARM_IN, ARM_W, BASE_OUT - ARM_IN);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = '#00000055';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Dividing line between HOME stretch and BASE section
      ctx.beginPath();
      ctx.moveTo(-ARM_W / 2 + 4, ARM_OUT);
      ctx.lineTo( ARM_W / 2 - 4, ARM_OUT);
      ctx.strokeStyle = '#00000033';
      ctx.lineWidth = 1;
      ctx.stroke();

      // Labels
      const fs = Math.max(8, Math.round(W * 0.013));
      ctx.fillStyle = '#00000066';
      ctx.font = `bold ${fs}px Arial, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillText('HOME', 0, ARM_IN  + W * 0.04);
      ctx.fillText('BASE', 0, BASE_OUT - W * 0.02);
    } else {
      // Inactive arm: subtle dark recess
      ctx.beginPath();
      ctx.rect(-ARM_W / 2, ARM_IN, ARM_W, BASE_OUT - ARM_IN);
      ctx.fillStyle = 'rgba(8,32,80,0.38)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(20,70,160,0.25)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }
}

function drawTrack(n) {
  const R = W * 0.012;
  const activeSet = new Set(playerToArm.slice(0, n));

  for (let i = 1; i <= TRACK_SIZE; i++) {
    const p  = trackPos[i];
    if (!p) continue;
    const ai = Math.floor((i - 1) / 14);

    if (STAR_SPACES.has(i)) {
      drawStar8(p.x, p.y, R * 1.9, STAR_GOLD);
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
      ctx.fillStyle = activeSet.has(ai) ? '#0d1a6095' : '#0d1a6050';
      ctx.fill();
      ctx.strokeStyle = activeSet.has(ai) ? '#ffffff45' : '#ffffff22';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

function drawHomeAndBase(n) {
  const R = W * 0.013;
  const activeSet = new Set(playerToArm.slice(0, n));

  for (let ai = 0; ai < ALL_ARMS; ai++) {
    if (!activeSet.has(ai)) continue;
    const color = COLORS[ai];

    for (let s = 1; s <= HOME_SLOTS; s++) {
      const p = homePos[ai][s];
      ctx.beginPath();
      ctx.arc(p.x, p.y, R * 1.15, 0, Math.PI * 2);
      ctx.fillStyle = '#00000055';
      ctx.fill();
      ctx.strokeStyle = color + 'cc';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    for (let mi = 0; mi < MARBLES_PER_PLAYER; mi++) {
      const p = basePos[ai][mi];
      ctx.beginPath();
      ctx.arc(p.x, p.y, R * 1.35, 0, Math.PI * 2);
      ctx.fillStyle = '#00000060';
      ctx.fill();
      ctx.strokeStyle = color + 'bb';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

function drawCenter() {
  const outerR = W * 0.065;
  const innerR = W * 0.023;

  ctx.save();
  ctx.translate(CX, CY);

  // 6 ellipse petals forming a pinwheel
  for (let i = 0; i < 6; i++) {
    ctx.save();
    ctx.rotate(i * Math.PI / 3 + Math.PI / 12);  // slight twist
    ctx.beginPath();
    ctx.ellipse(0, outerR * 0.52, outerR * 0.28, outerR * 0.56, 0, 0, Math.PI * 2);
    ctx.fillStyle = CENTER_PINK;
    ctx.fill();
    ctx.strokeStyle = '#ad004066';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  // Yellow center circle
  ctx.beginPath();
  ctx.arc(0, 0, innerR, 0, Math.PI * 2);
  ctx.fillStyle = STAR_GOLD;
  ctx.fill();
  ctx.strokeStyle = '#c8a000';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.restore();
}

function drawMarbles(gameState) {
  const R = W * 0.022;
  for (const player of gameState.players) {
    const ai    = playerToArm[player.index] ?? player.index;
    const color = COLORS[ai];
    for (const marble of player.marbles) {
      const pos = marblePosition(marble, player.index);
      if (!pos) continue;
      // Shadow
      ctx.beginPath();
      ctx.arc(pos.x + 2, pos.y + 2, R, 0, Math.PI * 2);
      ctx.fillStyle = '#0006';
      ctx.fill();
      // Sphere
      const grad = ctx.createRadialGradient(
        pos.x - R * 0.3, pos.y - R * 0.3, R * 0.05,
        pos.x, pos.y, R
      );
      grad.addColorStop(0, lighten(color));
      grad.addColorStop(1, color);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, R, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
      ctx.strokeStyle = '#fff5';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }
}

function marblePosition(marble, playerIndex) {
  const ai = playerToArm[playerIndex] ?? playerIndex;
  if (marble.zone === 'base')   return basePos[ai]?.[marble.id];
  if (marble.zone === 'track')  return trackPos[marble.space];
  if (marble.zone === 'home')   return homePos[ai]?.[marble.slot];
  if (marble.zone === 'center') return centerPos;
  return null;
}

// 8-pointed starburst
function drawStar8(cx, cy, R, color) {
  const r = R * 0.4;
  ctx.beginPath();
  for (let i = 0; i < 16; i++) {
    const ang = (i * Math.PI) / 8 - Math.PI / 2;
    const rad = i % 2 === 0 ? R : r;
    const x = cx + Math.cos(ang) * rad;
    const y = cy + Math.sin(ang) * rad;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#ff8f00';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function lighten(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const m = (a, t) => Math.round(a + (255 - a) * t);
  return `rgb(${m(r, 0.5)},${m(g, 0.5)},${m(b, 0.5)})`;
}

// ---------- Hit testing & highlights -----------------------------------------

export function hitTestMarble(gameState, cx, cy) {
  if (!gameState) return null;
  const R = W * 0.026;
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
    let pos = null;
    if (sp.zone === 'track') pos = trackPos[sp.space];
    if (sp.zone === 'home')  { const ai = playerToArm[sp.playerIndex] ?? sp.playerIndex; pos = homePos[ai]?.[sp.slot]; }
    if (sp.zone === 'center') pos = centerPos;
    if (!pos) continue;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, R * 1.6, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff44';
    ctx.fill();
    ctx.strokeStyle = '#ffffffaa';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

export function getColors() { return COLORS; }

// Returns the canvas {x,y} for a space descriptor, or null.
// space: { zone: 'track', space: N } | { zone: 'home', playerIndex, slot } | { zone: 'center' }
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
