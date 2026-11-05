// test/cli.mjs — unit tests for cli.mjs pure functions
// Tests: buildSpaceGrid geometry, describeMove formatter
// No server required.

import { buildSpaceGrid, describeMove } from '../cli.mjs';
import { PLAYER_CONFIG, ALL_STARS } from '../public/js/constants.js';

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
    passed++;
  } else {
    console.error(`  ✗ ${msg}`);
    failed++;
  }
}

function describe(name, fn) {
  console.log(name);
  fn();
}

// ---- buildSpaceGrid ---------------------------------------------------------

describe('buildSpaceGrid — key counts', () => {
  const grid = buildSpaceGrid();

  // 84 track spaces
  const trackKeys = [...grid.keys()].filter(k => k.startsWith('t:'));
  assert(trackKeys.length === 84, '84 track space keys');

  // 6 arms × 4 home slots = 24
  const homeKeys = [...grid.keys()].filter(k => k.startsWith('h:'));
  assert(homeKeys.length === 24, '24 home slot keys');

  // 6 arms × 4 base slots = 24
  const baseKeys = [...grid.keys()].filter(k => k.startsWith('b:'));
  assert(baseKeys.length === 24, '24 base slot keys');

  // 1 center hub
  assert(grid.has('c'), 'center hub key present');

  assert(grid.size === 84 + 24 + 24 + 1, 'total key count = 133');
});

describe('buildSpaceGrid — all values have row and col numbers', () => {
  const grid = buildSpaceGrid();
  let allValid = true;
  for (const [key, val] of grid) {
    if (typeof val.row !== 'number' || typeof val.col !== 'number') {
      console.error(`  bad value at key=${key}:`, val);
      allValid = false;
    }
  }
  assert(allValid, 'every entry has numeric row and col');
});

describe('buildSpaceGrid — all (row,col) within grid bounds', () => {
  const GRID_ROWS = 42, GRID_COLS = 140;
  const grid = buildSpaceGrid();
  let allInBounds = true;
  for (const [key, { row, col }] of grid) {
    if (row < 0 || row >= GRID_ROWS || col < 0 || col >= GRID_COLS) {
      console.error(`  out-of-bounds: key=${key} row=${row} col=${col}`);
      allInBounds = false;
    }
  }
  assert(allInBounds, 'all (row,col) within GRID_ROWS×GRID_COLS');
});

describe('buildSpaceGrid — no duplicate (row,col) positions', () => {
  const grid = buildSpaceGrid();
  const seen = new Map();
  let collisions = 0;
  for (const [key, { row, col }] of grid) {
    const pos = `${row},${col}`;
    if (seen.has(pos)) {
      console.error(`  collision: ${key} vs ${seen.get(pos)} at (${row},${col})`);
      collisions++;
    } else {
      seen.set(pos, key);
    }
  }
  assert(collisions === 0, `0 position collisions (got ${collisions})`);
});

describe('buildSpaceGrid — star spaces at expected keys', () => {
  const grid = buildSpaceGrid();
  for (const star of ALL_STARS) {
    assert(grid.has('t:' + star), `star space t:${star} present`);
  }
});

describe('buildSpaceGrid — center hub is near grid center', () => {
  const GRID_ROWS = 42, GRID_COLS = 140;
  const grid = buildSpaceGrid();
  const { row, col } = grid.get('c');
  // Center should be within ±6 rows and ±15 cols of grid center
  const rowOk = Math.abs(row - GRID_ROWS / 2) <= 6;
  const colOk = Math.abs(col - GRID_COLS / 2) <= 15;
  assert(rowOk && colOk, `center hub near grid center (row=${row}, col=${col})`);
});

// ---- describeMove -----------------------------------------------------------

describe('describeMove — exitBase', () => {
  const m = describeMove({ type: 'exitBase', marbleId: 0, dieIndex: 0, toSpace: 1 }, [1, 3]);
  assert(m.includes('Exit base'), 'exitBase contains "Exit base"');
  assert(m.includes('Exit base → B↑0 (start)'), 'exitBase names the start square (B↑0)');
  assert(m.includes('[die 1=1]'), 'exitBase includes die tag');
});

describe('describeMove — move to track (non-star)', () => {
  const m = describeMove({ type: 'move', marbleId: 0, dieIndex: 1, toZone: 'track', toSpace: 5 }, [3, 4]);
  assert(m.includes('Move → B↑4'), 'move to track names the square (space 5 = B↑4)');
  assert(!m.includes('★'), 'non-star square has no star mark');
  assert(m.includes('[die 2=4]'), 'move includes die tag for dieIndex=1');
});

describe('describeMove — move to track (star space)', () => {
  const starSpace = [...ALL_STARS][0]; // e.g. 8
  const m = describeMove({ type: 'move', marbleId: 0, dieIndex: 0, toZone: 'track', toSpace: starSpace }, [6, 2]);
  assert(m.includes('Move → B★'), `move to star names it with ★ (space ${starSpace} = B★)`);
});

describe('describeMove — move to home', () => {
  const m = describeMove({ type: 'move', marbleId: 1, dieIndex: 0, toZone: 'home', toSlot: 2 }, [3, 5]);
  assert(m.includes('Move → home slot 2'), 'move-to-home shows slot number');
});

describe('describeMove — moveHome', () => {
  const m = describeMove({ type: 'moveHome', marbleId: 2, dieIndex: 1, toSlot: 4 }, [2, 3]);
  assert(m.includes('Advance in home → slot 4'), 'moveHome shows target slot');
  assert(m.includes('[die 2=3]'), 'moveHome includes die tag');
});

describe('describeMove — enterCenter with starsPath', () => {
  const m = describeMove({ type: 'enterCenter', marbleId: 0, dieIndex: 0, starsPath: [8, 22] }, [1, 4]);
  assert(m.includes('Star track (B★→P★) → center hub'), 'enterCenter with path names the stars');
});

describe('describeMove — enterCenter without starsPath', () => {
  const m = describeMove({ type: 'enterCenter', marbleId: 0, dieIndex: 0, starsPath: [] }, [1, 4]);
  assert(m.includes('Enter center hub'), 'enterCenter without path shows fallback text');
});

describe('describeMove — exitCenter', () => {
  const starSpace = [...ALL_STARS][2]; // e.g. 36
  const m = describeMove({ type: 'exitCenter', marbleId: 0, dieIndex: 0, toSpace: starSpace }, [1, 3]);
  assert(m.includes('Exit hub → O★'), `exitCenter names the star (space ${starSpace} = O★)`);
});

describe('describeMove — moveStar to track', () => {
  const m = describeMove(
    { type: 'moveStar', marbleId: 0, dieIndex: 0, starsPath: [8, 22], toZone: 'track', toSpace: 25 },
    [3, 5],
  );
  assert(m.includes('Star track'), 'moveStar to track includes "Star track"');
  assert(m.includes('B★→P★'), 'moveStar shows the stars path by name');
  assert(m.includes('→ O↓3'), 'moveStar names the target square (space 25 = O↓3)');
});

describe('describeMove — moveStar to home', () => {
  const m = describeMove(
    { type: 'moveStar', marbleId: 0, dieIndex: 0, starsPath: [8, 22, 36], toZone: 'home', toSlot: 1 },
    [3, 5],
  );
  assert(m.includes('home slot 1'), 'moveStar to home shows slot');
  assert(m.includes('B★→P★→O★'), 'moveStar to home shows the full path by name');
});

describe('describeMove — no dice argument (uses "?")', () => {
  const m = describeMove({ type: 'exitBase', marbleId: 0, dieIndex: 0, toSpace: 1 });
  assert(m.includes('[die 1=?]'), 'missing dice → dieVal is "?"');
});

// ---- Summary ----------------------------------------------------------------

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
