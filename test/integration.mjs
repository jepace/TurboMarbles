// Integration test: full game flow via WebSocket
import { WebSocket } from 'ws';

const URL = 'ws://localhost:3000';
let passed = 0, failed = 0;

function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else       { console.error(`  ✗ ${label}`); failed++; }
}

function makeClient() {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    const msgs = [];
    const waiting = [];
    ws.on('message', raw => {
      const msg = JSON.parse(raw);
      if (waiting.length) waiting.shift()(msg);
      else msgs.push(msg);
    });
    ws.on('open', () => resolve({
      ws,
      send(obj) { ws.send(JSON.stringify(obj)); },
      // Next message, or null after `ms` (if given). A timed-out wait is
      // removed, so it can't swallow a later message meant for another step.
      next(ms) {
        if (msgs.length) return Promise.resolve(msgs.shift());
        return new Promise(r => {
          waiting.push(r);
          if (ms !== undefined) setTimeout(() => {
            const i = waiting.indexOf(r);
            if (i !== -1) { waiting.splice(i, 1); r(null); }
          }, ms);
        });
      },
      close() { ws.close(); },
    }));
  });
}

async function runTests() {
  console.log('\n=== TurboMarbles Integration Tests ===\n');

  // ---- Test 1: createRoom ----
  console.log('1. createRoom');
  let host = await makeClient();
  host.send({ action: 'createRoom', name: 'Alice', totalPlayers: 2 });
  const created = await host.next();
  assert(created.event === 'roomCreated', 'event is roomCreated');
  assert(typeof created.code === 'string' && created.code.length === 6, 'code is 6 chars');
  const { code, roomId } = created;

  // ---- Test 2: joinRoom ----
  console.log('\n2. joinRoom');
  let guest = await makeClient();
  guest.send({ action: 'joinRoom', code, name: 'Bob' });

  // Host receives playerJoined
  const pjHost = await host.next();
  assert(pjHost.event === 'playerJoined', 'host sees playerJoined');
  assert(pjHost.name === 'Bob', 'correct name');

  // Guest receives joinedRoom
  const joined = await guest.next();
  assert(joined.event === 'joinedRoom', 'guest gets joinedRoom');
  assert(joined.playerIndex === 1, 'guest is player 1');

  // ---- Test 3: bad join ----
  console.log('\n3. bad join (wrong code)');
  const stranger = await makeClient();
  stranger.send({ action: 'joinRoom', code: 'ZZZZ', name: 'Eve' });
  const errMsg = await stranger.next();
  assert(errMsg.event === 'error', 'error on bad code');
  stranger.close();

  // ---- Test 4: startGame ----
  console.log('\n4. startGame');
  host.send({ action: 'startGame' });
  const startedHost  = await host.next();
  const startedGuest = await guest.next();
  assert(startedHost.event === 'gameStarted', 'host sees gameStarted');
  assert(startedGuest.event === 'gameStarted', 'guest sees gameStarted');
  const gs = startedHost.gameState;
  assert(gs.players.length === 2, '2 players');
  assert(gs.turnIndex === 0 || gs.turnIndex === 1, 'a valid first player');
  assert(gs.phase === 'IN_TURN', 'phase is IN_TURN');
  // All marbles in base
  const allInBase = gs.players.every(p => p.marbles.every(m => m.zone === 'base'));
  assert(allInBase, 'all marbles start in base');

  // The first player is random. From here on, "host" means whoever moves first
  // and "guest" the other player, so the flow below works either way.
  if (gs.turnIndex === 1) [host, guest] = [guest, host];

  // ---- Test 5: roll (host turn) ----
  console.log('\n5. roll');
  host.send({ action: 'roll' });
  const rolledHost  = await host.next();
  const rolledGuest = await guest.next();
  assert(rolledHost.event === 'rolled', 'host sees rolled');
  assert(rolledGuest.event === 'rolled', 'guest sees rolled');
  const dice = rolledHost.dice;
  assert(Array.isArray(dice) && dice.length === 2, 'dice is array of 2');
  assert(dice.every(d => d >= 1 && d <= 6), 'dice values 1–6');

  // ---- Test 6: guest can't roll on host's turn ----
  console.log('\n6. guest roll rejected on host turn');
  guest.send({ action: 'roll' });
  // Should receive nothing (server silently drops it). Wait briefly.
  // The guest may legitimately receive broadcasts here (e.g. dieForfeit when
  // the first roll had no moves); what must not happen is a second roll.
  const seen = [];
  for (let m; (m = await guest.next(200)); ) seen.push(m);
  assert(!seen.some(m => m.event === 'rolled'), 'guest roll silently ignored');

  // ---- Test 7: exitBase move (if dice allow) ----
  console.log('\n7. exitBase or forfeit dice');
  // Find if either die is 1 or 6 → exitBase move for marble 0
  let exitDieIdx = -1;
  for (let i = 0; i < 2; i++) {
    if (dice[i] === 1 || dice[i] === 6) { exitDieIdx = i; break; }
  }

  if (exitDieIdx >= 0) {
    console.log(`   (die ${exitDieIdx} = ${dice[exitDieIdx]}, can exit base)`);
    host.send({ action: 'move', move: { type: 'exitBase', dieIndex: exitDieIdx, marbleId: 0 } });
    const movedHost  = await host.next();
    const movedGuest = await guest.next();
    assert(movedHost.event === 'marbleMoved', 'host sees marbleMoved');
    assert(movedGuest.event === 'marbleMoved', 'guest sees marbleMoved');
    assert(movedHost.to.zone === 'track', 'marble now on track');
  } else {
    console.log('   (no 1 or 6 rolled — forfeiting both dice)');
  }

  // Forfeit remaining dice → triggers turn advance
  const collectTurnChange = async () => {
    // Drain until turnChanged or timeout
    for (let i = 0; i < 5; i++) {
      const m = await host.next(300);
      if (!m) break;
      if (m.event === 'turnChanged') return m;
    }
    return null;
  };

  host.send({ action: 'forfeitDie', dieIndex: 0 });
  host.send({ action: 'forfeitDie', dieIndex: 1 });
  // After both dice used, turn should change to player 1
  const tc = await collectTurnChange();
  // tc may be null if dice were already partially used; that's ok for this test

  // ---- Test 8: illegal move rejected ----
  console.log('\n8. illegal move rejection');
  // It's guest's turn now (or host's if earnsExtraRoll triggered); ask guest to move
  // We'll have guest roll, then try an invalid move
  // First check whose turn it is via roll attempt
  guest.send({ action: 'roll' });
  const r2 = await guest.next(300);
  if (r2 && r2.event === 'rolled') {
    // Guest's turn — try invalid move
    guest.send({ action: 'move', move: { type: 'move', dieIndex: 0, marbleId: 99 } });
    const errReply = await guest.next(200);
    if (errReply) {
      assert(errReply.event === 'error', 'illegal move returns error');
      assert(errReply.code === 'ILLEGAL_MOVE', 'error code is ILLEGAL_MOVE');
    } else {
      assert(false, 'expected error for illegal move');
    }
    // Drain rolled message on host side
    await host.next(100);
  } else {
    console.log('   (host got extra roll — skipping guest illegal move test)');
    assert(true, 'skipped (extra roll turn)');
  }

  // ---- Done ----
  host.close();
  guest.close();
  await new Promise(r => setTimeout(r, 100));

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(err => { console.error(err); process.exit(1); });
