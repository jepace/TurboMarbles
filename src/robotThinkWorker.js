// robotThinkWorker.js — the robot's thinking thread (see RobotThinker.js).
// Message in:  { id, kind: 'move' | 'cube', game, pi, budgetMs, seed }
// Message out: { id, result }
//   move: chooseByRollouts()'s answer or null
//   cube: rolloutEstimate()'s chances for player pi from the turn's start
import { parentPort } from 'worker_threads';
import { chooseByRollouts } from './RobotRollout.js';
import { rolloutEstimate } from './CubeDecision.js';

parentPort.on('message', ({ id, kind = 'move', game, pi, budgetMs, seed }) => {
  let result = null;
  try {
    result = kind === 'cube' ? rolloutEstimate(game, pi, { budgetMs }) : chooseByRollouts(game, pi, { budgetMs, seed });
  } catch (err) { console.error('[robot-think]', err); }
  parentPort.postMessage({ id, result });
});
