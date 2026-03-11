// board.js — TurboMarbles board renderer

const TRACK_SIZE = 84;
const ALL_ARMS   = 6;
const MARBLES_PER_PLAYER = 4;
const HOME_SLOTS = 4;

// Hex colors indexed by arm index 0–5 (matches PLAYER_CONFIG order)
const COLORS = ['#f5d000','#ff7800','#e8208c','#e0e0e0','#44bb44','#2288f0'];
const DARK_C  = ['#b09800','#c05000','#a01060','#909090','#228822','#1155cc'];

// Same ARM_MAP as GameEngine — determines which arm each player occupies
const ARM_MAP = {
  2: [0, 3],
  3: [0, 2, 4],
  4: [0, 1, 3, 4],
  5: [0, 1, 2, 3, 4],
  6: [0, 1, 2, 3, 4, 5],
};

// Star spaces and home entry spaces (from PLAYER_CONFIG)
const STAR_SPACES      = new Set([8, 22, 36, 50, 64, 78]);
// homeEntry[arm] = track space that is the last space before entering home
const HOME_ENTRY_SPACE = [84, 14, 28, 42, 56, 70]; // indexed by arm

const BG_BLUE     = '#1565c0';
const STAR_GOLD   = '#ffd600';
const CENTER_PINK = '#e91e63';
const STEP = (2 * Math.PI) / ALL_ARMS;

let canvas, ctx, W, CX, CY;
let trackPos  = [];
let homePos   = [];   // [armIndex][slot 1..4]
let basePos   = [];   // [armIndex][0..3]
let centerPos = { x: 0, y: 0 };
let bubbles   = [];

// Updated at start of each drawBoard call
let playerToArm = [0, 1, 2, 3, 4, 5];

// Animation overrides: { playerIndex: { marbleId: {x,y} } }
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

// ---------- Animation overrides ------------------------------------------

export function setMarbleOverride(playerIndex, marbleId, pos) {
  if (!marbleOverrides[playerIndex]) marbleOverrides[playerIndex] = {};
  marbleOverrides[playerIndex][marbleId] = pos;
}

export function clearMarbleOverride(playerIndex, marbleId) {
  if (marbleOverrides[playerIndex]) delete marbleOverrides[playerIndex][marbleId];
}

// ---------- Layout -----------------------------------------------------------

function lerp2(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

function armAngle(ai) { return ai * STEP + Math.PI / 2; }

function computeLayout() {
  // U-shaped track: star spaces dip INWARD toward center (at R_IN),
  // while track corners between arms bulge OUTWARD (at R_OUT).
  // This gives the correct Wahoo board geometry where star spaces are near the hub.
  const R_OUT  = W * 0.40;   // outer track corners (between arms)
  const R_IN   = W * 0.27;   // inner star spaces (at arm axes, near hub)
  const ARM_IN = W * 0.095;  // inner end of home corridor (near center hub)
  const BASE_D = W * 0.47;   // radial centre of base area (beyond arm tip)
  const BASE_G = W * 0.050;  // half-spacing of 2×2 base grid

  trackPos = new Array(TRACK_SIZE + 1);
  homePos  = [];
  basePos  = [];

  for (let arm = 0; arm < ALL_ARMS; arm++) {
    const ang  = armAngle(arm);
    const angL = ang - STEP / 2;   // angle of left outer corner
    const angR = ang + STEP / 2;   // angle of right outer corner

    // Three anchor points for this arm's U-shaped track segment
    // PL and PR are the outer corners between arms; PT is the inner star
    const PL = { x: CX + Math.cos(angL) * R_OUT, y: CY + Math.sin(angL) * R_OUT };
    const PT = { x: CX + Math.cos(ang)  * R_IN,  y: CY + Math.sin(ang)  * R_IN  };
    const PR = { x: CX + Math.cos(angR) * R_OUT, y: CY + Math.sin(angR) * R_OUT };

    // Spaces 1-7: outer left corner → inner star (t=j/8 avoids coinciding with corners)
    for (let j = 1; j <= 7; j++) trackPos[arm * 14 + j] = lerp2(PL, PT, j / 8);
    // Space 8: exactly at inner star (the shortcut space)
    trackPos[arm * 14 + 8] = { x: PT.x, y: PT.y };
    // Spaces 9-14: inner star → outer right corner
    for (let j = 9; j <= 14; j++) trackPos[arm * 14 + j] = lerp2(PT, PR, (j - 8) / 7);

    // Home slots: slot 1 near track (outer), slot HOME_SLOTS near hub (inner).
    // Marbles move inward (toward hub) as they advance through home.
    homePos[arm] = new Array(HOME_SLOTS + 1);
    for (let s = 1; s <= HOME_SLOTS; s++) {
      const t = (s - 1) / (HOME_SLOTS - 1); // 0 at s=1 (outer), 1 at s=HOME_SLOTS (inner)
      const d = (R_IN * 0.85) * (1 - t) + (ARM_IN * 1.35) * t;
      homePos[arm][s] = { x: CX + Math.cos(ang) * d, y: CY + Math.sin(ang) * d };
    }

    // Base: 2×2 grid centred beyond arm tip along arm axis
    const dx = Math.cos(ang), dy = Math.sin(ang);
    const px = -Math.sin(ang), py = Math.cos(ang);
    basePos[arm] = [];
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 2; col++) {
        const dr = (row - 0.5) * BASE_G;
        const dp = (col - 0.5) * BASE_G;
        basePos[arm].push({
          x: CX + dx * (BASE_D + dr) + px * dp,
          y: CY + dy * (BASE_D + dr) + py * dp,
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

// ---------- Draw -------------------------------------------------------------

export function drawBoard(gameState) {
  if (!ctx || !W) return;
  const n = gameState?.players?.length ?? ALL_ARMS;
  playerToArm = ARM_MAP[n] ?? Array.from({ length: n }, (_, i) => i);

  ctx.clearRect(0, 0, W, W);
  drawBackground();
  drawArms(n);
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

// Helper: fill a quadrilateral defined by four {x,y} corners
function fillQuad(pts, fillStyle, strokeStyle, lineWidth = 1.5) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
  if (fillStyle)   { ctx.fillStyle = fillStyle; ctx.fill(); }
  if (strokeStyle) { ctx.strokeStyle = strokeStyle; ctx.lineWidth = lineWidth; ctx.stroke(); }
}

function drawArms(n) {
  const R_IN    = W * 0.27;
  const ARM_IN  = W * 0.095;
  const R_SPLIT = W * 0.32;    // divider between home corridor and base area
  const BASE_END = W * 0.525;  // outer edge of base area
  const HW   = W * 0.063;      // half-width of home corridor
  const BHW  = W * 0.070;      // half-width of base area (slightly wider)

  const activeSet = new Set(playerToArm.slice(0, n));

  for (let ai = 0; ai < ALL_ARMS; ai++) {
    const ang = armAngle(ai);
    const dx  = Math.cos(ang), dy = Math.sin(ang);
    const px  = -Math.sin(ang), py = Math.cos(ang);  // perpendicular (left side)

    // Build a quadrilateral given a radial range [r1,r2] and half-width hw
    const quad = (r1, r2, hw) => [
      { x: CX + dx * r1 + px * hw, y: CY + dy * r1 + py * hw },
      { x: CX + dx * r1 - px * hw, y: CY + dy * r1 - py * hw },
      { x: CX + dx * r2 - px * hw, y: CY + dy * r2 - py * hw },
      { x: CX + dx * r2 + px * hw, y: CY + dy * r2 + py * hw },
    ];

    if (activeSet.has(ai)) {
      const color = COLORS[ai];
      const dark  = DARK_C[ai];

      // Home corridor (inner hub → star area)
      fillQuad(quad(ARM_IN, R_SPLIT, HW), color + 'bb', '#00000044');
      // Base area (beyond home → outer edge)
      fillQuad(quad(R_SPLIT, BASE_END, BHW), dark + 'dd', '#00000044');

      // Divider line between home and base sections
      ctx.beginPath();
      ctx.moveTo(CX + dx * R_SPLIT + px * HW * 1.15, CY + dy * R_SPLIT + py * HW * 1.15);
      ctx.lineTo(CX + dx * R_SPLIT - px * HW * 1.15, CY + dy * R_SPLIT - py * HW * 1.15);
      ctx.strokeStyle = '#ffffff55'; ctx.lineWidth = 1.5; ctx.stroke();

      // Arm labels — drawn horizontally to avoid upside-down text on any arm
      const fs = Math.max(8, Math.round(W * 0.012));
      const homeMidD = (ARM_IN + R_SPLIT) / 2;
      ctx.font = `bold ${fs}px Arial, sans-serif`;
      ctx.fillStyle = '#00000066'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('HOME', CX + dx * homeMidD, CY + dy * homeMidD);

      const baseMidD = (R_SPLIT + BASE_END) / 2;
      ctx.fillStyle = '#ffffff55';
      ctx.fillText('BASE', CX + dx * baseMidD, CY + dy * baseMidD);
    } else {
      // Inactive arm: dark recessed rectangle
      fillQuad(quad(ARM_IN, BASE_END, HW), 'rgba(8,32,80,0.40)', 'rgba(20,70,160,0.20)', 1);
    }
  }
}

// Thin rail line tracing all 84 spaces in order — shows the star shape clearly
function drawTrackRail() {
  ctx.beginPath();
  for (let i = 1; i <= TRACK_SIZE; i++) {
    const p = trackPos[i];
    if (!p) continue;
    i === 1 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y);
  }
  ctx.closePath();
  ctx.strokeStyle = 'rgba(255,255,255,0.18)';
  ctx.lineWidth   = W * 0.022;
  ctx.lineJoin    = 'round';
  ctx.stroke();

  // Inner thinner bright line on top for depth
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth   = W * 0.010;
  ctx.stroke();
}

function drawTrack(n) {
  const R = W * 0.020;  // slightly larger circles so marbles fit
  const activeSet = new Set(playerToArm.slice(0, n));

  // Build set of active homeEntry spaces for highlighting
  const homeEntryByArm = new Map(); // arm → homeEntry space
  for (let ai = 0; ai < ALL_ARMS; ai++) {
    if (activeSet.has(ai)) homeEntryByArm.set(ai, HOME_ENTRY_SPACE[ai]);
  }

  for (let i = 1; i <= TRACK_SIZE; i++) {
    const p  = trackPos[i];
    if (!p) continue;
    const ai = Math.floor((i - 1) / 14);

    if (STAR_SPACES.has(i)) {
      // Star (shortcut) space: prominent gold circle + small starburst
      ctx.beginPath();
      ctx.arc(p.x, p.y, R * 1.7, 0, Math.PI * 2);
      ctx.fillStyle   = '#7a5000cc';
      ctx.fill();
      ctx.strokeStyle = STAR_GOLD;
      ctx.lineWidth   = 2;
      ctx.stroke();
      drawStar8(p.x, p.y, R * 1.2, STAR_GOLD);
    } else {
      // Check if this is a homeEntry space — color the rim with player color
      const isHomeEntry = [...homeEntryByArm.entries()].find(([hAi, hs]) => hs === i);
      ctx.beginPath();
      ctx.arc(p.x, p.y, R, 0, Math.PI * 2);
      ctx.fillStyle   = activeSet.has(ai) ? '#1a3a8faa' : '#0d1a6055';
      ctx.fill();
      if (isHomeEntry) {
        // Mark homeEntry with player color arrow/ring so it's clearly the home entrance
        ctx.strokeStyle = COLORS[isHomeEntry[0]] + 'ee';
        ctx.lineWidth   = 2.5;
      } else {
        ctx.strokeStyle = activeSet.has(ai) ? '#ffffffaa' : '#ffffff33';
        ctx.lineWidth   = 1;
      }
      ctx.stroke();
    }
  }
}

function drawHomeAndBase(n) {
  const R = W * 0.020;
  const activeSet = new Set(playerToArm.slice(0, n));

  for (let ai = 0; ai < ALL_ARMS; ai++) {
    if (!activeSet.has(ai)) continue;
    const color = COLORS[ai];

    // Home slots
    for (let s = 1; s <= HOME_SLOTS; s++) {
      const p = homePos[ai][s];
      ctx.beginPath();
      ctx.arc(p.x, p.y, R * 1.25, 0, Math.PI * 2);
      ctx.fillStyle   = '#00000055';
      ctx.fill();
      ctx.strokeStyle = color + 'dd';
      ctx.lineWidth   = 2;
      ctx.stroke();
    }

    // Base slots
    for (let mi = 0; mi < MARBLES_PER_PLAYER; mi++) {
      const p = basePos[ai][mi];
      ctx.beginPath();
      ctx.arc(p.x, p.y, R * 1.55, 0, Math.PI * 2);
      ctx.fillStyle   = '#00000055';
      ctx.fill();
      ctx.strokeStyle = color + 'aa';
      ctx.lineWidth   = 1.5;
      ctx.stroke();
    }
  }
}

function drawCenter() {
  const outerR = W * 0.072;
  const innerR = W * 0.028;

  // Dark background circle
  ctx.beginPath();
  ctx.arc(CX, CY, outerR, 0, Math.PI * 2);
  ctx.fillStyle   = '#0a1040';
  ctx.fill();
  ctx.strokeStyle = '#4060cc';
  ctx.lineWidth   = 2;
  ctx.stroke();

  ctx.save();
  ctx.translate(CX, CY);

  // 6 petal pinwheel
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

  // Gold hub circle (no label — removed "HUB" text per user request)
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
  const R = W * 0.018;  // slightly smaller to fit inside track circles
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
      // Radial gradient for sphere look
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
  // Check animation override first
  const override = marbleOverrides[playerIndex]?.[marble.id];
  if (override) return override;
  if (marble.zone === 'base')   return basePos[ai]?.[marble.id];
  if (marble.zone === 'track')  return trackPos[marble.space];
  if (marble.zone === 'home')   return homePos[ai]?.[marble.slot];
  if (marble.zone === 'center') return centerPos;
  return null;
}

// 8-pointed starburst drawn on top of a space circle
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

// Highlight legal destination spaces — recolor the space instead of a white ring overlay
export function highlightSpaces(spaces) {
  const R = W * 0.020;
  for (const sp of spaces) {
    const pos = getSpacePosition(sp);
    if (!pos) continue;
    // Fill the space with a bright green highlight color
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, R * 1.3, 0, Math.PI * 2);
    ctx.fillStyle   = '#00e67655';
    ctx.fill();
    ctx.strokeStyle = '#00e676cc';
    ctx.lineWidth   = 2.5;
    ctx.stroke();
  }
}

// Highlight the currently selected marble with a dashed ring
export function highlightMarbleAt(marble, playerIndex) {
  if (!marble) return;
  const pos = marblePosition(marble, playerIndex);
  if (!pos) return;
  const R = W * 0.026;
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

// Returns canvas {x,y} for a space descriptor, or null
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
