// Unit tests for GameEngine.js — star track, center hub, and regression cases.
// Run with: node test-engine.mjs

import {
  createGame, legalMovesForDie, allLegalMoves, applyMove,
  PLAYER_CONFIG, ALL_STARS, advanceTrack, trackDistance,
  marbleOnTrack, marbleAtCenter, marbleInHome,
} from './src/GameEngine.js';

let passed = 0, failed = 0;

function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else       { console.error(`  ✗ ${label}`); failed++; }
}

function describe(label, fn) {
  console.log(`\n${label}`);
  fn();
}

// ---- Helpers ----------------------------------------------------------------

function makeState(numPlayers = 2) {
  return createGame(
    Array.from({ length: numPlayers }, (_, i) => ({
      id: `p${i}`, name: `P${i}`, color: PLAYER_CONFIG[i].color, isRobot: false,
    }))
  );
}

function setMarble(state, pi, mi, zone, space = null, slot = null, starEligible = false) {
  const m = state.players[pi].marbles[mi];
  m.zone = zone; m.space = space; m.slot = slot; m.starEligible = starEligible;
}

function setDice(state, d0, d1) {
  state.dice = [d0, d1];
  state.diceUsed = [false, false];
  state.phase = 'AWAITING_MOVE';
}

// Collect moves of a given type for player 0, marble 0, die 0
function movesOfType(state, type) {
  return legalMovesForDie(state, 0, 0, 0).filter(m => m.type === type);
}

// ---- trackDistance / advanceTrack sanity ------------------------------------

describe('trackDistance', () => {
  assert(trackDistance(1, 8) === 7,  '1 → 8 is 7 steps');
  assert(trackDistance(3, 8) === 5,  '3 → 8 is 5 steps');
  assert(trackDistance(4, 8) === 4,  '4 → 8 is 4 steps');
  assert(trackDistance(84, 1) === 1, '84 → 1 wraps correctly');
  assert(trackDistance(78, 8) === 14,'78 → 8 (star wrap) is 14 steps');
});

describe('advanceTrack', () => {
  assert(advanceTrack(1,  7) === 8,  '1 + 7 = star 8');
  assert(advanceTrack(3,  5) === 8,  '3 + 5 = star 8 (user example)');
  assert(advanceTrack(84, 1) === 1,  '84 + 1 wraps to 1');
  assert(advanceTrack(78, 14) === 8, '78 + 14 = star 8 across wrap');
});

// ---- canEnterCenter (via enterCenter move) -----------------------------------

describe('enterCenter — from main track (exact count to any star + 1)', () => {
  const state = makeState();

  // Yellow (player 0): start=1, star=8
  // From star 8 itself, die=1 → enter center
  setMarble(state, 0, 0, 'track', 8, null, true);
  setDice(state, 1, 2);
  assert(movesOfType(state, 'enterCenter').length === 1, 'die=1 from own star → enterCenter');

  // From space 4, die=5: stepsToStar=4, 4+1=5 → enter center  (user's "3-5" example)
  setMarble(state, 0, 0, 'track', 4, null, false);
  setDice(state, 5, 2);
  assert(movesOfType(state, 'enterCenter').length === 1, 'die=5 from space 4 → enterCenter (3-5 example)');

  // From space 7, die=2: stepsToStar=1, 1+1=2 → enter center
  setMarble(state, 0, 0, 'track', 7, null, false);
  setDice(state, 2, 1);
  assert(movesOfType(state, 'enterCenter').length === 1, 'die=2 from space 7 → enterCenter');

  // From space 3, die=6: stepsToStar=5, 5+1=6 → enter center
  setMarble(state, 0, 0, 'track', 3, null, false);
  setDice(state, 6, 1);
  assert(movesOfType(state, 'enterCenter').length === 1, 'die=6 from space 3 → enterCenter');

  // Wrong die: from space 7, die=3 → no enter center (need 2)
  setMarble(state, 0, 0, 'track', 7, null, false);
  setDice(state, 3, 1);
  assert(movesOfType(state, 'enterCenter').length === 0, 'wrong die from space 7 → no enterCenter');

  // Path blocked: own marble at space 8 (the star itself)
  setMarble(state, 0, 0, 'track', 7, null, false);
  setMarble(state, 0, 1, 'track', 8, null, false); // own marble blocks path
  setDice(state, 2, 1);
  assert(movesOfType(state, 'enterCenter').length === 0, 'own marble on star blocks enterCenter from behind');
  setMarble(state, 0, 1, 'base'); // restore

  // homeEntry in the way: yellow's homeEntry=84; from space 80, die=5: stepsToStar=12 (80→…→8),
  // stepsToHomeEntry=4 (80→84). homeEntry < stepsToStar so it intercepts → no enterCenter via star 8.
  // But another star might be reachable: stepsTo22 = (22-80+84)%84=26, die=5≠27. stepsTo36=40≠41 etc.
  // So no enterCenter at all from space 80 with die=5.
  setMarble(state, 0, 0, 'track', 80, null, false);
  setDice(state, 5, 1);
  assert(movesOfType(state, 'enterCenter').length === 0, 'homeEntry in path blocks enterCenter');
});

describe('enterCenter — reachable via any star, not just own', () => {
  // Orange star is at 22. From space 21 (1 before star 22), die=2.
  // Player 0 is yellow; but canEnterCenter checks ALL_STARS, so star 22 should work.
  const state = makeState();
  setMarble(state, 0, 0, 'track', 21, null, false);
  setDice(state, 2, 1);
  assert(movesOfType(state, 'enterCenter').length === 1, 'die=2 from space 21 → enterCenter via star 22');
});

// ---- exitCenter (die=1 only) ------------------------------------------------

describe('exitCenter', () => {
  const state = makeState(6); // need all player stars populated

  // Marble in center, die=1 → can exit to all 6 stars
  setMarble(state, 0, 0, 'center');
  setDice(state, 1, 2);
  const exits1 = movesOfType(state, 'exitCenter');
  assert(exits1.length === 6, 'die=1 from center → 6 exit options');
  assert(exits1.every(m => m.toStar !== undefined), 'all exits specify toStar');

  // die=2 → no exitCenter moves
  setDice(state, 2, 1);
  assert(movesOfType(state, 'exitCenter').length === 0, 'die=2 from center → no exit');

  // die=1, own marble blocks star 8 → 5 options
  setMarble(state, 0, 1, 'track', 8); // own marble at star 8
  setDice(state, 1, 2);
  assert(movesOfType(state, 'exitCenter').length === 5, 'blocked star 8 → 5 exit options');
  setMarble(state, 0, 1, 'base');
});

// ---- starEligible set for ANY star ------------------------------------------

describe('starEligible set for any star landing', () => {
  const state = makeState(2);

  // Move marble 0 to star 8 (own star)
  setMarble(state, 0, 0, 'track', 7, null, false);
  setDice(state, 1, 2);
  applyMove(state, 0, { type: 'move', dieIndex: 0, marbleId: 0, toZone: 'track', toSpace: 8 });
  assert(state.players[0].marbles[0].starEligible === true, 'landing on own star → starEligible');

  // Landing on orange star (22) — not own star — should also be star-eligible
  setMarble(state, 0, 0, 'track', 21, null, false);
  state.dice = [1, 2]; state.diceUsed = [false, false]; state.phase = 'AWAITING_MOVE';
  applyMove(state, 0, { type: 'move', dieIndex: 0, marbleId: 0, toZone: 'track', toSpace: 22 });
  assert(state.players[0].marbles[0].starEligible === true, 'landing on any star → starEligible');

  // Landing on non-star should clear starEligible
  setMarble(state, 0, 0, 'track', 8, null, true);
  state.dice = [2, 1]; state.diceUsed = [false, false]; state.phase = 'AWAITING_MOVE';
  applyMove(state, 0, { type: 'move', dieIndex: 0, marbleId: 0, toZone: 'track', toSpace: 10 });
  assert(state.players[0].marbles[0].starEligible === false, 'landing on non-star → not starEligible');
});

// ---- legalMovesViaStarTrack -------------------------------------------------

describe('moveStar — star track movement', () => {
  const state = makeState(6);

  // From star 8, die=1: 1 star step → land on star 22
  setMarble(state, 0, 0, 'track', 8, null, true);
  setDice(state, 1, 2);
  const ms1 = movesOfType(state, 'moveStar');
  assert(ms1.length === 1, 'die=1 from star 8 → 1 moveStar');
  assert(ms1[0].toZone === 'track' && ms1[0].toSpace === 22, 'die=1: land on star 22');

  // From star 8, die=2: options — (k=1,r=1) enterCenter + moveStar to 23; (k=2,r=0) moveStar to 36
  setDice(state, 2, 1);
  const ms2 = movesOfType(state, 'moveStar');
  const ec2 = movesOfType(state, 'enterCenter');
  assert(ms2.some(m => m.toSpace === 36 && m.toZone === 'track'), 'die=2: can land on star 36 (2 star steps)');
  assert(ms2.some(m => m.toSpace === 23 && m.toZone === 'track'), 'die=2: can exit at star 22, +1 main = space 23');
  assert(ec2.length >= 1, 'die=2: enterCenter (via star 22, 1 remaining)');

  // From star 8, die=3: k=1→r=2 (space 24), k=2→r=1 (enterCenter + space 37), k=3→r=0 (star 50)
  setDice(state, 3, 1);
  const ms3 = movesOfType(state, 'moveStar');
  assert(ms3.some(m => m.toSpace === 50), 'die=3: can land on star 50 (3 star steps)');
  assert(ms3.some(m => m.toSpace === 24), 'die=3: via star 22 + 2 main = space 24');
  assert(ms3.some(m => m.toSpace === 37), 'die=3: via star 36 + 1 main = space 37');

  // From star 78 (blue), die=1: star track wraps → land on star 8
  setMarble(state, 0, 0, 'track', 78, null, true);
  setDice(state, 1, 2);
  const msWrap = movesOfType(state, 'moveStar');
  assert(msWrap.some(m => m.toSpace === 8), 'star track wraps: from star 78, die=1 → star 8');

  // Own marble blocks traversal: own marble on star 22 → die=2 can't reach star 36 via 22
  setMarble(state, 0, 0, 'track', 8, null, true);
  setMarble(state, 0, 1, 'track', 22); // blocks
  setDice(state, 2, 1);
  const msBlocked = movesOfType(state, 'moveStar');
  assert(!msBlocked.some(m => m.toSpace === 36), 'own marble on star 22 blocks further traversal');
  setMarble(state, 0, 1, 'base');

  // Not star-eligible → no moveStar moves
  setMarble(state, 0, 0, 'track', 10, null, false);
  setDice(state, 1, 2);
  assert(movesOfType(state, 'moveStar').length === 0, 'not starEligible → no moveStar');
});

describe('moveStar — stays starEligible after landing on star', () => {
  const state = makeState(6);
  setMarble(state, 0, 0, 'track', 8, null, true);
  state.dice = [1, 2]; state.diceUsed = [false, false]; state.phase = 'AWAITING_MOVE';
  applyMove(state, 0, { type: 'moveStar', dieIndex: 0, marbleId: 0, toZone: 'track', toSpace: 22 });
  assert(state.players[0].marbles[0].starEligible === true, 'after moveStar to star 22: still starEligible');
});

describe('moveStar — bumps opponent at final destination only', () => {
  const state = makeState(6);
  // Place opponent marble at star 22
  setMarble(state, 1, 0, 'track', 22);
  setMarble(state, 0, 0, 'track', 8, null, true);
  state.dice = [1, 2]; state.diceUsed = [false, false]; state.phase = 'AWAITING_MOVE';
  const events = applyMove(state, 0, { type: 'moveStar', dieIndex: 0, marbleId: 0, toZone: 'track', toSpace: 22 });
  assert(events.some(e => e.event === 'marbleBumped'), 'moveStar bumps opponent at landing star');
  assert(state.players[1].marbles[0].zone === 'base', 'bumped marble returned to base');
});

// ---- enterCenter via applyMove ----------------------------------------------

describe('enterCenter — applyMove', () => {
  const state = makeState(2);
  setMarble(state, 0, 0, 'track', 8, null, true);
  state.dice = [1, 2]; state.diceUsed = [false, false]; state.phase = 'AWAITING_MOVE';
  const events = applyMove(state, 0, { type: 'enterCenter', dieIndex: 0, marbleId: 0 });
  assert(state.players[0].marbles[0].zone === 'center', 'marble moved to center');
  assert(state.players[0].marbles[0].starEligible === false, 'starEligible cleared on center entry');
  assert(events.some(e => e.event === 'marbleMoved' && e.to.zone === 'center'), 'marbleMoved event emitted');

  // Bumps opponent in center
  setMarble(state, 1, 0, 'center');
  setMarble(state, 0, 0, 'track', 8, null, true);
  state.dice = [1, 2]; state.diceUsed = [false, false];
  const events2 = applyMove(state, 0, { type: 'enterCenter', dieIndex: 0, marbleId: 0 });
  assert(events2.some(e => e.event === 'marbleBumped'), 'enterCenter bumps opponent in center');
});

// ---- exitCenter via applyMove -----------------------------------------------

describe('exitCenter — applyMove', () => {
  const state = makeState(2);
  setMarble(state, 0, 0, 'center');
  state.dice = [1, 2]; state.diceUsed = [false, false]; state.phase = 'AWAITING_MOVE';
  applyMove(state, 0, { type: 'exitCenter', dieIndex: 0, marbleId: 0, toStar: 22 });
  const m = state.players[0].marbles[0];
  assert(m.zone === 'track' && m.space === 22, 'marble exited to star 22');
  assert(m.starEligible === true, 'starEligible true after exiting center');
});

// ---- Normal move — starEligible regression ----------------------------------

describe('normal move — starEligible set correctly', () => {
  const state = makeState(2);

  // Marble on track, moves to space 10 (not a star) → starEligible = false
  setMarble(state, 0, 0, 'track', 8, null, true);
  state.dice = [2, 1]; state.diceUsed = [false, false]; state.phase = 'AWAITING_MOVE';
  applyMove(state, 0, { type: 'move', dieIndex: 0, marbleId: 0, toZone: 'track', toSpace: 10 });
  assert(state.players[0].marbles[0].starEligible === false, 'move to non-star clears starEligible');

  // Marble on track, normal move lands on star 22 → starEligible = true
  setMarble(state, 0, 0, 'track', 20, null, false);
  state.dice = [2, 1]; state.diceUsed = [false, false];
  applyMove(state, 0, { type: 'move', dieIndex: 0, marbleId: 0, toZone: 'track', toSpace: 22 });
  assert(state.players[0].marbles[0].starEligible === true, 'normal move landing on star 22 → starEligible');
});

// ---- exitBase regression ----------------------------------------------------

describe('exitBase', () => {
  const state = makeState(2);
  state.dice = [1, 2]; state.diceUsed = [false, false]; state.phase = 'AWAITING_MOVE';
  const moves = legalMovesForDie(state, 0, 0, 0);
  assert(moves.some(m => m.type === 'exitBase'), 'die=1 allows exitBase');
  applyMove(state, 0, moves.find(m => m.type === 'exitBase'));
  const m = state.players[0].marbles[0];
  assert(m.zone === 'track' && m.space === 1, 'marble placed on start space');
  assert(m.starEligible === false, 'start space is not a star → not starEligible');
});

// ---- Home entry regression --------------------------------------------------

describe('home entry', () => {
  const state = makeState(2);
  // Yellow's homeEntry is 84. From space 83, die=1 → enter home slot 1
  setMarble(state, 0, 0, 'track', 83, null, false);
  state.dice = [1, 2]; state.diceUsed = [false, false]; state.phase = 'AWAITING_MOVE';
  const moves = legalMovesForDie(state, 0, 0, 0);
  assert(moves.some(m => m.type === 'move' && m.toZone === 'home' && m.toSlot === 1),
    'die=1 from space 83 → enter home slot 1');
});

// ---- moveHome regression ----------------------------------------------------

describe('moveHome', () => {
  const state = makeState(2);
  setMarble(state, 0, 0, 'home', null, 1, false);
  state.dice = [2, 1]; state.diceUsed = [false, false]; state.phase = 'AWAITING_MOVE';
  const moves = legalMovesForDie(state, 0, 0, 0);
  assert(moves.some(m => m.type === 'moveHome' && m.toSlot === 3), 'die=2 from slot 1 → slot 3');
  // Overshoot
  setMarble(state, 0, 0, 'home', null, 3, false);
  state.dice = [3, 1]; state.diceUsed = [false, false];
  assert(legalMovesForDie(state, 0, 0, 0).length === 0, 'overshoot home → no move');
});

// ---- allLegalMoves consolidation --------------------------------------------

describe('allLegalMoves — no duplicate types for same die', () => {
  const state = makeState(6);
  // Put marble on star, give a variety of dice, ensure enterCenter not duplicated
  setMarble(state, 0, 0, 'track', 8, null, true);
  state.dice = [1, 3]; state.diceUsed = [false, false]; state.phase = 'AWAITING_MOVE';
  const legal = allLegalMoves(state, 0);
  // die=1 from star: enterCenter (from canEnterCenter, stepsToStar=0, die=1)
  // AND moveStar die=1 (1 step on star track). No duplicate enterCenter.
  const ecForDie0 = (legal[0] || []).filter(m => m.type === 'enterCenter');
  assert(ecForDie0.length === 1, 'exactly one enterCenter for die=1 from own star');
});

// ---- homeEntry edge-case regressions ----------------------------------------

describe('home entry — landing exactly on homeEntry space', () => {
  const state = makeState(2);
  // Yellow homeEntry=84. Die=1 from space 83 lands on 84 → should enter home slot 1.
  setMarble(state, 0, 0, 'track', 83, null, false);
  setDice(state, 1, 2);
  const m1 = legalMovesForDie(state, 0, 0, 0);
  assert(m1.some(m => m.type === 'move' && m.toZone === 'home' && m.toSlot === 1),
    'die=1 from 83 → enter home slot 1 (crossesHome fix)');

  // Die=2 from space 83: stepsToEntry=1, stepsIntoHome=1 → slot 1
  setDice(state, 2, 1);
  const m2 = legalMovesForDie(state, 0, 0, 0);
  assert(m2.some(m => m.type === 'move' && m.toZone === 'home' && m.toSlot === 1),
    'die=2 from 83 → enter home slot 1');

  // Die=2 from space 82: stepsToEntry=2, stepsIntoHome=0 → slot 1 (lands on homeEntry itself)
  setMarble(state, 0, 0, 'track', 82, null, false);
  setDice(state, 2, 1);
  const m3 = legalMovesForDie(state, 0, 0, 0);
  assert(m3.some(m => m.type === 'move' && m.toZone === 'home' && m.toSlot === 1),
    'die=2 from 82 → land on homeEntry → slot 1');

  // Die=3 from space 82: stepsToEntry=2, stepsIntoHome=1 → slot 1
  setDice(state, 3, 1);
  const m4 = legalMovesForDie(state, 0, 0, 0);
  assert(m4.some(m => m.type === 'move' && m.toZone === 'home' && m.toSlot === 1),
    'die=3 from 82 → enter home slot 1');
});

// ---- Summary ----------------------------------------------------------------

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
