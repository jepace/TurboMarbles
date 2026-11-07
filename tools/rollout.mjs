#!/usr/bin/env node
// Rollout analysis of a game log: for each roll where a player had a real
// choice, play every distinct way of playing that roll out to the end of the
// game many times (all players use the robot's strategy from then on) and
// compare win rates — the way gnubg "rolls out" positions it has no table for.
//
// Usage:
//   node tools/rollout.mjs <logfile> [--player <name>] [--games N] [--from T] [--to T]
//
//   --player  only analyse this player's rolls (default: every non-robot player)
//   --games   playouts per option (default 300; the ± printed is a 95% interval)
//   --from/--to  only turns in this range (by the log's turn numbers)
//
// Results are "win rate if everyone plays like the robot from here", so they
// measure the choice against robot-level play, and include bumps, shortcuts
// and luck (unlike tools/replay.mjs --analyze, which is exact but endgame-only
// and ignores bumps). Differences smaller than the ± are noise.
import { readFileSync } from 'fs';
import { createGame, allLegalMoves, applyMove, earnsExtraRoll, rollDice } from '../src/GameEngine.js';
import { locName, parseLocName, armOf } from '../public/js/constants.js';
let curArm = 0;     // squares in the log are in the mover's numbers
import { pickNextRobotMove } from '../src/RobotPlayer.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i === -1 ? def : args[i + 1]; };
const logFile = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
if (!logFile) { console.error('usage: node tools/rollout.mjs <logfile> [--player <name>] [--games N] [--from T] [--to T]'); process.exit(2); }
const N = +opt('--games', 300);
const FROM = +opt('--from', 0), TO = +opt('--to', Infinity);

const text = readFileSync(logFile, 'utf8');
const header = [...text.matchAll(/^\s+(\S.*?) \((\w+)\)$/gm)];
const names = header.map(m => m[1]);
const only = opt('--player', null);
const analysed = i => only ? names[i] === only : !/Robot/.test(names[i]);
const game = createGame(header.map((m, i) => ({ id: `p${i}`, name: m[1], color: m[2] })), undefined, 0);
const turns = [...text.matchAll(/^(\d+)\. (.+?): (\d)-(\d): (.+)$/gm)].map(m => ({
  n: +m[1], who: names.indexOf(m[2]), dice: [+m[3], +m[4]], moves: m[5].trim() }));

// --- log parsing / replay helpers (as in tools/replay.mjs) ---
const parseLoc = tok => parseLocName(tok, curArm) ?? { zone: 'track', space: -1 };
const at = (m, l) => m.zone === l.zone && (l.zone === 'track' ? m.space === l.space : l.zone === 'home' ? m.slot === l.slot : true);
const dest = mv => mv.toZone === 'home' ? { zone: 'home', slot: mv.toSlot } : mv.toZone === 'center' ? { zone: 'center' } : { zone: 'track', space: mv.toSpace };
const str = m => locName(m, curArm);
const keyOf = (g, pi) => g.players[pi].marbles.map(str).sort().join(' ');
// The whole position, ignoring which same-coloured marble is which: the
// player's marbles first, then every player's (bumps show up here).
const fullKey = (g, pi) => keyOf(g, pi) + '|' + g.players.map((_, i) => keyOf(g, i)).join('/');
const real = (g, pi, d) => (allLegalMoves(g, pi)[d] ?? []).filter(m => !m.optional);
function findSequence(g, who, segs, i = 0) {
  if (i === segs.length) return [];
  const legal = allLegalMoves(g, who);
  for (const mv of [0, 1].flatMap(d => legal[d] ?? []).filter(mv =>
    at(g.players[who].marbles[mv.marbleId], segs[i].from) && JSON.stringify(dest(mv)) === JSON.stringify(segs[i].to))) {
    const next = structuredClone(g); applyMove(next, who, mv);
    const rest = findSequence(next, who, segs, i + 1);
    if (rest) return [mv, ...rest];
  }
  return null;
}
// Every distinct way to play the current roll → resulting games, keyed by the
// player's marble positions (bumped opponents are part of the result).
function allPlays(g, pi) {
  const out = new Map();
  const add = gg => out.set(fullKey(gg, pi), gg);
  for (const d of [0, 1]) for (const m1 of real(g, pi, d)) {
    const g1 = structuredClone(g); applyMove(g1, pi, m1);
    const second = g1.winner != null ? [] : real(g1, pi, 1 - d);
    if (!second.length) { add(g1); continue; }
    for (const m2 of second) { const g2 = structuredClone(g1); applyMove(g2, pi, m2); add(g2); }
  }
  if (!out.size) add(structuredClone(g));
  return [...out.values()];
}
// Play out from just after `pi` finished playing a roll of `dice`.
function playout(g, pi, dice) {
  let turn = earnsExtraRoll(dice) ? pi : (pi + 1) % g.players.length;
  for (let t = 0; t < 4000 && g.winner == null; t++) {
    let again = true;
    while (again && g.winner == null) {
      g.dice = rollDice(); g.diceUsed = [false, false]; g.phase = 'AWAITING_MOVE';
      while (!(g.diceUsed[0] && g.diceUsed[1]) && g.winner == null) {
        const mv = pickNextRobotMove(g, turn);
        if (mv) applyMove(g, turn, mv); else g.diceUsed[g.diceUsed[0] ? 1 : 0] = true;
      }
      again = earnsExtraRoll(g.dice);
    }
    turn = (turn + 1) % g.players.length;
  }
  return g.winner;
}
const winRate = (g, pi, dice) => { let w = 0; for (let i = 0; i < N; i++) if (playout(structuredClone(g), pi, dice) === pi) w++; return w / N; };
const ci = p => 1.96 * Math.sqrt(Math.max(p * (1 - p), 0.0025) / N); // 95% half-width
const pct = p => `${(100 * p).toFixed(1)}%`;

console.log(`Rollouts: ${N} games per option, robot strategy for everyone afterwards.\n`);
const summary = new Map();
for (const t of turns) {
  game.turnIndex = t.who; game.dice = t.dice; game.diceUsed = [false, false]; game.phase = 'AWAITING_MOVE';
  curArm = Math.max(0, armOf(game.players[t.who].config));
  const segs = t.moves === '--' ? [] : t.moves.split(/\s+/).flatMap(p => { const k = p.split('/');
    return k.slice(1).map((tok, i) => ({ from: parseLoc(k[i]), to: parseLoc(tok) })); });
  const before = structuredClone(game);
  const plan = findSequence(game, t.who, segs) ?? [];
  for (const mv of plan) applyMove(game, t.who, mv);
  if (!analysed(t.who) || t.n < FROM || t.n > TO) continue;
  const plays = allPlays(before, t.who);
  if (plays.length < 2) continue;
  const playedKey = fullKey(game, t.who);
  const results = plays.map(g => ({ key: fullKey(g, t.who), label: keyOf(g, t.who), p: winRate(g, t.who, t.dice) }))
    .sort((a, b) => b.p - a.p);
  const mine = results.find(r => r.key === playedKey);
  const best = results[0];
  const loss = mine ? best.p - mine.p : 0;
  const significant = mine && loss > ci(best.p) + ci(mine.p);
  const s = summary.get(t.who) ?? { n: 0, errors: 0, lost: 0 };
  s.n++; if (significant) { s.errors++; s.lost += loss; } summary.set(t.who, s);
  const flag = !mine ? '?' : significant ? '✗' : '✓';
  console.log(`${flag} ${t.n}. ${names[t.who]} ${t.dice.join('-')}: played ${keyOf(game, t.who)} → ${mine ? pct(mine.p) : '?'}` +
    (significant ? `   best ${best.label} → ${pct(best.p)} (−${(100 * loss).toFixed(1)} pts)` : ''));
  for (const r of results.slice(0, 4)) {
    const bumps = r.key.split('|')[1] !== results[0].key.split('|')[1] && r.label === best.label ? ' (different bump)' : '';
    console.log(`      ${r.key === playedKey ? '→' : ' '} ${r.label.padEnd(18)} ${pct(r.p)} ± ${(100 * ci(r.p)).toFixed(1)}${bumps}`);
  }
}
console.log('\nSummary (✗ = clearly worse than the best option, beyond the ±):');
for (const [pi, s] of summary) console.log(`  ${names[pi]}: ${s.n} decisions, ${s.errors} clear mistakes, ${(100 * s.lost).toFixed(1)} win-rate points lost in total`);
