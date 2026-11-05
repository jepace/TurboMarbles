// RobotThinker.js — gives the robot thinking time without ever stalling a game.
//
// One background worker thread runs the rollouts (RobotRollout.js). think()
// always settles within the deadline:
//   - the answer, if the worker replies in time;
//   - null (the robot plays its normal instant move) if it is late, busy with
//     another robot's question, crashed, or couldn't be started.
// A late answer is thrown away. A crashed worker is replaced on the next call.
import { Worker } from 'worker_threads';

let worker = null;
let busy = false;
let nextId = 1;
const waiting = new Map();          // id → resolve

function getWorker() {
  if (worker) return worker;
  try {
    worker = new Worker(new URL('./robotThinkWorker.js', import.meta.url));
  } catch (err) {
    console.error('[robot-think] could not start worker', err);
    return null;
  }
  worker.unref();                   // never keeps the process alive
  worker.on('message', ({ id, result }) => {
    busy = false;
    const resolve = waiting.get(id);
    if (resolve) { waiting.delete(id); resolve(result); }
  });
  const reset = err => {
    if (err) console.error('[robot-think] worker failed', err);
    worker = null; busy = false;
    for (const resolve of waiting.values()) resolve(null);
    waiting.clear();
  };
  worker.on('error', reset);
  worker.on('exit', () => reset());
  return worker;
}

// Ask for the robot's play; resolves to { moves, changed, n } or null, never
// later than deadlineMs. The worker is given a little less time than that.
export function think(game, pi, deadlineMs) {
  return new Promise(resolve => {
    if (busy) { resolve(null); return; }
    const w = getWorker();
    if (!w) { resolve(null); return; }
    const id = nextId++;
    const timer = setTimeout(() => {
      if (waiting.delete(id)) resolve(null);
    }, deadlineMs);
    timer.unref?.();
    waiting.set(id, result => { clearTimeout(timer); resolve(result); });
    busy = true;
    try {
      w.postMessage({ id, game, pi, budgetMs: Math.max(50, deadlineMs - 250), seed: 1 + Math.floor(Math.random() * 1e9) });
    } catch (err) {
      console.error('[robot-think] post failed', err);
      busy = false; waiting.delete(id); clearTimeout(timer); resolve(null);
    }
  });
}

// For tests: stop the worker.
export async function _stop() {
  const w = worker; worker = null; busy = false;
  if (w) await w.terminate();
}
