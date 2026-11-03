// Unit tests for GameEngine.js — star track, center hub, and regression cases.
// Run with: node test-engine.mjs

import {
  createGame, legalMovesForDie, allLegalMoves, applyMove,
  PLAYER_CONFIG, ALL_STARS, advanceTrack, trackDistance,
  marbleOnTrack, marbleAtCenter, marbleInHome, marbleInBase,
  earnsExtraRoll, MARBLES_PER_PLAYER,
} from '../src/GameEngine.js';
import { pickNextRobotMove } from '../src/RobotPlayer.js';

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
  // Yellow's homeEntry is 84. From space 83, die=1 lands exactly on homeEntry → stays on track
  setMarble(state, 0, 0, 'track', 83, null, false);
  state.dice = [1, 2]; state.diceUsed = [false, false]; state.phase = 'AWAITING_MOVE';
  const moves = legalMovesForDie(state, 0, 0, 0);
  assert(moves.some(m => m.type === 'move' && m.toZone === 'track' && m.toSpace === 84),
    'die=1 from space 83 → lands on homeEntry (track space 84), not home');
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
  // Yellow homeEntry=84. Die=1 from space 83 lands exactly on 84 → stays on track.
  setMarble(state, 0, 0, 'track', 83, null, false);
  setDice(state, 1, 2);
  const m1 = legalMovesForDie(state, 0, 0, 0);
  assert(m1.some(m => m.type === 'move' && m.toZone === 'track' && m.toSpace === 84),
    'die=1 from 83 → lands on homeEntry (track 84), not home (crossesHome fix)');

  // Die=2 from space 83: stepsToEntry=1, stepsIntoHome=1 → slot 1
  setDice(state, 2, 1);
  const m2 = legalMovesForDie(state, 0, 0, 0);
  assert(m2.some(m => m.type === 'move' && m.toZone === 'home' && m.toSlot === 1),
    'die=2 from 83 → enter home slot 1');

  // Die=2 from space 82: stepsToEntry=2, stepsIntoHome=0 → lands on homeEntry (track), not slot 1
  setMarble(state, 0, 0, 'track', 82, null, false);
  setDice(state, 2, 1);
  const m3 = legalMovesForDie(state, 0, 0, 0);
  assert(m3.some(m => m.type === 'move' && m.toZone === 'track' && m.toSpace === 84),
    'die=2 from 82 → lands on homeEntry (track 84), not slot 1');

  // Die=3 from space 82: stepsToEntry=2, stepsIntoHome=1 → slot 1
  setDice(state, 3, 1);
  const m4 = legalMovesForDie(state, 0, 0, 0);
  assert(m4.some(m => m.type === 'move' && m.toZone === 'home' && m.toSlot === 1),
    'die=3 from 82 → enter home slot 1');
});

// ---- trackDistance / advanceTrack — boundary values -------------------------

describe('trackDistance — same-space = full lap, never zero', () => {
  assert(trackDistance(8, 8)  === 84, 'trackDistance(8,8) === 84 (never 0)');
  assert(trackDistance(1, 1)  === 84, 'trackDistance(1,1) === 84');
  assert(trackDistance(84, 84) === 84, 'trackDistance(84,84) === 84');
});

describe('advanceTrack — boundary and wrap', () => {
  assert(advanceTrack(5, 84) === 5,  'full lap (n=84) returns to same space');
  assert(advanceTrack(83, 3) === 2,  '83 + 3 wraps to 2');
  assert(advanceTrack(84, 1) === 1,  '84 + 1 = 1 (already tested, confirm)');
  assert(advanceTrack(1, 0)  === 1,  'n=0: no movement');
});

// ---- exitBase — full die matrix ---------------------------------------------

describe('exitBase — die matrix: only 1 and 6 allowed', () => {
  for (const die of [2, 3, 4, 5]) {
    const s = makeState();
    setDice(s, die, 1);
    const moves = legalMovesForDie(s, 0, 0, 0);
    assert(moves.filter(m => m.type === 'exitBase').length === 0,
      `die=${die} → no exitBase`);
  }

  const s1 = makeState();
  setDice(s1, 1, 2);
  assert(legalMovesForDie(s1, 0, 0, 0).some(m => m.type === 'exitBase'),
    'die=1 → exitBase legal');

  const s6 = makeState();
  setDice(s6, 6, 2);
  assert(legalMovesForDie(s6, 0, 0, 0).some(m => m.type === 'exitBase'),
    'die=6 → exitBase legal');
});

describe('exitBase — own marble blocks start space', () => {
  const s = makeState();
  // Put marble 1 on start space (space 1) for player 0
  setMarble(s, 0, 1, 'track', 1);

  setDice(s, 1, 2);
  assert(legalMovesForDie(s, 0, 0, 0).filter(m => m.type === 'exitBase').length === 0,
    'die=1, own marble at start → no exitBase');

  setDice(s, 6, 2);
  assert(legalMovesForDie(s, 0, 0, 0).filter(m => m.type === 'exitBase').length === 0,
    'die=6, own marble at start → no exitBase');
});

describe('exitBase — opponent at start is bumpable', () => {
  const s = makeState(2);
  // Put player 1's marble on player 0's start space (space 1)
  setMarble(s, 1, 0, 'track', 1);

  setDice(s, 1, 2);
  assert(legalMovesForDie(s, 0, 0, 0).some(m => m.type === 'exitBase'),
    'die=1, opponent at start → exitBase still legal (will bump)');

  setDice(s, 6, 2);
  assert(legalMovesForDie(s, 0, 0, 0).some(m => m.type === 'exitBase'),
    'die=6, opponent at start → exitBase still legal (will bump)');

  // Apply the exitBase and confirm opponent was bumped
  const s2 = makeState(2);
  setMarble(s2, 1, 0, 'track', 1);
  setDice(s2, 1, 2);
  const move = legalMovesForDie(s2, 0, 0, 0).find(m => m.type === 'exitBase');
  const events = applyMove(s2, 0, move);
  assert(events.some(e => e.event === 'marbleBumped'), 'exitBase bumps opponent at start');
  assert(s2.players[1].marbles[0].zone === 'base', 'bumped marble returns to base');
});

describe('exitBase — marble lands at correct start space per player config', () => {
  // Player 0 (yellow): start=1
  const s0 = makeState(2);
  setDice(s0, 1, 2);
  const m0 = legalMovesForDie(s0, 0, 0, 0).find(m => m.type === 'exitBase');
  applyMove(s0, 0, m0);
  assert(s0.players[0].marbles[0].space === 1, 'player 0 exits to start=1');
  assert(s0.players[0].marbles[0].starEligible === false, 'start space not a star → not starEligible');

  // Player 1: exits to their own configured start space (ARM_MAP-determined)
  const s1 = makeState(2);
  setDice(s1, 1, 2);
  s1.turnIndex = 1;
  const m1 = legalMovesForDie(s1, 1, 0, 0);
  const eb = m1.find(m => m.type === 'exitBase');
  applyMove(s1, 1, eb);
  assert(s1.players[1].marbles[0].space === s1.players[1].config.start,
    'player 1 exits to their configured start space');
});

// ---- Win condition ----------------------------------------------------------

describe('win condition — gameOver when last marble enters home zone', () => {
  // Win = all marbles in home zone (any slot), not necessarily slot 4.
  const s = makeState(2);
  // 3 marbles already in home (distinct slots); marble 3 on track about to enter
  setMarble(s, 0, 0, 'home', null, 2);
  setMarble(s, 0, 1, 'home', null, 3);
  setMarble(s, 0, 2, 'home', null, 4);
  setMarble(s, 0, 3, 'track', 83, null, false); // one step from homeEntry=84
  setDice(s, 2, 1);

  // die=2 from space 83 → 1 step to homeEntry + 1 into home → enters slot 1
  const moves = legalMovesForDie(s, 0, 0, 3);
  const enterMove = moves.find(m => m.toZone === 'home' && m.toSlot === 1);
  assert(!!enterMove, 'die=2 from 83 → can enter home slot 1');

  const events = applyMove(s, 0, enterMove);
  assert(events.some(e => e.event === 'gameOver'), 'all 4 in home → gameOver');
  assert(s.phase === 'GAME_OVER', 'phase set to GAME_OVER');
  const go = events.find(e => e.event === 'gameOver');
  assert(go && go.winnerIndex === 0, 'gameOver has correct winnerIndex');
});

describe('win condition — no gameOver when a marble remains outside home', () => {
  const s = makeState(2);
  // Only 2 in home; marble 2 in base; marble 3 enters home → still 1 in base
  setMarble(s, 0, 0, 'home', null, 2);
  setMarble(s, 0, 1, 'home', null, 3);
  setMarble(s, 0, 2, 'base');
  setMarble(s, 0, 3, 'track', 83, null, false);
  setDice(s, 2, 1);

  const moves = legalMovesForDie(s, 0, 0, 3);
  const enterMove = moves.find(m => m.toZone === 'home');
  const events = applyMove(s, 0, enterMove);
  assert(!events.some(e => e.event === 'gameOver'), 'marble 2 still in base → no gameOver');
  assert(s.phase !== 'GAME_OVER', 'phase not GAME_OVER');
});

// ---- Bump invariants --------------------------------------------------------

describe('bump — bumped marble fully reset', () => {
  const s = makeState(2);
  // Put opponent marble on track with starEligible=true
  setMarble(s, 1, 0, 'track', 10, null, true);
  // Player 0 marble moves to space 10
  setMarble(s, 0, 0, 'track', 8, null, false);
  setDice(s, 2, 1);
  const events = applyMove(s, 0, { type: 'move', dieIndex: 0, marbleId: 0, toZone: 'track', toSpace: 10 });
  const bumped = s.players[1].marbles[0];
  assert(bumped.zone === 'base',           'bumped marble zone=base');
  assert(bumped.space === null,            'bumped marble space=null');
  assert(bumped.slot  === null,            'bumped marble slot=null');
  assert(bumped.starEligible === false,    'bumped marble starEligible cleared');
  assert(events.some(e => e.event === 'marbleBumped'), 'marbleBumped event emitted');
});

describe('bump — own marble at destination blocks move (not bump)', () => {
  const s = makeState(2);
  setMarble(s, 0, 0, 'track', 8, null, false);
  setMarble(s, 0, 1, 'track', 10, null, false); // own marble at target
  setDice(s, 2, 1);
  const moves = legalMovesForDie(s, 0, 0, 0);
  assert(!moves.some(m => m.toSpace === 10), 'own marble at destination → blocked, no move to that space');
});

// ---- moveHome — overshoot and blocking -------------------------------------

describe('moveHome — slot 4 ceiling: no moves past it', () => {
  const s = makeState(2);

  setMarble(s, 0, 0, 'home', null, 4);
  setDice(s, 1, 2);
  assert(legalMovesForDie(s, 0, 0, 0).filter(m => m.type === 'moveHome').length === 0,
    'slot 4, die=1 → no moveHome (already at max)');

  // Various dice all overshoot from slot 3
  for (const die of [2, 3, 4, 5, 6]) {
    setMarble(s, 0, 0, 'home', null, 3);
    setDice(s, die, 1);
    assert(legalMovesForDie(s, 0, 0, 0).filter(m => m.type === 'moveHome').length === 0,
      `slot 3, die=${die} → overshoot → no moveHome`);
  }
});

describe('moveHome — legal advances without overshoot', () => {
  const s = makeState(2);

  setMarble(s, 0, 0, 'home', null, 3);
  setDice(s, 1, 2);
  assert(legalMovesForDie(s, 0, 0, 0).some(m => m.type === 'moveHome' && m.toSlot === 4),
    'slot 3, die=1 → slot 4');

  setMarble(s, 0, 0, 'home', null, 1);
  setDice(s, 3, 2);
  assert(legalMovesForDie(s, 0, 0, 0).some(m => m.type === 'moveHome' && m.toSlot === 4),
    'slot 1, die=3 → slot 4 (exactly fills)');

  setMarble(s, 0, 0, 'home', null, 2);
  setDice(s, 2, 1);
  assert(legalMovesForDie(s, 0, 0, 0).some(m => m.type === 'moveHome' && m.toSlot === 4),
    'slot 2, die=2 → slot 4');
});

describe('moveHome — path blocked by own marble in home', () => {
  const s = makeState(2);
  setMarble(s, 0, 0, 'home', null, 1);
  setMarble(s, 0, 1, 'home', null, 2); // blocks path for die=2 (must pass slot 2)
  setDice(s, 2, 1);
  assert(legalMovesForDie(s, 0, 0, 0).filter(m => m.type === 'moveHome').length === 0,
    'slot 1 → slot 3, but own marble at slot 2 blocks path → no moveHome');

  // die=1 → slot 2 is the TARGET and is blocked (own marble sitting there)
  setDice(s, 1, 2);
  assert(legalMovesForDie(s, 0, 0, 0).filter(m => m.type === 'moveHome').length === 0,
    'slot 1, die=1 → slot 2 occupied by own marble → no moveHome');
});

// ---- home entry — extended player configs -----------------------------------

describe('home entry — player 1 orange config (homeEntry=14) via 6-player game', () => {
  // In a 6-player game ARM_MAP[6]=[0,1,2,3,4,5] so player 1 uses PLAYER_CONFIG[1]
  // (orange: start=15, star=22, homeEntry=14)
  const s = makeState(6);
  s.turnIndex = 1;

  // From space 13, die=1 → lands exactly on homeEntry=14 → stays on track
  setMarble(s, 1, 0, 'track', 13, null, false);
  setDice(s, 1, 2);
  assert(legalMovesForDie(s, 1, 0, 0).some(m => m.type === 'move' && m.toZone === 'track' && m.toSpace === 14),
    'player 1 (orange): die=1 from space 13 → lands on homeEntry (track 14), not home');

  // From space 12, die=2 → lands exactly on homeEntry=14 → stays on track
  setMarble(s, 1, 0, 'track', 12, null, false);
  setDice(s, 2, 1);
  assert(legalMovesForDie(s, 1, 0, 0).some(m => m.type === 'move' && m.toZone === 'track' && m.toSpace === 14),
    'player 1 (orange): die=2 from space 12 → lands on homeEntry (track 14), not home');
});

describe('home entry — marble starting at homeEntry space redirects to slot 1', () => {
  const s = makeState(2);
  // Yellow homeEntry=84; marble already sitting on space 84
  setMarble(s, 0, 0, 'track', 84, null, false);
  setDice(s, 1, 2);
  assert(legalMovesForDie(s, 0, 0, 0).some(m => m.type === 'move' && m.toZone === 'home' && m.toSlot === 1),
    'marble at homeEntry, die=1 → enter slot 1');
});

describe('home entry — overshoot from near homeEntry', () => {
  const s = makeState(2);

  // From 82, die=6: stepsToEntry=2, into home=4 → slot 4 (legal, exactly fills)
  setMarble(s, 0, 0, 'track', 82, null, false);
  setDice(s, 6, 1);
  assert(legalMovesForDie(s, 0, 0, 0).some(m => m.type === 'move' && m.toZone === 'home' && m.toSlot === 4),
    'from 82, die=6 → slot 4 (exact)');

  // From 83, die=6: stepsToEntry=1, into home=5 → overshoot slot 4 → no move
  setMarble(s, 0, 0, 'track', 83, null, false);
  setDice(s, 6, 1);
  assert(legalMovesForDie(s, 0, 0, 0).filter(m => m.toZone === 'home').length === 0,
    'from 83, die=6 → 5 steps into home → overshoot → no home move');

  // From 81, die=6: stepsToEntry=3, into home=3 → slot 3 (legal)
  setMarble(s, 0, 0, 'track', 81, null, false);
  setDice(s, 6, 1);
  assert(legalMovesForDie(s, 0, 0, 0).some(m => m.toZone === 'home' && m.toSlot === 3),
    'from 81, die=6 → slot 3');
});

describe('home entry — pass-home offered as an optional (skippable) move', () => {
  const s = makeState(2);
  // Yellow homeEntry=84. Marble 0 sits on the home entry; marble 1 occupies home
  // slot 2, so entering home beyond slot 1 is blocked.
  setMarble(s, 0, 0, 'track', 84, null, false);
  setMarble(s, 0, 1, 'home', null, 2, false);
  setDice(s, 1, 4);

  // die=1: can enter slot 1 (free) AND optionally pass home to loop the track
  const m1 = legalMovesForDie(s, 0, 0, 0);
  assert(m1.some(m => m.toZone === 'home' && m.toSlot === 1),
    'die=1 at homeEntry → enter slot 1');
  const around1 = m1.find(m => m.toZone === 'track');
  assert(around1 && around1.optional === true,
    'die=1 at homeEntry → around-the-track is offered as optional');

  // die=4: home slot 4 is blocked, but going around is still offered (optional),
  // so the player may either loop the board or skip the die.
  const m4 = legalMovesForDie(s, 0, 1, 0);
  assert(m4.filter(m => m.toZone === 'home').length === 0,
    'die=4 at homeEntry → home is blocked, no home move');
  const around4 = m4.find(m => m.toZone === 'track');
  assert(around4 && around4.optional === true,
    'die=4 at homeEntry with blocked home → optional around-the-track move');
});

// ---- circleCenter -----------------------------------------------------------

describe('circleCenter — die=6 from center stays in center', () => {
  const s = makeState(6);
  setMarble(s, 0, 0, 'center');

  setDice(s, 6, 1);
  assert(movesOfType(s, 'circleCenter').length === 1, 'die=6 from center → circleCenter available');

  // Apply it — marble should remain in center
  const move = movesOfType(s, 'circleCenter')[0];
  applyMove(s, 0, move);
  assert(s.players[0].marbles[0].zone === 'center', 'after circleCenter marble stays in center zone');
});

describe('circleCenter — die=2 from center → no moves', () => {
  const s = makeState(6);
  setMarble(s, 0, 0, 'center');
  setDice(s, 2, 1);
  assert(movesOfType(s, 'circleCenter').length === 0, 'die=2 from center → no circleCenter');
  assert(movesOfType(s, 'exitCenter').length === 0,   'die=2 from center → no exitCenter either');
});

// ---- exitCenter — bump opponent at destination --------------------------------

describe('exitCenter — bumps opponent at chosen star', () => {
  const s = makeState(6);
  setMarble(s, 0, 0, 'center');
  setMarble(s, 1, 0, 'track', 22); // opponent at star 22

  setDice(s, 1, 2);
  // exitCenter to star 22 should still be offered (it's bumpable)
  const exits = movesOfType(s, 'exitCenter');
  assert(exits.some(m => m.toStar === 22), 'exitCenter to star 22 available despite opponent');

  // Apply it — opponent gets bumped
  const move = exits.find(m => m.toStar === 22);
  const events = applyMove(s, 0, move);
  assert(events.some(e => e.event === 'marbleBumped'), 'exitCenter bumps opponent at star 22');
  assert(s.players[1].marbles[0].zone === 'base', 'bumped marble sent to base');
});

describe('exitCenter — own marble at star blocks that exit option', () => {
  const s = makeState(6);
  setMarble(s, 0, 0, 'center');
  setMarble(s, 0, 1, 'track', 8); // own marble at star 8
  setDice(s, 1, 2);
  const exits = movesOfType(s, 'exitCenter');
  assert(!exits.some(m => m.toStar === 8), 'own marble at star 8 → star 8 not offered as exit');
  assert(exits.length === 5, '5 exits remain (not 6)');
});

// ---- earnsExtraRoll ---------------------------------------------------------

describe('earnsExtraRoll', () => {
  assert(earnsExtraRoll([6, 1]) === true,  '[6,1] → extra roll');
  assert(earnsExtraRoll([1, 6]) === true,  '[1,6] → extra roll');
  assert(earnsExtraRoll([6, 6]) === true,  '[6,6] → extra roll');
  assert(earnsExtraRoll([1, 1]) === false, '[1,1] → no extra roll');
  assert(earnsExtraRoll([3, 5]) === false, '[3,5] → no extra roll');
  assert(earnsExtraRoll([2, 4]) === false, '[2,4] → no extra roll');
});

// ---- allLegalMoves — exhaustion and empty cases -----------------------------

describe('allLegalMoves — all marbles in base, non-1/6 dice → no moves', () => {
  const s = makeState(2);
  s.dice = [3, 4]; s.diceUsed = [false, false]; s.phase = 'AWAITING_MOVE';
  const legal = allLegalMoves(s, 0);
  const total = [...(legal[0] || []), ...(legal[1] || [])].length;
  assert(total === 0, 'dice=[3,4], all in base → 0 legal moves');
});

describe('allLegalMoves — both dice used → no moves returned', () => {
  const s = makeState(2);
  setMarble(s, 0, 0, 'track', 5);
  s.dice = [1, 2]; s.diceUsed = [true, true]; s.phase = 'AWAITING_MOVE';
  const legal = allLegalMoves(s, 0);
  const total = [...(legal[0] || []), ...(legal[1] || [])].length;
  assert(total === 0, 'both dice used → 0 legal moves');
});

// ---- moveStar — opponent at intermediate star does not block ---------------

describe('moveStar — opponent at intermediate star is passable', () => {
  const s = makeState(6);
  setMarble(s, 0, 0, 'track', 8, null, true);
  setMarble(s, 1, 0, 'track', 22); // opponent at star 22 (intermediate)
  setDice(s, 2, 1);
  const ms = movesOfType(s, 'moveStar');
  assert(ms.some(m => m.toSpace === 36),
    'opponent at star 22 does NOT block star-track traversal to star 36');
});

// ---- Initial roll [6,1] and [1,6] — exit base then move --------------------
// Player 0: start=1. "1 past start" = space 2. "6 past start" = space 7.

describe('initial roll [6,1] — exitBase with die=6, then move 1 past start', () => {
  const s = makeState(2);
  setDice(s, 6, 1);

  // Step 1: use die=0 (value=6) to exit base → marble lands on start space
  const exitMove = legalMovesForDie(s, 0, 0, 0).find(m => m.type === 'exitBase');
  assert(!!exitMove, '[6,1] die=6 → exitBase available');
  applyMove(s, 0, exitMove);
  assert(s.players[0].marbles[0].space === 1, 'marble placed at start (space 1)');

  // Step 2: use die=1 (value=1) to move 1 step forward → space 2
  const moveMoves = legalMovesForDie(s, 0, 1, 0);
  assert(moveMoves.some(m => m.type === 'move' && m.toSpace === 2),
    '[6,1] die=1 → can move marble to space 2 (1 past start)');
  applyMove(s, 0, moveMoves.find(m => m.toSpace === 2));
  assert(s.players[0].marbles[0].space === 2, 'marble now at space 2');
});

describe('initial roll [6,1] — exitBase with die=1, then move 6 past start', () => {
  const s = makeState(2);
  setDice(s, 6, 1);

  // Step 1: use die=1 (value=1) to exit base → marble lands on start space
  const exitMove = legalMovesForDie(s, 0, 1, 0).find(m => m.type === 'exitBase');
  assert(!!exitMove, '[6,1] die=1 → exitBase available');
  applyMove(s, 0, exitMove);
  assert(s.players[0].marbles[0].space === 1, 'marble placed at start (space 1)');

  // Step 2: use die=0 (value=6) to move 6 steps forward → space 7
  const moveMoves = legalMovesForDie(s, 0, 0, 0);
  assert(moveMoves.some(m => m.type === 'move' && m.toSpace === 7),
    '[6,1] die=6 → can move marble to space 7 (6 past start)');
  applyMove(s, 0, moveMoves.find(m => m.toSpace === 7));
  assert(s.players[0].marbles[0].space === 7, 'marble now at space 7');
});

describe('initial roll [1,6] — exitBase with die=1, then move 6 past start', () => {
  const s = makeState(2);
  setDice(s, 1, 6);

  // Step 1: use die=0 (value=1) to exit base → marble at start
  const exitMove = legalMovesForDie(s, 0, 0, 0).find(m => m.type === 'exitBase');
  assert(!!exitMove, '[1,6] die=1 → exitBase available');
  applyMove(s, 0, exitMove);
  assert(s.players[0].marbles[0].space === 1, 'marble placed at start (space 1)');

  // Step 2: use die=1 (value=6) to move 6 steps forward → space 7
  const moveMoves = legalMovesForDie(s, 0, 1, 0);
  assert(moveMoves.some(m => m.type === 'move' && m.toSpace === 7),
    '[1,6] die=6 → can move marble to space 7 (6 past start)');
  applyMove(s, 0, moveMoves.find(m => m.toSpace === 7));
  assert(s.players[0].marbles[0].space === 7, 'marble now at space 7');
});

describe('initial roll [1,6] — exitBase with die=6, then move 1 past start', () => {
  const s = makeState(2);
  setDice(s, 1, 6);

  // Step 1: use die=1 (value=6) to exit base → marble at start
  const exitMove = legalMovesForDie(s, 0, 1, 0).find(m => m.type === 'exitBase');
  assert(!!exitMove, '[1,6] die=6 → exitBase available');
  applyMove(s, 0, exitMove);
  assert(s.players[0].marbles[0].space === 1, 'marble placed at start (space 1)');

  // Step 2: use die=0 (value=1) to move 1 step forward → space 2
  const moveMoves = legalMovesForDie(s, 0, 0, 0);
  assert(moveMoves.some(m => m.type === 'move' && m.toSpace === 2),
    '[1,6] die=1 → can move marble to space 2 (1 past start)');
  applyMove(s, 0, moveMoves.find(m => m.toSpace === 2));
  assert(s.players[0].marbles[0].space === 2, 'marble now at space 2');
});

// ---- Robot: never takes the optional go-around --------------------------------

describe('robot — burns dice instead of passing home to go around again', () => {
  // Regression from a real game: a robot one space short of its home entry,
  // with home mostly full, rolled 6-4 and looped past home to the hub instead
  // of waiting and burning both dice.
  const s = makeState(2);
  const homeEntry = s.players[0].config.homeEntry; // 84 for arm 0
  setMarble(s, 0, 0, 'track', homeEntry - 1);       // one short of home entry
  setMarble(s, 0, 1, 'home', null, 2);
  setMarble(s, 0, 2, 'home', null, 3);
  setMarble(s, 0, 3, 'home', null, 4);
  setDice(s, 6, 4);

  const legal = allLegalMoves(s, 0);
  const all = [...(legal[0] ?? []), ...(legal[1] ?? [])];
  assert(all.length > 0 && all.every(m => m.optional),
    'only optional pass-home moves are legal (sanity)');
  assert(pickNextRobotMove(s, 0) === null,
    'robot picks no move, so the die is forfeited');
});

describe('robot — still takes a real move when one exists alongside an optional one', () => {
  const s = makeState(2);
  const homeEntry = s.players[0].config.homeEntry;
  setMarble(s, 0, 0, 'track', homeEntry);           // on home entry, home empty
  setDice(s, 2, 5);                                  // 2 → home slot 2; 5 overshoots

  const chosen = pickNextRobotMove(s, 0);
  assert(chosen && !chosen.optional && chosen.toZone === 'home',
    'robot enters home rather than going around');
});

// ---- Summary ----------------------------------------------------------------

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
