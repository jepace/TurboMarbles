// tools/train-evaluator.mjs — fit the position evaluator (src/Evaluator.js).
//
//   node tools/train-evaluator.mjs gen <out.jsonl> <games> <players>   # self-play positions
//   node tools/train-evaluator.mjs fit <in.jsonl> [more.jsonl …]        # → src/evaluator-weights.json
//
// gen: robot self-play; at the start of every turn, records each player's
// features (Evaluator.playerFeatures), who is to move, and the eventual winner.
// fit: softmax regression (maximum likelihood of the actual winner) by
// gradient descent; prints held-out log-loss and accuracy against a
// race-only model, and writes the weights.
import { createWriteStream, readFileSync, writeFileSync } from 'fs';
import { createGame, applyMove, rollDice, earnsExtraRoll } from '../src/GameEngine.js';
import { pickNextRobotMove } from '../src/RobotPlayer.js';
import { playerFeatures, FEATURES, softmax } from '../src/Evaluator.js';

const [cmd, ...args] = process.argv.slice(2);

if (cmd === 'gen') {
  const [out, gamesS, playersS] = args;
  const games = +gamesS, P = +playersS;
  const ws = createWriteStream(out);
  for (let n = 0; n < games; n++) {
    const g = createGame(Array.from({ length: P }, (_, i) => ({ name: 'p' + i, color: 'c' + i })), undefined, n % P);
    const rows = [];
    let turn = g.turnIndex, t = 0;
    while (g.winner == null && t++ < 3000) {
      // Sample positions (every turn start, thinned to keep files small).
      if (Math.random() < 0.5) rows.push({ m: turn, f: g.players.map((_, i) => playerFeatures(g, i, turn)) });
      let again = true;
      while (again && g.winner == null) {
        g.turnIndex = turn; g.dice = rollDice(); g.diceUsed = [false, false]; g.phase = 'AWAITING_MOVE';
        while (!(g.diceUsed[0] && g.diceUsed[1]) && g.winner == null) {
          const mv = pickNextRobotMove(g, turn);
          if (mv) applyMove(g, turn, mv); else g.diceUsed[g.diceUsed[0] ? 1 : 0] = true;
        }
        again = earnsExtraRoll(g.dice);
      }
      turn = (turn + 1) % P;
    }
    for (const r of rows) ws.write(JSON.stringify({ ...r, w: g.winner }) + '\n');
    if ((n + 1) % 100 === 0) console.error(`${n + 1} games`);
  }
  ws.end();
} else if (cmd === 'fit') {
  const data = args.flatMap(f => readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l)));
  // Hold out every 5th game-ish row block for testing (rows are grouped by game).
  const test = data.filter((_, i) => i % 5 === 0), train = data.filter((_, i) => i % 5 !== 0);
  const K = FEATURES.length;
  const lossOf = (w, rows, mask) => {
    let L = 0, acc = 0;
    for (const r of rows) {
      const p = softmax(r.f.map(f => f.reduce((s, x, k) => s + (mask ? mask[k] : 1) * x * w[k], 0)));
      L -= Math.log(Math.max(p[r.w], 1e-12));
      if (p.indexOf(Math.max(...p)) === r.w) acc++;
    }
    return { loss: L / rows.length, acc: acc / rows.length };
  };
  const fit = (mask) => {
    const w = new Array(K).fill(0), m = new Array(K).fill(0), v = new Array(K).fill(0);
    const lr = 0.05, b1 = 0.9, b2 = 0.999;
    for (let it = 1; it <= 400; it++) {
      const grad = new Array(K).fill(0);
      for (const r of train) {
        const p = softmax(r.f.map(f => f.reduce((s, x, k) => s + mask[k] * x * w[k], 0)));
        r.f.forEach((f, i) => { const d = p[i] - (i === r.w ? 1 : 0); for (let k = 0; k < K; k++) grad[k] += mask[k] * d * f[k]; });
      }
      for (let k = 0; k < K; k++) {
        const gk = grad[k] / train.length;
        m[k] = b1 * m[k] + (1 - b1) * gk; v[k] = b2 * v[k] + (1 - b2) * gk * gk;
        w[k] -= lr * (m[k] / (1 - b1 ** it)) / (Math.sqrt(v[k] / (1 - b2 ** it)) + 1e-8);
      }
    }
    return w;
  };
  const raceMask = FEATURES.map(f => (f === 'race' || f === 'toMove' ? 1 : 0));
  const wRace = fit(raceMask), wAll = fit(FEATURES.map(() => 1));
  // Separate weights per number of players (when there is data for it): kept
  // only where they beat the shared weights on that table size's test rows.
  const byPlayers = {};
  for (const n of [...new Set(data.map(r => r.f.length))].sort()) {
    const tr = train.filter(r => r.f.length === n), te = test.filter(r => r.f.length === n);
    if (tr.length < 2000) continue;
    const saveTrain = train.splice(0, train.length, ...tr);
    const wN = fit(FEATURES.map(() => 1));
    train.splice(0, train.length, ...saveTrain);
    const own = lossOf(wN, te).loss, shared = lossOf(wAll, te).loss;
    console.log(`${n} players: ${te.length} test rows, log-loss shared ${shared.toFixed(4)} → own ${own.toFixed(4)}`);
    if (own < shared - 0.0005) byPlayers[n] = wN.map(x => +x.toFixed(6));
  }
  const base = { loss: Math.log(data[0].f.length), acc: 1 / data[0].f.length };
  console.log(`${data.length} positions (${train.length} train / ${test.length} test)`);
  console.log(`no information:     log-loss ${base.loss.toFixed(4)}`);
  console.log(`race + to-move:     log-loss ${lossOf(wRace, test, raceMask).loss.toFixed(4)}  accuracy ${(100 * lossOf(wRace, test, raceMask).acc).toFixed(1)}%`);
  const all = lossOf(wAll, test);
  console.log(`all features:       log-loss ${all.loss.toFixed(4)}  accuracy ${(100 * all.acc).toFixed(1)}%`);
  console.log('weights', Object.fromEntries(FEATURES.map((f, k) => [f, +wAll[k].toFixed(4)])));
  writeFileSync(new URL('../src/evaluator-weights.json', import.meta.url),
    JSON.stringify({ note: 'see tools/train-evaluator.mjs', features: FEATURES, weights: wAll.map(x => +x.toFixed(6)), byPlayers, positions: data.length }, null, 1) + '\n');
  console.log('wrote src/evaluator-weights.json');
} else {
  console.error('usage: train-evaluator.mjs gen <out.jsonl> <games> <players> | fit <in.jsonl>…');
  process.exit(2);
}
