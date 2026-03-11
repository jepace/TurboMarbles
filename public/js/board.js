// board.js — TurboMarbles board renderer
// Layout: each arm has 6 spaces inward, 1 star, 6 spaces outward, 3 horizontal spaces
// Home corridor between arms, base below horizontal, hub at center

const TRACK_SIZE = 84;
const ALL_ARMS   = 6;
const MARBLES_PER_PLAYER = 4;
const HOME_SLOTS = 4;

const COLORS = ['#f5d000','#ff7800','#e8208c','#e0e0e0','#44bb44','#2288f0'];
const DARK_C  = ['#b09800','#c05000','#a01060','#909090','#228822','#1155cc'];

const ARM_MAP = {
  2: [0, 3],
  3: [0, 2, 4],
  4: [0, 1, 3, 4],
  5: [0, 1, 2, 3, 4],
  6: [0, 1, 2, 3, 4, 5],
};

const STAR_SPACES      = new Set([7, 21, 35, 49, 63, 77]); // innermost space of each arm
const HOME_ENTRY_SPACE = [14, 28, 42, 56, 70, 84]; // last space before home

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

function lerp2(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function armAngle(ai) { return ai * STEP + Math.PI / 2; }

function computeLayout() {
  // Each arm:
  //   Spaces 1-6: moving inward along arm axis toward center
  //   Space 7: star (innermost point)
  //   Spaces 8-13: moving outward along arm axis away from center
  //   Spaces 14: horizontal connector (perpendicular to arm)

  const R_OUT   = W * 0.42;   // outer edge (spaces 1, 14)
  const R_INNER = W * 0.18;   // innermost (star space 7)
  const ARM_IN  = W * 0.08;   // inner end of home corridor

  trackPos = new Array(TRACK_SIZE + 1);
  homePos  = [];
  basePos  = [];

  for (let arm = 0; arm < ALL_ARMS; arm++) {
    const ang  = armAngle(arm);
    const angL = ang - STEP / 2;
    const angR = ang + STEP / 2;
    const dx   = Math.cos(ang);
    const dy   = Math.sin(ang);
    const px   = -Math.sin(ang); // perpendicular
    const py   =  Math.cos(ang);

    const baseSpace = arm * 14;

    // Space 1: outer start
    trackPos[baseSpace + 1] = { x: CX + dx * R_OUT, y: CY + dy * R_OUT };

    // Spaces 2-6: moving inward
    for (let i = 2; i <= 6; i++) {
      const t = (i - 1) / 6;
      const r = R_OUT + (R_INNER - R_OUT) * t;
      trackPos[baseSpace + i] = { x: CX + dx * r, y: CY + dy * r };
    }

    // Space 7: star (innermost)
    trackPos[baseSpace + 7] = { x: CX + dx * R_INNER, y: CY + dy * R_INNER };

    // Spaces 8-13: moving outward
    for (let i = 8; i <= 13; i++) {
      const t = (i - 7) / 6;
      const r = R_INNER + (R_OUT - R_INNER) * t;
      trackPos[baseSpace + i] = { x: CX + dx * r, y: CY + dy * r };
    }

    // Space 14: horizontal connector (perpendicular to arm, at outer radius)
    trackPos[baseSpace + 14] = { x: CX + px * R_OUT * 0.9, y: CY + py * R_OUT * 0.9 };

    // Home slots (along arm axis, between ARM_IN and R_OUT area)
    homePos[arm] = new Array(HOME_SLOTS + 1);
    for (let s = 1; s <= HOME_SLOTS; s++) {
      const t = (s - 1) / (HOME_SLOTS - 1);
      const r = ARM_IN + (R_OUT * 0.35 - ARM_IN) * t;
      homePos[arm][s] = { x: CX + dx * r, y: CY + dy * r };
    }

    // Base: 2×2 grid perpendicular to arm, below horizontal space
    const baseD = R_OUT * 0.55;
    const baseG = W * 0.045;
    basePos[arm] = [];
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 2; col++) {
        const dr = (row - 0.5) * baseG;
        const dp = (col - 0.5) * baseG;
        basePos[arm].push({
          x: CX + dx * baseD + px * dp,
          y: CY + dy * baseD + py * dp,
        });
      }
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
  drawTrack(n);
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

// Draw all 6 arms (even inactive ones in muted colors)
function drawAllArms(n) {
  const R_OUT = W * 0.42;
  const ARM_IN = W * 0.08;
  const HW   = W * 0.055; // half-width of arm

  const activeSet = new Set(playerToArm.slice(0, n));

  for (let ai = 0; ai < ALL_ARMS; ai++) {
    const ang = armAngle(ai);
    const dx  = Math.cos(ang), dy = Math.sin(ang);
    const px  = -Math.sin(ang), py = Math.cos(ang);

    const quad = (r1, r2) => [
      { x: CX + dx * r1 + px * HW, y: CY + dy * r1 + py * HW },
      { x: CX + dx * r1 - px * HW, y: CY + dy * r1 - py * HW },
      { x: CX + dx * r2 - px * HW, y: CY + dy * r2 - py * HW },
      { x: CX + dx * r2 + px * HW, y: CY + dy * r2 + py * HW },
    ];

    // Always use real arm color — active arms are brighter, inactive slightly dimmer
    const color = COLORS[ai];
    const alpha = activeSet.has(ai) ? 'cc' : '55';
    fillQuad(quad(ARM_IN, R_OUT * 0.4), color + alpha, '#00000033');
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
  ctx.lineWidth   = W * 0.018;
  ctx.lineJoin    = 'round';
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth   = W * 0.008;
  ctx.stroke();
}

function drawTrack(n) {
  const R = W * 0.018;
  const activeSet = new Set(playerToArm.slice(0, n));

  for (let i = 1; i <= TRACK_SIZE; i++) {
    const p  = trackPos[i];
    if (!p) continue;
    const ai = Math.floor((i - 1) / 14);

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

  // Draw all 6 arms' home/base (always show full board)
  for (let ai = 0; ai < ALL_ARMS; ai++) {
    const isActive = activeSet.has(ai);
    const color = COLORS[ai];
    const dimColor = 'rgba(120,130,150,0.5)';

    // Home slots — always show in arm color; active=bright, inactive=dim
    for (let s = 1; s <= HOME_SLOTS; s++) {
      const p = homePos[ai][s];
      ctx.beginPath();
      ctx.arc(p.x, p.y, R * 1.2, 0, Math.PI * 2);
      ctx.fillStyle   = '#00000055';
      ctx.fill();
      ctx.strokeStyle = color + (isActive ? 'dd' : '55');
      ctx.lineWidth   = 2;
      ctx.stroke();
    }

    // Base slots
    for (let mi = 0; mi < MARBLES_PER_PLAYER; mi++) {
      const p = basePos[ai][mi];
      ctx.beginPath();
      ctx.arc(p.x, p.y, R * 1.5, 0, Math.PI * 2);
      ctx.fillStyle   = '#00000055';
      ctx.fill();
      ctx.strokeStyle = color + (isActive ? 'aa' : '44');
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
      ctx.beginPath();
      ctx.arc(pos.x + 2, pos.y + 2, R, 0, Math.PI * 2);
      ctx.fillStyle = '#0006';
      ctx.fill();
      const grad = ctx.createRadialGradient(
        pos.x - R * 0.3, pos.y - R * 0.3, R * 0.05,
        pos.x, pos.y, R
      );
      grad.addColorStop(0, lighten(color));
      grad.addColorStop(1, color);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, R, 0, Math.PI * 2);
      ctx.fillStyle   = grad;
      ctx.fill();
      ctx.strokeStyle = '#fff5';
      ctx.lineWidth   = 1;
      ctx.stroke();
    }
  }
}

function marblePosition(marble, playerIndex) {
  const ai = playerToArm[playerIndex] ?? playerIndex;
  const override = marbleOverrides[playerIndex]?.[marble.id];
  if (override) return override;
  if (marble.zone === 'base')   return basePos[ai]?.[marble.id];
  if (marble.zone === 'track')  return trackPos[marble.space];
  if (marble.zone === 'home')   return homePos[ai]?.[marble.slot];
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
