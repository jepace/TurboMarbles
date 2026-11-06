// analysisWorker.js — runs post-game rollout analysis off the main thread so
// the server keeps serving games while it works (seconds per decision).
//
// workerData: { decisions: [{ idx, before, after, pi }], options }
// Posts { type: 'item', idx, item } as each decision finishes (item is the
// analyzeDecision() result), then { type: 'end' }.
import { parentPort, workerData } from 'worker_threads';
import { analyzeDecision } from './Analysis.js';

const { decisions, options } = workerData;
for (const d of decisions) {
  // Each depth uses fresh dice streams (seed depends on the level), so a deeper
  // answer is independent of the quick one.
  const item = analyzeDecision(d, { ...options, seed: 1 + d.idx * 104729 + (options.level ?? 0) * 7_777_777 });
  parentPort.postMessage({ type: 'item', idx: d.idx, item: { ...item, level: options.level ?? 0 } });
}
parentPort.postMessage({ type: 'end' });
