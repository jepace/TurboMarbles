// test/cube.mjs — doubling cube (money play): rules, scoring, robot decisions,
// session score and rematch. No server needed.
import { createGame, canDouble, offerDouble, takeDouble, dropDouble, gameResult, applyMove } from '../src/GameEngine.js';
import {
  createRoom, joinRoom, addRobot, startGame, handleRoll, handleCommit, handleMove, handleAnalyzeGame, handleAnalyzeDeeperCube,
  handleDouble, handleTake, handleDrop, handleRematch, handleQuit,
  _reset, _getRoom, config as gmConfig,
} from '../src/GameManager.js';
import { shouldDouble, shouldTake, cubefulEquity } from '../src/CubeDecision.js';
import { analyzeCube } from '../src/CubeAnalysis.js';
import { matchCube, met } from '../src/MatchEquity.js';
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

describe('engine — dead cube in a match', () => {
  // 3-point match: a is 2-away, b is 3-away.
  const g = createGame([{ name: 'a', color: 'blue' }, { name: 'b', color: 'yellow' }], undefined, 1, { cube: true, away: [2, 3] });
  assert(offerDouble(g, 1) && takeDouble(g, 0) && g.cube.value === 2 && g.cube.owner === 0, 'b doubles, 2-away a takes');
  g.turnIndex = 0; g.phase = 'IN_TURN'; g.dice = null;
  assert(!canDouble(g, 0), 'cube at 2 is dead for the 2-away owner');
  const h = createGame([{ name: 'a', color: 'blue' }, { name: 'b', color: 'yellow' }], undefined, 0, { cube: true, away: [2, 3] });
  assert(canDouble(h, 0), 'a centred cube at 1 is still alive for the 2-away player');
});

describe('engine — aggro scoring', () => {
  const g = createGame([{ name: 'a', color: 'blue' }, { name: 'b', color: 'yellow' }], undefined, 0, { cube: true });
  g.cube.value = 4;
  assert(gameResult(g, 0).points === 12 && gameResult(g, 0).baggro, 'loser has all four in base: baggro, cube 4 → 12 points');
  Object.assign(g.players[1].marbles[1], { zone: 'track', space: 10 });
  assert(gameResult(g, 0).points === 8 && gameResult(g, 0).aggro && !gameResult(g, 0).baggro, 'loser has nobody home, one out: aggro, cube 4 → 8 points');
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

describe('cube analysis — named mistakes', () => {
  const g = createGame([{ name: 'a', color: 'blue' }, { name: 'b', color: 'yellow' }], undefined, 1, { cube: true });
  for (const p of g.players) p.marbles.forEach((m, i) => { if (i < 3) Object.assign(m, { zone: 'home', slot: 4 - i }); });
  const pos = (a, b, turn) => { Object.assign(g.players[0].marbles[3], { zone: 'track', space: a }); Object.assign(g.players[1].marbles[3], { zone: 'track', space: b });
    return structuredClone({ players: g.players, turnIndex: turn, phase: 'IN_TURN', dice: null, diceUsed: [false, false], winner: null, cube: { value: 1, owner: null } }); };
  const far = pos(10, 36, 1);                         // Yellow far ahead, to roll
  const strong = analyzeCube({ kind: 'double', pi: 1, action: false, state: far });
  assert(strong.best === 'double' && strong.label === 'Missed double' && strong.severity !== 'ok', `not doubling when far ahead: "${strong.label}" (${strong.severity}, −${strong.loss})`);
  const weak = pos(30, 60, 0);                        // Blue behind (31%)
  assert(analyzeCube({ kind: 'double', pi: 0, action: true, state: weak }).label === 'Wrong double', 'doubling when behind: "Wrong double"');
  assert(analyzeCube({ kind: 'take', pi: 1, action: false, doubler: 0, state: weak }).label === 'Wrong drop', 'dropping a take: "Wrong drop"');
  assert(analyzeCube({ kind: 'take', pi: 0, action: true, doubler: 1, state: far }).label === 'Wrong take', 'taking a drop: "Wrong take"');
});

await describe('cube analysis — go deeper / analyse anyway', async () => {
  _reset(); gmConfig.initialTurnIndex = 0; gmConfig.robotThinkMs = 0; gmConfig.cubeAnalysisGames = 20;
  gmConfig.cubeLevels = [20, 40, 80];
  gmConfig.analysis = { mode: 'eval', keep: 2 };
  gmConfig.analysisLevels = [gmConfig.analysis, { screenBy: 'eval', deep: 8, keep: 2, maxDeep: 8 }];
  const host = mockWs(), guest = mockWs();
  const { code, roomId } = createRoom(host, 'Alice', 2, undefined, { cube: true });
  joinRoom(guest, code, 'Bob');
  startGame(host, roomId);
  const room = _getRoom(roomId);
  handleRoll(host, roomId);                           // rolls without doubling: a no-double at the start
  const g = room.game;
  g.players[0].marbles.forEach((m, i) => Object.assign(m, i < 3 ? { zone: 'home', slot: 4 - i } : { zone: 'track', space: 84 }));
  Object.assign(g.players[1].marbles[0], { zone: 'home', slot: 4 });
  g.phase = 'AWAITING_MOVE'; g.dice = [1, 2]; g.diceUsed = [false, true]; g._humanMadeMove = false; g._undoStack = [];
  handleMove(host, roomId, { type: 'move', dieIndex: 0, marbleId: 3, toZone: 'home', toSlot: 1 });
  host.sent = [];
  handleAnalyzeGame(host, roomId);
  for (let t = 0; t < 200 && !host.find('cubeUpdate').length; t++) await sleep(50);
  const first = host.find('cubeUpdate')[0]?.analysis;
  assert(first?.skip === true, 'opening no-double is skipped (nowhere near a double)');
  host.sent = [];
  handleAnalyzeDeeperCube(host, roomId, 0);
  for (let t = 0; t < 200 && !host.find('cubeUpdate').length; t++) await sleep(50);
  const anyway = host.find('cubeUpdate')[0]?.analysis;
  assert(host.find('cubeDeepening').length === 1 && anyway && !anyway.skip && anyway.n === 20 && anyway.level === 0, `"Analyse anyway" works it out (${anyway?.n} games, best ${anyway?.best})`);
  host.sent = [];
  handleAnalyzeDeeperCube(host, roomId, 0);
  for (let t = 0; t < 200 && !host.find('cubeUpdate').length; t++) await sleep(50);
  const deeper = host.find('cubeUpdate')[0]?.analysis;
  assert(deeper?.level === 1 && deeper.n === 40, `go deeper: next level (${deeper?.n} games)`);
});

describe('3+ players — every loser pays: 1, aggro 2, baggro 3', () => {
  const g = createGame(['blue', 'yellow', 'green', 'red'].map(c => ({ name: c, color: c })), undefined, 0);
  Object.assign(g.players[1].marbles[0], { zone: 'home', slot: 4 });      // plain: 1
  Object.assign(g.players[2].marbles[0], { zone: 'track', space: 20 });   // aggro: 2
  const r = gameResult(g, 0);                                              // red: all in base, baggro: 3
  assert(r.points === 6 && r.losers.map(l => l.points).join() === '1,2,3' && r.baggro, `winner +6, losers −1 −2 −3 (${r.losers.map(l => l.points)})`);
});

describe('Jacoby rule — aggros count only once the cube has been turned', () => {
  const mk = () => { const g = createGame([{ name: 'a', color: 'blue' }, { name: 'b', color: 'yellow' }], undefined, 0, { cube: true, jacoby: true }); return g; };
  const g = mk();
  assert(gameResult(g, 0).points === 1 && !gameResult(g, 0).aggro, 'cube at 1: a baggro scores 1');
  Object.assign(g.players[1].marbles[1], { zone: 'track', space: 10 });
  g.cube.value = 2;
  assert(gameResult(g, 0).points === 4 && gameResult(g, 0).aggro, 'cube turned to 2: an aggro scores 4');
});

await describe('match play — score, Crawford game, post-Crawford, match over', async () => {
  _reset(); gmConfig.initialTurnIndex = 0; gmConfig.robotThinkMs = 0;
  const host = mockWs(), guest = mockWs();
  const { code, roomId, matchTo } = createRoom(host, 'Alice', 2, undefined, { cube: true, matchTo: 3 });
  assert(matchTo === 3, 'match to 3 created');
  joinRoom(guest, code, 'Bob');
  startGame(host, roomId);
  const room = _getRoom(roomId);
  const win = (pi, aggro = false) => {           // pi wins the current game
    const g = room.game;
    g.turnIndex = pi;
    g.players[pi].marbles.forEach((m, i) => Object.assign(m, i < 3 ? { zone: 'home', slot: 4 - i } : { zone: 'track', space: g.players[pi].config.homeEntry }));
    g.players[1 - pi].marbles.forEach((m, i) => Object.assign(m, i === 0 ? (aggro ? { zone: 'track', space: 10 } : { zone: 'home', slot: 4 }) : { zone: 'base', space: null, slot: null }));
    g.phase = 'AWAITING_MOVE'; g.dice = [1, 2]; g.diceUsed = [false, true]; g._humanMadeMove = false; g._undoStack = [];
    handleMove(pi === 0 ? host : guest, roomId, { type: 'move', dieIndex: 0, marbleId: 3, toZone: 'home', toSlot: 1 });
  };
  win(0);                                          // Alice 1–0
  assert(room.match.score.join() === '1,0' && !room.match.over, 'a single game scores 1 in the match');
  handleRematch(host, roomId); handleRematch(guest, roomId);
  assert(room.game.cube.away?.join() === '2,3' && host.find('gameStarted').pop().gameState.cube.away?.join() === '2,3', 'cube knows the away scores (server and client)');
  room.game.turnIndex = 1; room.game.phase = 'IN_TURN'; room.game.dice = null;
  offerDouble(room.game, 1); takeDouble(room.game, 0);
  room.game.turnIndex = 0; room.game.phase = 'IN_TURN';
  assert(!canDouble(room.game, 0), 'Alice 2-away owning the cube at 2: dead, no redouble');
  Object.assign(room.game.cube, { value: 1, owner: null });
  win(0);                                          // Alice 2–0: match point
  handleRematch(host, roomId); handleRematch(guest, roomId);
  assert(room.game.cube.crawford === true && !canDouble(room.game, room.game.turnIndex), 'next game is the Crawford game: no doubling');
  assert(host.find('gameStarted').pop().gameState.match.crawford === true, 'clients are told it is the Crawford game');
  win(1);                                          // Bob 2–1
  handleRematch(host, roomId); handleRematch(guest, roomId);
  assert(!room.game.cube.crawford && room.match.crawfordUsed, 'after it: post-Crawford, doubling allowed');
  win(1, true);                                    // Bob aggro: 2 points → 2–3, Bob wins the match
  const res = host.find('gameResult').pop();
  assert(res.match.over && res.match.winner === 1 && res.match.score.join() === '2,3', `match over: Bob wins 3–2 (${res.match.score})`);
  handleRematch(host, roomId); handleRematch(guest, roomId);
  assert(room.match.score.join() === '0,0' && !room.match.over && !room.match.crawfordUsed, 'rematch after the match: a new match');
});

await describe('quitting — resign a match; 3+ players: a robot takes the seat', async () => {
  _reset(); gmConfig.initialTurnIndex = 0; gmConfig.robotThinkMs = 0;
  const host = mockWs(), guest = mockWs();
  const { code, roomId } = createRoom(host, 'Alice', 2, undefined, { cube: true, matchTo: 5 });
  joinRoom(guest, code, 'Bob');
  startGame(host, roomId);
  const room = _getRoom(roomId);
  handleQuit(guest, roomId);
  const res = host.find('gameResult').pop();
  assert(res && res.winnerIndex === 0 && res.result.resigned && res.match.over && res.match.score[0] === 5, 'Bob resigns: Alice wins the match');
  assert(room.slots[1].isRobot, 'the quitter\'s seat is a robot now');

  _reset();
  const a = mockWs(), b = mockWs(), c = mockWs();
  const r3 = createRoom(a, 'A', 3);
  joinRoom(b, r3.code, 'B'); joinRoom(c, r3.code, 'C');
  startGame(a, r3.roomId);
  const room3 = _getRoom(r3.roomId);
  handleQuit(b, r3.roomId);
  assert(room3.state === 'playing' && room3.slots[1].isRobot && room3.game.winner == null, '3 players: B quits, a robot plays on');
});

describe('match play — robot cube decisions follow the score', () => {
  // Post-Crawford, the trailer should double at once (nothing to lose); the leader takes.
  const r = matchCube({ p: 0.45, aggroWin: 0.03, aggroLoss: 0.03 }, { a: 4, b: 1, v: 1, crawfordUsed: true });
  assert(r.double && r.take, 'post-Crawford: the trailer doubles even as the underdog, and it is a take');
  const open = matchCube({ p: 0.52, aggroWin: 0.04, aggroLoss: 0.035 }, { a: 3, b: 3, v: 1, crawfordUsed: false });
  assert(!open.double, 'no opening double at 3-away 3-away (cube ownership counts)');
  const strong = matchCube({ p: 0.75, aggroWin: 0.05, aggroLoss: 0.02 }, { a: 3, b: 3, v: 1, crawfordUsed: false });
  assert(strong.double, 'a big lead at 3-away 3-away is a double');
  const dmp = matchCube({ p: 0.9, aggroWin: 0, aggroLoss: 0 }, { a: 1, b: 1, v: 1, crawfordUsed: true });
  assert(!dmp.double, 'both at match point: doubling is pointless');
  assert(Math.abs(met(1, 1) - 0.5) < 1e-9 && met(1, 3) > met(1, 2) && met(2, 1) < 0.5, 'match equity table is consistent');
});

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
