// analysisWorker.js — runs post-game rollout analysis off the main thread so
// the server keeps serving games while it works (seconds per decision).
//
// workerData: { decisions: [{ turn, dice, before, after, pi }], options }
// Posts { type: 'progress', done, total } after each decision, then
// { type: 'result', items } where each item is the decision's turn/dice plus
// the analyzeDecision() result.
import { parentPort, workerData } from 'worker_threads';
import { analyzeDecision } from './Analysis.js';

const { decisions, options } = workerData;
const items = [];
decisions.forEach((d, i) => {
  items.push({ turn: d.turn, dice: d.dice, ...analyzeDecision(d, options) });
  parentPort.postMessage({ type: 'progress', done: i + 1, total: decisions.length });
});
parentPort.postMessage({ type: 'result', items });
