// test/cube.mjs — doubling cube (money play): rules, scoring, robot decisions,
// session score and rematch. No server needed.
import { createGame, canDouble, offerDouble, takeDouble, dropDouble, gameResult, applyMove } from '../src/GameEngine.js';
import {
  createRoom, joinRoom, addRobot, startGame, handleRoll, handleCommit, handleMove, handleAnalyzeGame,
  handleDouble, handleTake, handleDrop, handleRematch,
  _reset, _getRoom, config as gmConfig,
} from '../src/GameManager.js';
import { shouldDouble, shouldTake, cubefulEquity } from '../src/CubeDecision.js';
import { _stop } from '../src/RobotThinker.js';

let passed = 0, failed = 0;
const assert = (c, m) => { if (c) { console.log(`  ✓ ${m}`); passed++; } else { console.error(`  ✗ ${m}`); failed++; } };
const describe = (name, fn) => { console.log(name); return fn(); };
let wsId = 1;
const mockWs = () => ({
  _id: 'c' + wsId++, readyState: 1, sent: [],
  send(d) { this.sent.push(JSON.parse(d)); },
  find(e) { return this.sent.filter(m => m.event === e); },
});
const sleep = ms => new Promise(r => setTimeout(r, ms));

describe('engine — who may double, and when', () => {
  const g = createGame([{ name: 'a', color: 'blue' }, { name: 'b', color: 'yellow' }], undefined, 0, { cube: true });
  assert(g.cube.value === 1 && g.cube.owner === null, 'cube starts centred at 1');
  assert(canDouble(g, 0) && !canDouble(g, 1), 'only the player to move may double, before rolling');
  g.phase = 'EXTRA_ROLL';
  assert(!canDouble(g, 0), 'no double before an extra roll after a 6');
  g.phase = 'IN_TURN'; g.dice = [3, 2];
  assert(!canDouble(g, 0), 'no double after rolling');
  g.dice = null;
  assert(offerDouble(g, 0) && g.phase === 'CUBE_OFFERED' && g.cubeOffer.value === 2, 'double offered at 2');
  assert(!takeDouble(g, 0), 'the doubler cannot take their own double');
  assert(takeDouble(g, 1) && g.cube.value === 2 && g.cube.owner === 1 && g.phase === 'IN_TURN', 'take: cube 2, owned by the taker, doubler rolls');
  assert(!canDouble(g, 0), 'the doubler no longer has the cube');
  g.turnIndex = 1;
  assert(canDouble(g, 1), 'the owner may redouble on their turn');
  offerDouble(g, 1);
  assert(dropDouble(g, 0) && g.winner === 1 && g.result.points === 2 && g.result.dropped, 'drop: doubler wins the cube value before the double (2)');
  const g2 = createGame([{ name: 'a', color: 'blue' }, { name: 'b', color: 'yellow' }], undefined, 0);
  assert(g2.cube === null && !canDouble(g2, 0), 'no cube unless enabled');
  const g3 = createGame([{ name: 'a', color: 'blue' }, { name: 'b', color: 'yellow' }, { name: 'c', color: 'green' }], undefined, 0, { cube: true });
  assert(g3.cube === null, 'no cube with three players');
});

describe('engine — aggro scoring', () => {
  const g = createGame([{ name: 'a', color: 'blue' }, { name: 'b', color: 'yellow' }], undefined, 0, { cube: true });
  g.cube.value = 4;
  assert(gameResult(g, 0).points === 8 && gameResult(g, 0).aggro, 'loser has nobody home: aggro, cube 4 → 8 points');
  Object.assign(g.players[1].marbles[0], { zone: 'home', slot: 4 });
  assert(gameResult(g, 0).points === 4 && !gameResult(g, 0).aggro, 'loser has one home: plain win, 4 points');
  // Winning move sets the result.
  g.players[0].marbles.forEach((m, i) => Object.assign(m, i < 3 ? { zone: 'home', slot: 4 - i } : { zone: 'track', space: 83 }));
  g.dice = [1, 1]; g.diceUsed = [false, false]; g.phase = 'AWAITING_MOVE';
  const ev = applyMove(g, 0, { type: 'move', dieIndex: 0, marbleId: 3, toZone: 'track', toSpace: 84 });
  void ev;
});

describe('cube decisions — money play thresholds', () => {
  const e = p => ({ p, aggroWin: 0, aggroLoss: 0 });
  assert(!shouldDouble(e(0.6), 'centre').double, 'no double at 60%');
  assert(shouldDouble(e(0.75), 'centre').double, 'double at 75%');
  assert(shouldTake(e(0.25)).take, 'take at 25%');
  assert(!shouldTake(e(0.15)).take, 'drop at 15%');
  assert(cubefulEquity(e(0.5), 'me') > cubefulEquity(e(0.5), 'centre') && cubefulEquity(e(0.5), 'centre') > cubefulEquity(e(0.5), 'opp'),
    'owning the cube is worth something');
  assert(shouldTake({ p: 0.2, aggroWin: 0.1, aggroLoss: 0 }).take, 'aggro chances make a thin take good');
});

describe('manager — human double, take, drop; session score; rematch', () => {
  _reset(); gmConfig.initialTurnIndex = 0; gmConfig.robotThinkMs = 0;
  const host = mockWs(), guest = mockWs();
  const { code, roomId, cube } = createRoom(host, 'Alice', 2, undefined, { cube: true });
  assert(cube === true, 'room created with the cube');
  joinRoom(guest, code, 'Bob');
  startGame(host, roomId);
  const room = _getRoom(roomId);
  assert(host.find('gameStarted')[0].gameState.cube?.value === 1, 'game state carries the cube');
  handleDouble(guest, roomId);
  assert(!room.game.cubeOffer, 'not your turn: no double');
  handleDouble(host, roomId);
  assert(guest.find('doubleOffered').length === 1 && room.game.phase === 'CUBE_OFFERED', 'double offered to the guest');
  handleRoll(host, roomId);
  assert(!room.game.dice, 'no rolling while a double is pending');
  handleTake(guest, roomId);
  assert(room.game.cube.value === 2 && room.game.cube.owner === 1 && host.find('doubleTaken').length === 1, 'guest takes: cube 2 on their side');
  handleRoll(host, roomId);
  assert(!!room.game.dice, 'doubler rolls after the take');
  // Fast-forward to the guest's turn and redouble, host drops.
  room.game.dice = null; room.game.diceUsed = [false, false]; room.game.phase = 'IN_TURN'; room.game.turnIndex = 1;
  handleDouble(guest, roomId);
  handleDrop(host, roomId);
  const res = host.find('gameResult')[0];
  assert(res && res.winnerIndex === 1 && res.result.points === 2 && res.score[1] === 2 && res.score[0] === -2, `drop scores 2 for the guest (score ${res?.score})`);
  assert(room.state === 'finished', 'game over');
  handleRematch(guest, roomId);
  assert(room.state === 'finished' && host.find('rematchRequested').some(e => e.playerIndex === 1 && e.waitingFor.join() === '0'),
    'one player asking is only a request: the other is asked');
  handleRematch(guest, roomId);
  assert(room.state === 'finished', 'asking twice does not start it');
  handleRematch(host, roomId);
  assert(room.state === 'playing' && room.game.cube.value === 1 && room.game.winner == null, 'rematch: new game, cube back to 1');
  assert(host.find('gameStarted').pop().gameState.score.join() === '-2,2', 'rematch keeps the money score');
});

await describe('manager — robot answers a double, and doubles when far ahead', async () => {
  _reset(); gmConfig.initialTurnIndex = 0; gmConfig.robotThinkMs = 400;
  const host = mockWs();
  const { roomId } = createRoom(host, 'Alice', 2, undefined, { cube: true });
  addRobot(host, roomId);
  startGame(host, roomId);
  const room = _getRoom(roomId);
  // Make the robot hopeless: Alice nearly home, robot all in base.
  room.game.players[0].marbles.forEach((m, i) => Object.assign(m, i < 3 ? { zone: 'home', slot: 4 - i } : { zone: 'track', space: 83 }));
  handleDouble(host, roomId);
  for (let t = 0; t < 60 && !host.find('doubleDropped').length && !host.find('doubleTaken').length; t++) await sleep(50);
  assert(host.find('doubleDropped').length === 1, 'hopeless robot drops');
  assert(host.find('gameResult')[0]?.score.join() === '1,-1', 'Alice wins 1 point');

  // Robot in its doubling window at the start of its turn (an exact duel
  // position: robot 69% to win, a double and a take) — it doubles.
  handleRematch(host, roomId);
  const g = room.game;
  for (const p of g.players) p.marbles.forEach((m, i) => { if (i < 3) Object.assign(m, { zone: 'home', slot: 4 - i, space: null }); });
  Object.assign(g.players[0].marbles[3], { zone: 'track', space: 60, slot: null });   // G↑3
  Object.assign(g.players[1].marbles[3], { zone: 'track', space: 30, slot: null });   // O↑1
  // Alice ends her turn without moving: the robot's turn starts.
  g.phase = 'AWAITING_MOVE'; g.dice = [3, 2]; g.diceUsed = [true, true]; g._humanMadeMove = true;
  host.sent = [];
  handleCommit(host, roomId);
  for (let t = 0; t < 80 && !host.find('doubleOffered').length; t++) await sleep(50);
  assert(host.find('doubleOffered').some(e => e.playerIndex === 1 && e.value === 2), 'robot in its doubling window doubles before rolling');
  handleTake(host, roomId);
  assert(g.cube.value === 2 && g.cube.owner === 0, 'Alice takes: cube 2 on her side');
  for (let t = 0; t < 80 && !host.find('rolled').length; t++) await sleep(50);
  assert(host.find('rolled').some(e => e.playerIndex === 1), 'after the take the robot rolls (and does not double again)');
  assert(host.find('doubleOffered').length === 1, 'only one double that turn');
  await _stop();
});

describe('manager — two players without the cube still score 1 point a win', () => {
  _reset(); gmConfig.initialTurnIndex = 0; gmConfig.robotThinkMs = 0;
  const host = mockWs(), guest = mockWs();
  const { code, roomId } = createRoom(host, 'Alice', 2);
  joinRoom(guest, code, 'Bob');
  startGame(host, roomId);
  const room = _getRoom(roomId);
  const g = room.game;
  Object.assign(g.players[1].marbles[0], { zone: 'home', slot: 4 });          // Bob has one home: no aggro
  g.players[0].marbles.forEach((m, i) => Object.assign(m, i < 3 ? { zone: 'home', slot: 4 - i } : { zone: 'track', space: 84 }));
  g.dice = [1, 2]; g.diceUsed = [false, true]; g.phase = 'AWAITING_MOVE'; g._humanMadeMove = false; g._undoStack = [];
  handleMove(host, roomId, { type: 'move', dieIndex: 0, marbleId: 3, toZone: 'home', toSlot: 1 });
  const res = host.find('gameResult')[0];
  assert(res?.result?.points === 1 && res.score.join() === '1,-1', `win scores 1 point (score ${res?.score})`);
});

await describe('cube analysis — feedback in the game, decisions in the report', async () => {
  _reset(); gmConfig.initialTurnIndex = 0; gmConfig.robotThinkMs = 400; gmConfig.cubeAnalysisGames = 60;
  gmConfig.analysis = { mode: 'eval', keep: 2 };
  gmConfig.analysisLevels = [gmConfig.analysis, { screenBy: 'eval', deep: 8, keep: 2, maxDeep: 8 }];
  const host = mockWs();
  const { roomId } = createRoom(host, 'Alice', 2, undefined, { cube: true });
  addRobot(host, roomId);
  startGame(host, roomId);
  const room = _getRoom(roomId);
  const g = room.game;
  // Exact duel: Alice (to move) 31% — doubling is a blunder; the robot takes.
  for (const p of g.players) p.marbles.forEach((m, i) => { if (i < 3) Object.assign(m, { zone: 'home', slot: 4 - i, space: null }); });
  Object.assign(g.players[0].marbles[3], { zone: 'track', space: 30, slot: null });
  Object.assign(g.players[1].marbles[3], { zone: 'track', space: 60, slot: null });
  host.sent = [];
  handleDouble(host, roomId);
  for (let t = 0; t < 60 && !host.find('cubeFeedback').length; t++) await sleep(50);
  const fb = host.find('cubeFeedback')[0];
  assert(fb && fb.kind === 'double' && fb.agrees === false && /would not double/.test(fb.text), `feedback on a bad double (${fb?.text})`);
  for (let t = 0; t < 60 && !host.find('doubleTaken').length; t++) await sleep(50);
  // End the game quickly: Alice wins.
  g.players[0].marbles[3] = Object.assign(g.players[0].marbles[3], { zone: 'track', space: 84 });
  g.phase = 'AWAITING_MOVE'; g.dice = [1, 2]; g.diceUsed = [false, true]; g._humanMadeMove = false; g._undoStack = [];
  handleMove(host, roomId, { type: 'move', dieIndex: 0, marbleId: 3, toZone: 'home', toSlot: 1 });
  host.sent = [];
  handleAnalyzeGame(host, roomId);
  for (let t = 0; t < 200 && !host.find('cubeUpdate').length; t++) await sleep(50);
  const rep = host.find('analysisResult')[0]?.report;
  assert(rep?.cube?.some(c => c.kind === 'double' && c.action) && rep.cube.some(c => c.kind === 'take'), 'report lists the double and the take');
  const ups = host.find('cubeUpdate');
  for (let t = 0; t < 200 && ups.length < rep.cube.length; t++) { await sleep(50); ups.splice(0, ups.length, ...host.find('cubeUpdate')); }
  const dbl = ups.find(u => rep.cube[u.i].kind === 'double')?.analysis;
  const tk = ups.find(u => rep.cube[u.i].kind === 'take')?.analysis;
  assert(dbl?.best === 'no double' && dbl.severity === 'blunder' && dbl.exact, `the double is a blunder (exact; loss ${dbl?.loss})`);
  assert(tk?.best === 'take' && tk.severity === 'ok', 'the take was right');
  await _stop();
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
