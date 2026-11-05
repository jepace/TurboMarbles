// robotThinkWorker.js — the robot's thinking thread (see RobotThinker.js).
// Message in:  { id, game, pi, budgetMs, seed }
// Message out: { id, result } where result is chooseByRollouts()'s answer or null.
import { parentPort } from 'worker_threads';
import { chooseByRollouts } from './RobotRollout.js';

parentPort.on('message', ({ id, game, pi, budgetMs, seed }) => {
  let result = null;
  try { result = chooseByRollouts(game, pi, { budgetMs, seed }); } catch (err) { console.error('[robot-think]', err); }
  parentPort.postMessage({ id, result });
});
