// analysisWorker.js — runs post-game rollout analysis off the main thread so
// the server keeps serving games while it works (seconds per decision).
//
// workerData: { decisions: [{ idx, before, after, pi }], options }
// Posts { type: 'item', idx, item } as each decision finishes (item is the
// analyzeDecision() result), then { type: 'end' }.
import { parentPort, workerData } from 'worker_threads';
import { analyzeDecision } from './Analysis.js';

import { analyzeCube } from './CubeAnalysis.js';
import { evaluate1 } from './Evaluator.js';

const { decisions, options, cube = [], cubeGames = 400, cubeForce = false, cubeLevel = 0 } = workerData;
for (const d of decisions) {
  // Each depth uses fresh dice streams (seed depends on the level), so a deeper
  // answer is independent of the quick one.
  const item = analyzeDecision(d, { ...options, seed: 1 + d.idx * 104729 + (options.level ?? 0) * 7_777_777 });
  parentPort.postMessage({ type: 'item', idx: d.idx, item: { ...item, level: options.level ?? 0 } });
}
// Cube decisions: a no-double nowhere near the doubling window (the 1-ply
// estimate gives the player under 60%) is skipped; the rest are worked out.
for (const { i, entry } of cube) {
  let item;
  try {
    const p = entry.kind === 'double' && !entry.action ? evaluate1(entry.state, entry.pi)?.[entry.pi] : null;
    item = !cubeForce && p != null && p < 0.6 ? { skip: true, p } : { ...analyzeCube(entry, { games: cubeGames }), level: cubeLevel };
  } catch (err) { console.error('[analysis] cube', err); item = { skip: true }; }
  parentPort.postMessage({ type: 'cube', i, item });
}
parentPort.postMessage({ type: 'end' });
