// board.js — canvas rendering for the TurboMarbles board

const TRACK_SIZE = 84;
const PLAYERS = 6;
const MARBLES_PER_PLAYER = 4;
const HOME_SLOTS = 4;

// Color map matching server PLAYER_CONFIG
const COLORS = ['#f0c040','#f07820','#e040c0','#e8e8e8','#40c040','#4080f0'];
const DARK_BG = '#0d1b2a';
const TRACK_COLOR = '#2a3a5a';
const STAR_COLOR = '#f0e040';
const CENTER_COLOR = '#e94560';
const HOME_COLOR_ALPHA = 0.25; // arm fill opacity

let canvas, ctx;
let W, H, CX, CY;

// Pre-computed positions (set in init)
let trackPos = [];    // [1..84] → {x,y}
let homePos  = [];    // [playerIdx][1..4] → {x,y}
let basePos  = [];    // [playerIdx][0..3] → {x,y}
let centerPos = {};   // {x,y}
let starSet  = new Set([8,22,36,50,64,78]);

export function init(canvasEl) {
  canvas = canvasEl;
  ctx = canvas.getContext('2d');
  resize();
  window.addEventListener('resize', resize);
}

export function resize() {
  // Square canvas fitting the available space
  const rect = canvas.parentElement.getBoundingClientRect();
  const size = Math.min(rect.width, rect.height);
  canvas.width  = size;
  canvas.height = size;
  W = H = size;
  CX = W / 2;
  CY = H / 2;
  computeLayout();
}

// ---------- Layout ----------

function computeLayout() {
  const ARM_INNER  = W * 0.12;  // distance from center to inner ring of track
  const ARM_OUTER  = W * 0.46;  // distance from center to outer ring of track
  const ARM_MID    = (ARM_INNER + ARM_OUTER) / 2;
  const ANGLE_STEP = (2 * Math.PI) / PLAYERS;

  trackPos = new Array(TRACK_SIZE + 1); // 1-indexed
  homePos  = Array.from({length: PLAYERS}, () => new Array(HOME_SLOTS + 1));
  basePos  = Array.from({length: PLAYERS}, () => new Array(MARBLES_PER_PLAYER));

  // Each player arm is at angle: i * ANGLE_STEP + PI/2
  // Player 0 points DOWN (bottom of screen)
  for (let pi = 0; pi < PLAYERS; pi++) {
    const armAngle = pi * ANGLE_STEP + Math.PI / 2;
    const perpAngle = armAngle + Math.PI / 2;

    // 14 track spaces per player, 7 on each side of the arm axis
    // Spaces 1..7 for pi=0 are along the outer ring going from arm-left to arm-center
    // Spaces 8..14 go from arm-center to arm-right
    // We lay them out along the outer ring as an arc
    const startSpace = pi * 14 + 1;

    for (let s = 0; s < 14; s++) {
      const spaceIdx = startSpace + s;
      // Angle along the ring: s ranges over the 14 spaces in this player's section
      // The arm center is at armAngle; spaces spread ±(7/84)*2π around it
      const frac = (s - 6.5) / TRACK_SIZE; // -6.5..6.5 / 84
      const angle = armAngle + frac * 2 * Math.PI;
      const x = CX + Math.cos(angle) * ARM_OUTER;
      const y = CY + Math.sin(angle) * ARM_OUTER;
      trackPos[spaceIdx] = { x, y };
    }

    // Home lane: 4 slots along the arm from inner ring toward center
    for (let slot = 1; slot <= HOME_SLOTS; slot++) {
      const dist = ARM_INNER - (slot - 0.5) * ((ARM_INNER - W * 0.04) / HOME_SLOTS);
      homePos[pi][slot] = {
        x: CX + Math.cos(armAngle) * dist,
        y: CY + Math.sin(armAngle) * dist,
      };
    }

    // Base: 4 slots near the tip of the arm, beyond the outer ring
    const BASE_START = ARM_OUTER + W * 0.04;
    const BASE_STEP  = W * 0.04;
    const baseAngles = [-1, 1, -1, 1].map((sign, i) => ({
      dist: BASE_START + Math.floor(i / 2) * BASE_STEP,
      side: sign,
    }));
    for (let mi = 0; mi < MARBLES_PER_PLAYER; mi++) {
      const { dist, side } = baseAngles[mi];
      basePos[pi][mi] = {
        x: CX + Math.cos(armAngle) * dist + Math.cos(perpAngle) * side * W * 0.025,
        y: CY + Math.sin(armAngle) * dist + Math.sin(perpAngle) * side * W * 0.025,
      };
    }
  }

  centerPos = { x: CX, y: CY };
}

// ---------- Draw ----------

export function drawBoard(gameState) {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = DARK_BG;
  ctx.fillRect(0, 0, W, H);

  drawArms(gameState);
  drawTrack();
  drawCenter();
  if (gameState) drawMarbles(gameState);
}

function drawArms(gameState) {
  const ANGLE_STEP = (2 * Math.PI) / PLAYERS;
  const ARM_OUTER = W * 0.46;
  const ARM_WIDTH = W * 0.11;

  for (let pi = 0; pi < PLAYERS; pi++) {
    const armAngle = pi * ANGLE_STEP + Math.PI / 2;
    ctx.save();
    ctx.translate(CX, CY);
    ctx.rotate(armAngle);
    ctx.beginPath();
    ctx.rect(-ARM_WIDTH / 2, W * 0.04, ARM_WIDTH, ARM_OUTER - W * 0.04);
    ctx.fillStyle = COLORS[pi] + '28'; // transparent fill
    ctx.fill();
    ctx.strokeStyle = COLORS[pi] + '60';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }
}

function drawTrack() {
  const R = W * 0.013;

  for (let i = 1; i <= TRACK_SIZE; i++) {
    const p = trackPos[i];
    if (!p) continue;
    const isStar = starSet.has(i);

    if (isStar) {
      // Draw star shape
      drawStar(p.x, p.y, R * 1.6, 5, STAR_COLOR);
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
      ctx.fillStyle = TRACK_COLOR;
      ctx.fill();
      ctx.strokeStyle = '#ffffff18';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  // Home lanes and base holes
  for (let pi = 0; pi < PLAYERS; pi++) {
    for (let slot = 1; slot <= HOME_SLOTS; slot++) {
      const p = homePos[pi][slot];
      ctx.beginPath();
      ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
      ctx.fillStyle = COLORS[pi] + '60';
      ctx.fill();
    }
    for (let mi = 0; mi < MARBLES_PER_PLAYER; mi++) {
      const p = basePos[pi][mi];
      ctx.beginPath();
      ctx.arc(p.x, p.y, R * 1.1, 0, Math.PI * 2);
      ctx.fillStyle = COLORS[pi] + '40';
      ctx.fill();
      ctx.strokeStyle = COLORS[pi] + '80';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }
}

function drawCenter() {
  const R = W * 0.032;
  // Outer glow
  const grad = ctx.createRadialGradient(CX, CY, 0, CX, CY, R * 2.5);
  grad.addColorStop(0, CENTER_COLOR + 'cc');
  grad.addColorStop(1, CENTER_COLOR + '00');
  ctx.beginPath();
  ctx.arc(CX, CY, R * 2.5, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(CX, CY, R, 0, Math.PI * 2);
  ctx.fillStyle = CENTER_COLOR;
  ctx.fill();
}

function drawMarbles(gameState) {
  const R = W * 0.022;

  for (const player of gameState.players) {
    const pi = player.index;
    const color = COLORS[pi];

    for (const marble of player.marbles) {
      const pos = marblePosition(marble, pi);
      if (!pos) continue;

      // Shadow
      ctx.beginPath();
      ctx.arc(pos.x + 2, pos.y + 2, R, 0, Math.PI * 2);
      ctx.fillStyle = '#0006';
      ctx.fill();

      // Body
      const grad = ctx.createRadialGradient(pos.x - R * 0.3, pos.y - R * 0.3, R * 0.1, pos.x, pos.y, R);
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
  if (marble.zone === 'base') {
    // Find which base slot — use marble.id
    return basePos[playerIndex]?.[marble.id];
  }
  if (marble.zone === 'track') {
    return trackPos[marble.space];
  }
  if (marble.zone === 'home') {
    return homePos[playerIndex]?.[marble.slot];
  }
  if (marble.zone === 'center') {
    // Offset slightly so multiple center marbles don't overlap perfectly
    return centerPos;
  }
  return null;
}

function drawStar(cx, cy, outerR, points, color) {
  const innerR = outerR * 0.45;
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const angle = (i * Math.PI) / points - Math.PI / 2;
    const r = i % 2 === 0 ? outerR : innerR;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#fff8';
  ctx.lineWidth = 1;
  ctx.stroke();
}

function lighten(hex) {
  // Crude lighten by mixing with white
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return `rgb(${mix(r,255,0.5)},${mix(g,255,0.5)},${mix(b,255,0.5)})`;
}
function mix(a, b, t) { return Math.round(a + (b - a) * t); }

// ---------- Hit testing ----------
// Returns { playerIndex, marbleId } if a marble was clicked, else null
export function hitTestMarble(gameState, cx, cy) {
  if (!gameState) return null;
  const R = W * 0.026;

  for (const player of gameState.players) {
    for (const marble of player.marbles) {
      const pos = marblePosition(marble, player.index);
      if (!pos) continue;
      const dx = cx - pos.x, dy = cy - pos.y;
      if (dx * dx + dy * dy <= R * R) {
        return { playerIndex: player.index, marbleId: marble.id };
      }
    }
  }
  return null;
}

// Highlight legal destination spaces
export function highlightSpaces(spaces) {
  const R = W * 0.018;
  for (const sp of spaces) {
    let pos = null;
    if (sp.zone === 'track')  pos = trackPos[sp.space];
    if (sp.zone === 'home')   pos = homePos[sp.playerIndex]?.[sp.slot];
    if (sp.zone === 'center') pos = centerPos;
    if (!pos) continue;

    ctx.beginPath();
    ctx.arc(pos.x, pos.y, R * 1.5, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff44';
    ctx.fill();
    ctx.strokeStyle = '#ffffffaa';
    ctx.lineWidth = 2;
    ctx.stroke();
  }
}

export function getColors() { return COLORS; }
