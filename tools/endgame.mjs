#!/usr/bin/env node
// Exact endgame analysis: how many rolls a player needs to get all four
// marbles home from any arrangement near home — with perfect play, and with
// the robot's play — and how much the robot loses.
//
// Usage:
//   node tools/endgame.mjs [--robot <module>] [--position "<cells>" --roll A-B]
//
//   --robot     robot module to evaluate (default: src/RobotPlayer.js)
//   --position  four marbles, e.g. "37 42 h2 h3" (yellow's track squares are
//               37..42, 42 being its home entry; h1..h4 are home slots)
//   --roll      with --position: show the expected rolls left after each way
//               of playing that roll, and which one the robot picks
//
// Model: one player (yellow), its four marbles on the six track squares before
// its home entry (37–42, no star among them) or in home. Rules as in
// GameEngine: exact landing, no passing your own marbles on the track or in
// home, no overshooting slot 4, and a die must be used if it has a legal move
// (the player picks the order and the move). Value = expected number of rolls
// to finish (a bonus roll after a 6 is just another roll). Opponents are
// ignored — this is the pure race; bump risk is a separate question.
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { createGame, applyMove } from '../src/GameEngine.js';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i === -1 ? null : args[i + 1]; };
const robotUrl = opt('--robot') ? pathToFileURL(resolve(opt('--robot'))).href
  : new URL('../src/RobotPlayer.js', import.meta.url).href;
const { pickNextRobotMove } = await import(robotUrl);

const PLAYER = 1;                                    // yellow in a 2-player game
const cfg = createGame([{ name: 'a' }, { name: 'b' }], undefined, 0).players[PLAYER].config;
const ENTRY = cfg.homeEntry;                         // 42
const TRACK = Array.from({ length: 6 }, (_, i) => ENTRY - 5 + i); // 37..42
const HOME = [101, 102, 103, 104];                   // slots 1..4
const isHome = c => c > 100;
const next = c => (c === ENTRY ? 101 : c + 1);
const key = s => [...s].sort((a, b) => a - b).join(',');
const name = s => [...s].sort((a, b) => a - b).map(c => isHome(c) ? `h${c - 100}` : String(c)).join(' ');
const done = s => s.every(isHome);

function moves(s, v) {                               // states reachable by using die v once
  const out = [];
  for (let i = 0; i < 4; i++) {
    let c = s[i], ok = true;
    for (let k = 0; k < v; k++) {
      if (c === 104) { ok = false; break; }          // would overshoot slot 4
      c = next(c);
      if (s.some((o, j) => j !== i && o === c)) { ok = false; break; } // own marble blocks
    }
    if (ok) { const t = s.slice(); t[i] = c; out.push(t); }
  }
  return out;
}
function outcomes(s, a, b) {                         // every legal way to play roll (a, b)
  const res = new Map();
  for (const [x, y] of [[a, b], [b, a]]) {
    for (const s1 of moves(s, x)) {
      const m2 = moves(s1, y);
      if (m2.length === 0) res.set(key(s1), s1);
      else for (const s2 of m2) res.set(key(s2), s2);
    }
  }
  if (res.size === 0) res.set(key(s), s);            // neither die can be used
  return [...res.values()];
}

const cells = [...TRACK, ...HOME];
const states = [];
for (let a = 0; a < 10; a++) for (let b = a + 1; b < 10; b++)
  for (let c = b + 1; c < 10; c++) for (let d = c + 1; d < 10; d++)
    states.push([cells[a], cells[b], cells[c], cells[d]]);
const rolls = [];
for (let a = 1; a <= 6; a++) for (let b = 1; b <= 6; b++) rolls.push([a, b]);

function solve(successors) {                         // value iteration
  const V = new Map(states.map(s => [key(s), 0]));
  for (let it = 0; it < 10000; it++) {
    let delta = 0;
    for (const s of states) {
      if (done(s)) continue;
      const v = 1 + successors(s, V) / 36;
      delta = Math.max(delta, Math.abs(v - V.get(key(s))));
      V.set(key(s), v);
    }
    if (delta < 1e-10) break;
  }
  return V;
}

const outs = new Map(states.map(s => [key(s), rolls.map(([a, b]) => outcomes(s, a, b))]));
const E = solve((s, V) => outs.get(key(s)).reduce((sum, o) => sum + Math.min(...o.map(x => V.get(key(x)))), 0));

function robotPlay(s, a, b) {                        // what the robot does with roll (a, b)
  const g = createGame([{ name: 'a' }, { name: 'b' }], undefined, PLAYER);
  g.players[PLAYER].marbles.forEach((m, i) => {
    const c = s[i];
    Object.assign(m, isHome(c)
      ? { zone: 'home', slot: c - 100, space: null, starEligible: false }
      : { zone: 'track', space: c, slot: null, starEligible: false });
  });
  g.dice = [a, b]; g.diceUsed = [false, false]; g.phase = 'AWAITING_MOVE';
  for (let k = 0; k < 2 && g.winner == null; k++) {
    const mv = pickNextRobotMove(g, PLAYER);
    if (mv) applyMove(g, PLAYER, mv); else g.diceUsed[g.diceUsed[0] ? 1 : 0] = true;
  }
  return g.players[PLAYER].marbles.map(m => m.zone === 'home' ? 100 + m.slot : m.space);
}
const robotNext = new Map(states.map(s => [key(s), done(s) ? [] : rolls.map(([a, b]) => robotPlay(s, a, b))]));
const R = solve((s, V) => robotNext.get(key(s)).reduce((sum, o) => sum + V.get(key(o)), 0));

const fmt = s => `${name(s).padEnd(14)} perfect ${E.get(key(s)).toFixed(2)}   robot ${R.get(key(s)).toFixed(2)} rolls`;

if (opt('--position')) {
  const s = opt('--position').trim().split(/\s+/).map(t => t[0] === 'h' ? 100 + +t.slice(1) : +t);
  if (s.length !== 4 || !states.some(x => key(x) === key(s))) {
    console.error(`Position must be four distinct cells among ${TRACK.join(' ')} h1..h4`);
    process.exit(2);
  }
  console.log('Position: ' + fmt(s));
  if (opt('--roll')) {
    const [a, b] = opt('--roll').split('-').map(Number);
    const robot = key(robotPlay(s, a, b));
    console.log(`Roll ${a}-${b}:`);
    for (const o of outcomes(s, a, b).sort((x, y) => E.get(key(x)) - E.get(key(y)))) {
      console.log(`  → ${name(o).padEnd(14)} ${E.get(key(o)).toFixed(2)} rolls left (perfect play)${key(o) === robot ? '   ← robot' : ''}`);
    }
  }
} else {
  console.log(`Yellow, home entry ${ENTRY}; track squares ${TRACK[0]}–${ENTRY}, home h1–h4.\n`);
  console.log('Last marble alone, other three in h2 h3 h4:');
  for (let p = ENTRY; p >= TRACK[0]; p--) console.log('  ' + fmt([p, 102, 103, 104]));
  let sum = 0, n = 0;
  const gaps = [];
  for (const s of states) {
    if (done(s)) continue;
    const gap = R.get(key(s)) - E.get(key(s));
    sum += gap; n++; gaps.push([gap, s]);
  }
  gaps.sort((x, y) => y[0] - x[0]);
  console.log(`\nRobot vs perfect play over all ${n} positions: ${(sum / n).toFixed(2)} extra rolls on average`);
  console.log('Worst positions for the robot:');
  for (const [gap, s] of gaps.slice(0, 5)) console.log(`  +${gap.toFixed(2)}  ${fmt(s)}`);
}
