// test/thinker.mjs — the robot's background thinking never stalls a game.
// No server needed.
import { createGame } from '../src/GameEngine.js';
import { think, _stop } from '../src/RobotThinker.js';
import { chooseByRollouts, worthThinking } from '../src/RobotRollout.js';
import { allLegalMoves } from '../src/GameEngine.js';
import { parseSpaceName } from '../public/js/constants.js';

let passed = 0, failed = 0;
const assert = (c, m) => { if (c) { console.log(`  ✓ ${m}`); passed++; } else { console.error(`  ✗ ${m}`); failed++; } };

// A late position: robot (player 1) has two marbles out, with a real choice.
function latePosition() {
  const g = createGame([{ name: 'a', color: 'blue' }, { name: 'b', color: 'yellow' }], undefined, 1);
  const put = (pi, outs) => g.players[pi].marbles.forEach((m, i) => {
    delete m.space; delete m.slot;
    if (i < 4 - outs.length) Object.assign(m, { zone: 'home', slot: 4 - i });
    else Object.assign(m, { zone: 'track', space: parseSpaceName(outs[i - (4 - outs.length)]) });
  });
  put(0, ['O↑4', 'P↓3']);
  put(1, ['G↓2', 'B↑3']);
  g.dice = [5, 3]; g.diceUsed = [false, false]; g.phase = 'AWAITING_MOVE';
  return g;
}

console.log('worthThinking / chooseByRollouts');
{
  const g = latePosition();
  assert(worthThinking(g, 1), 'two marbles left is late enough to think');
  const t0 = Date.now();
  const r = chooseByRollouts(g, 1, { budgetMs: 400, seed: 7 });
  const ms = Date.now() - t0;
  assert(r && Array.isArray(r.moves) && r.moves.length >= 1, `returns a play (${r?.moves?.length} moves, ${r?.n} playouts each, changed=${r?.changed})`);
  assert(ms < 400 + 300, `stays near its budget (${ms} ms for 400)`);
  const legal = allLegalMoves(g, 1)[r.moves[0].dieIndex] ?? [];
  assert(legal.some(m => JSON.stringify(m) === JSON.stringify(r.moves[0])), 'first move of the plan is legal');
}

console.log('think — always settles by the deadline');
{
  const g = latePosition();
  let t0 = Date.now();
  const r1 = await think(g, 1, 800);
  let ms = Date.now() - t0;
  assert(ms <= 800 + 100, `answers within the deadline (${ms} ms for 800, includes worker start)`);
  assert(r1 === null || Array.isArray(r1.moves), 'answer is a plan or null');

  // Busy: two robots asking at once — the second gets null at once.
  t0 = Date.now();
  const pa = think(g, 1, 600), pb = think(g, 1, 600);
  const rb = await pb;
  assert(rb === null && Date.now() - t0 < 50, 'a second question while busy is answered null immediately');
  await pa;

  // A deadline shorter than the worker's work: resolves null on time.
  t0 = Date.now();
  const r3 = await think(g, 1, 60);
  ms = Date.now() - t0;
  assert(ms <= 60 + 50, `tiny deadline still honoured (${ms} ms for 60; result ${r3 === null ? 'null' : 'plan'})`);
  // Let the worker finish its (late) job, then it must be usable again.
  await new Promise(res => setTimeout(res, 300));
  const r4 = await think(g, 1, 800);
  assert(r4 !== undefined, 'worker usable again after a late answer');

  // Worker crash: the next call starts a fresh worker.
  await _stop();
  t0 = Date.now();
  const r5 = await think(g, 1, 800);
  assert(Date.now() - t0 <= 900 && (r5 === null || Array.isArray(r5.moves)), 'recovers after the worker is gone');
  await _stop();
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
