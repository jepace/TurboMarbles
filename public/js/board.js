// board.js — TurboMarbles board renderer
// Layout: 6 arms arranged at 60° intervals. Each arm is a U-shape:
//   Left column:  spaces 1-5  (outer→inner along arm axis, offset -COL_OFF perpendicular)
//   Star:         space 6     (apex, on arm axis at R_STAR)
//   Right column: spaces 7-11 (inner→outer along arm axis, offset +COL_OFF perpendicular)
//   Connectors:   spaces 12-14 (arc connecting to next arm's space 1)
// Total: 14 spaces × 6 arms = 84 track spaces

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

// Space 6 of each arm (arm*14 + 6): innermost space of each arm's U
const STAR_SPACES = new Set([6, 20, 34, 48, 62, 76]);

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

function armAngle(ai) { return ai * STEP + Math.PI / 2; }

function computeLayout() {
  // Radial constants
  const R_OUTER    = W * 0.40;   // outer radius — where spaces 1 and 11 sit
  const R_COL_TOP  = W * 0.22;   // inner top of left/right columns (spaces 5 and 7)
  const R_STAR     = W * 0.17;   // star space (space 6) — apex of the U
  const COL_OFF    = W * 0.052;  // perpendicular distance from arm axis to column centre
  const R_HOME_OUT = W * 0.36;   // outermost home slot (slot 1)
  const R_HOME_IN  = W * 0.24;   // innermost home slot (slot 4)
  const BASE_R     = W * 0.455;  // base-grid centre radius (just outside track)
  const BASE_G     = W * 0.038;  // base-grid cell spacing

  GEO = { R_OUTER, R_COL_TOP, R_STAR, COL_OFF, R_HOME_OUT, R_HOME_IN, BASE_R, BASE_G };

  trackPos = new Array(TRACK_SIZE + 1);
  homePos  = [];
  basePos  = [];

  // Pre-compute outer anchor points for each arm (used by connector interpolation)
  const outerLeft  = [];
  const outerRight = [];
  for (let arm = 0; arm < ALL_ARMS; arm++) {
    const ang = armAngle(arm);
    const dx  = Math.cos(ang), dy = Math.sin(ang);
    const px  = -Math.sin(ang), py = Math.cos(ang);
    outerLeft[arm]  = { x: CX + dx * R_OUTER - px * COL_OFF,
                        y: CY + dy * R_OUTER - py * COL_OFF };
    outerRight[arm] = { x: CX + dx * R_OUTER + px * COL_OFF,
                        y: CY + dy * R_OUTER + py * COL_OFF };
  }

  for (let arm = 0; arm < ALL_ARMS; arm++) {
    const ang = armAngle(arm);
    const dx  = Math.cos(ang), dy = Math.sin(ang);
    const px  = -Math.sin(ang), py = Math.cos(ang);
    const base = arm * 14;

    // Left column: spaces 1-5, outer→inner at -COL_OFF
    for (let i = 0; i < 5; i++) {
      const t = i / 4;
      const r = R_OUTER + (R_COL_TOP - R_OUTER) * t;
      trackPos[base + 1 + i] = {
        x: CX + dx * r - px * COL_OFF,
        y: CY + dy * r - py * COL_OFF,
      };
    }

    // Space 6: star — apex on arm axis
    trackPos[base + 6] = { x: CX + dx * R_STAR, y: CY + dy * R_STAR };

    // Right column: spaces 7-11, inner→outer at +COL_OFF
    for (let i = 0; i < 5; i++) {
      const t = i / 4;
      const r = R_COL_TOP + (R_OUTER - R_COL_TOP) * t;
      trackPos[base + 7 + i] = {
        x: CX + dx * r + px * COL_OFF,
        y: CY + dy * r + py * COL_OFF,
      };
    }

    // Connectors: spaces 12-14
    // Interpolate from this arm's outer-right (space 11) to next arm's outer-left (space 1)
    const nextArm = (arm + 1) % ALL_ARMS;
    const p0 = outerRight[arm];
    const p1 = outerLeft[nextArm];
    for (let i = 0; i < 3; i++) {
      const t = (i + 1) / 4;   // t = 0.25, 0.50, 0.75  (space 1 of next arm is t=1.0)
      trackPos[base + 12 + i] = {
        x: p0.x + (p1.x - p0.x) * t,
        y: p0.y + (p1.y - p0.y) * t,
      };
    }

    // Home slots: 4 slots along arm axis from R_HOME_OUT (outer) to R_HOME_IN (inner)
    homePos[arm] = new Array(HOME_SLOTS + 1);
    for (let s = 1; s <= HOME_SLOTS; s++) {
      const t = (s - 1) / (HOME_SLOTS - 1);
      const r = R_HOME_OUT + (R_HOME_IN - R_HOME_OUT) * t;
      homePos[arm][s] = { x: CX + dx * r, y: CY + dy * r };
    }

    // Base: 2×2 grid just outside the track outer radius
    basePos[arm] = [];
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 2; col++) {
        const dr = (row - 0.5) * BASE_G;
        const dp = (col - 0.5) * BASE_G;
        basePos[arm].push({
          x: CX + dx * (BASE_R + dr) + px * dp,
          y: CY + dy * (BASE_R + dr) + py * dp,
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

// Draw all 6 arms — two parallel column strips per arm, plus a home-corridor strip
function drawAllArms(n) {
  const { R_OUTER, R_COL_TOP, R_STAR, COL_OFF, R_HOME_OUT, R_HOME_IN } = GEO;

  // Column strip half-width (perpendicular to arm axis)
  const COL_HW  = COL_OFF * 0.80;
  // Home corridor half-width
  const HOME_HW = COL_OFF * 0.52;

  const activeSet = new Set(playerToArm.slice(0, n));

  for (let ai = 0; ai < ALL_ARMS; ai++) {
    const ang = armAngle(ai);
    const dx  = Math.cos(ang), dy = Math.sin(ang);
    const px  = -Math.sin(ang), py = Math.cos(ang);
    const color   = COLORS[ai];
    const isActive = activeSet.has(ai);
    const colAlpha  = isActive ? 'bb' : '33';
    const homeAlpha = isActive ? '66' : '18';

    // Left column strip: centred at -COL_OFF from arm axis
    fillQuad([
      { x: CX + dx * R_OUTER + px * (-COL_OFF + COL_HW), y: CY + dy * R_OUTER + py * (-COL_OFF + COL_HW) },
      { x: CX + dx * R_OUTER + px * (-COL_OFF - COL_HW), y: CY + dy * R_OUTER + py * (-COL_OFF - COL_HW) },
      { x: CX + dx * R_COL_TOP + px * (-COL_OFF - COL_HW), y: CY + dy * R_COL_TOP + py * (-COL_OFF - COL_HW) },
      { x: CX + dx * R_COL_TOP + px * (-COL_OFF + COL_HW), y: CY + dy * R_COL_TOP + py * (-COL_OFF + COL_HW) },
    ], color + colAlpha, '#00000033');

    // Right column strip: centred at +COL_OFF from arm axis
    fillQuad([
      { x: CX + dx * R_OUTER + px * ( COL_OFF - COL_HW), y: CY + dy * R_OUTER + py * ( COL_OFF - COL_HW) },
      { x: CX + dx * R_OUTER + px * ( COL_OFF + COL_HW), y: CY + dy * R_OUTER + py * ( COL_OFF + COL_HW) },
      { x: CX + dx * R_COL_TOP + px * ( COL_OFF + COL_HW), y: CY + dy * R_COL_TOP + py * ( COL_OFF + COL_HW) },
      { x: CX + dx * R_COL_TOP + px * ( COL_OFF - COL_HW), y: CY + dy * R_COL_TOP + py * ( COL_OFF - COL_HW) },
    ], color + colAlpha, '#00000033');

    // Home corridor strip: centred on arm axis, from home outer to inner
    fillQuad([
      { x: CX + dx * R_HOME_OUT + px * HOME_HW, y: CY + dy * R_HOME_OUT + py * HOME_HW },
      { x: CX + dx * R_HOME_OUT - px * HOME_HW, y: CY + dy * R_HOME_OUT - py * HOME_HW },
      { x: CX + dx * R_HOME_IN  - px * HOME_HW, y: CY + dy * R_HOME_IN  - py * HOME_HW },
      { x: CX + dx * R_HOME_IN  + px * HOME_HW, y: CY + dy * R_HOME_IN  + py * HOME_HW },
    ], color + homeAlpha, null);

    // Star apex triangle connecting top of both columns to the star space
    const lTop = { x: CX + dx * R_COL_TOP - px * COL_OFF, y: CY + dy * R_COL_TOP - py * COL_OFF };
    const rTop = { x: CX + dx * R_COL_TOP + px * COL_OFF, y: CY + dy * R_COL_TOP + py * COL_OFF };
    const star = { x: CX + dx * R_STAR, y: CY + dy * R_STAR };
    ctx.beginPath();
    ctx.moveTo(lTop.x, lTop.y);
    ctx.lineTo(star.x, star.y);
    ctx.lineTo(rTop.x, rTop.y);
    ctx.closePath();
    ctx.fillStyle = color + (isActive ? '88' : '22');
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

function drawTrack(n) {
  const R = W * 0.018;

  for (let i = 1; i <= TRACK_SIZE; i++) {
    const p  = trackPos[i];
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
    const color = COLORS[ai];

    // Home slots
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

    // Base slots
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
      // Drop shadow
      ctx.beginPath();
      ctx.arc(pos.x + 2, pos.y + 2, R, 0, Math.PI * 2);
      ctx.fillStyle = '#0006';
      ctx.fill();
      // Marble with radial gradient
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
