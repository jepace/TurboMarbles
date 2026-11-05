#!/usr/bin/env node
// Replay a TurboMarbles game log (the text from the in-game "Copy Log" button)
// through the real rules engine and audit it.
//
// Usage:
//   node tools/replay.mjs <logfile> [--brief] [--analyze] [--robot <module>] [--dump <turn>:<dice> <out.json>]
//
//   --brief    print only rule issues, bumps, and robot moves that differ from
//              what the robot code would pick (omit the full decision list)
//   --analyze  endgame analysis: for every roll where the player's marbles are
//              all home or near home (within the endgame table), compare the
//              play with the best play by exact race values (expected turns to
//              finish, and race-win probability when every opponent is in the
//              table too). Race values ignore bumps.
//   --robot    robot module to compare against (default: src/RobotPlayer.js)
//   --dump     write the game state just before the given roll, e.g.
//              --dump 21:3-1 t21.json (useful for "what if" analysis)
//
// Checks: every move is legal, dice are used whenever a mandatory move exists,
// extra rolls only follow a 6, turn order, and the winner. For each robot move
// it reports whether the given robot code would have made the same choice.
import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { pathToFileURL } from 'url';
import { createGame, allLegalMoves, applyMove, earnsExtraRoll } from '../src/GameEngine.js';
import { spaceName, parseSpaceName } from '../public/js/constants.js';
import { lookup, expectedTurns, finishedBy, raceWinProbability } from '../src/EndgameTable.js';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i === -1 ? null : args.slice(i + 1); };
const logFile = args.find(a => !a.startsWith('--') && !isOptionValue(a));
function isOptionValue(a) {
  for (const [flag, n] of [['--robot', 1], ['--dump', 2]]) {
    const i = args.indexOf(flag);
    if (i !== -1 && args.slice(i + 1, i + 1 + n).includes(a)) return true;
  }
  return false;
}
if (!logFile) {
  console.error('usage: node tools/replay.mjs <logfile> [--brief] [--analyze] [--robot <module>] [--dump <turn>:<dice> <out.json>]');
  process.exit(2);
}
const brief = args.includes('--brief');
const analyze = args.includes('--analyze');
const robotPath = opt('--robot')?.[0];
const robotUrl = robotPath ? pathToFileURL(resolve(robotPath)).href : new URL('../src/RobotPlayer.js', import.meta.url).href;
const { pickNextRobotMove } = await import(robotUrl);
const [dumpAt, dumpFile] = opt('--dump') ?? [];

const text = readFileSync(logFile, 'utf8');
const playerLines = [...text.matchAll(/^\s+(\S.*?) \((\w+)\)$/gm)];
const names = playerLines.map(m => m[1]);
const players = playerLines.map((m, i) => ({ id: `p${i}`, name: m[1], color: m[2], isRobot: /Robot/.test(m[1]) }));
if (players.length < 2) { console.error('No "Players:" header found in the log.'); process.exit(2); }

// Player order = log header order; arms come from ARM_MAP, as on the server.
const game = createGame(players, undefined, 0);

const turns = [...text.matchAll(/^(\d+)\. (.+?): (\d)-(\d): (.+)$/gm)].map(m => ({
  n: +m[1], who: names.indexOf(m[2]), dice: [+m[3], +m[4]], moves: m[5].trim(),
}));

const issues = [];
const notes = [];

function parseLoc(tok) {
  tok = tok.replace('*', '');
  if (tok === 'base') return { zone: 'base' };
  if (tok === 'hub') return { zone: 'center' };
  const h = tok.match(/^h(\d)$/);
  if (h) return { zone: 'home', slot: +h[1] };
  return { zone: 'track', space: /^\d+$/.test(tok) ? +tok : parseSpaceName(tok) };
}
function at(m, loc) {
  if (m.zone !== loc.zone) return false;
  if (loc.zone === 'track') return m.space === loc.space;
  if (loc.zone === 'home') return m.slot === loc.slot;
  return true;
}
function dest(mv) {
  if (mv.toZone === 'home') return { zone: 'home', slot: mv.toSlot };
  if (mv.toZone === 'center') return { zone: 'center' };
  return { zone: 'track', space: mv.toSpace };
}
const locStr = l => l.zone === 'track' ? spaceName(l.space) : l.zone === 'home' ? `h${l.slot}` : l.zone === 'center' ? 'hub' : 'base';
const marbleStr = m => m.zone === 'track' ? spaceName(m.space) : m.zone === 'home' ? `h${m.slot}` : m.zone === 'center' ? 'hub' : 'base';
function describe(mv, pi) {
  const m = game.players[pi].marbles[mv.marbleId];
  return `${marbleStr(m)}→${locStr(dest(mv))} (die ${game.dice[mv.dieIndex]}${mv.optional ? ', optional' : ''})`;
}
function realMoves(pi) {
  const legal = allLegalMoves(game, pi);
  return [0, 1].flatMap(d => (legal[d] ?? []).filter(m => !m.optional));
}

// Several dice can produce the same move (a 1 or a 6 both leave base), and which
// die was used affects the rest of the roll. Search for an assignment of dice
// that makes every move of the roll legal, in order.
function matching(g, who, seg) {
  const legal = allLegalMoves(g, who);
  const pl = g.players[who];
  return [0, 1].flatMap(d => (legal[d] ?? [])).filter(mv =>
    at(pl.marbles[mv.marbleId], seg.from) && JSON.stringify(dest(mv)) === JSON.stringify(seg.to));
}
function findSequence(g, who, segs, i = 0) {
  if (i === segs.length) return [];
  for (const mv of matching(g, who, segs[i])) {
    const next = structuredClone(g);
    applyMove(next, who, mv);
    const rest = findSequence(next, who, segs, i + 1);
    if (rest) return [mv, ...rest];
  }
  return null;
}

// ---- Endgame analysis (--analyze) --------------------------------------------
const marblesKey = (g, pi) => g.players[pi].marbles.map(marbleStr).sort().join(' ');
// Every legal way to play the current roll (both dice, either order, a die
// used whenever it can be). Returns resulting games keyed by the player's
// marble positions.
function allPlays(g, pi) {
  const real = (gg, d) => (allLegalMoves(gg, pi)[d] ?? []).filter(m => !m.optional);
  const out = new Map();
  for (const d of [0, 1]) for (const m1 of real(g, d)) {
    const g1 = structuredClone(g); applyMove(g1, pi, m1);
    const second = g1.winner != null ? [] : real(g1, 1 - d);
    if (!second.length) { out.set(marblesKey(g1, pi), g1); continue; }
    for (const m2 of second) { const g2 = structuredClone(g1); applyMove(g2, pi, m2); out.set(marblesKey(g2, pi), g2); }
  }
  if (!out.size) out.set(marblesKey(g, pi), g);
  return out;
}
// Race value of a position right after a roll: expected turns still to play
// (a 6 continues the current turn), and — if every opponent is in the table —
// the probability of winning the race.
function raceValue(after, pi, six) {
  const me = lookup(after.players[pi]);
  if (!me) return null;
  const turns = expectedTurns(me) === 0 ? 0 : six ? expectedTurns(me) - 1 : expectedTurns(me);
  const opps = after.players.filter((_, o) => o !== pi).map(p => lookup(p));
  let win = null;
  if (opps.every(Boolean)) {
    if (expectedTurns(me) === 0) win = 1;
    // A 6: this player keeps rolling now. Otherwise everyone else plays first.
    else if (six) win = raceWinProbability(me, opps);
    else {
      win = 0;
      for (let n = 1; n <= 60; n++) {
        const pn = finishedBy(me, n) - finishedBy(me, n - 1);
        if (pn > 0) win += pn * opps.reduce((acc, o) => acc * (1 - finishedBy(o, n)), 1);
      }
    }
  }
  return { turns, win };
}
const analysis = [];               // { tag, who, played, best, cost, winPlayed, winBest, choices }

let prev = null;
let differ = 0;
for (const t of turns) {
  const tag = `${t.n}. ${names[t.who]} ${t.dice.join('-')}`;
  // Turn order: the same player rolls again only after a roll containing a 6.
  if (prev) {
    const want = earnsExtraRoll(prev.dice) ? prev.who : (prev.who + 1) % names.length;
    if (t.who !== want) issues.push(`${tag}: turn order — expected ${names[want]}`);
  }
  game.turnIndex = t.who;
  game.dice = t.dice;
  game.diceUsed = [false, false];
  game.phase = 'AWAITING_MOVE';

  const segs = t.moves === '--' ? [] : t.moves.split(/\s+/).flatMap(p => {
    const toks = p.split('/');
    return toks.slice(1).map((tok, i) => ({ from: parseLoc(toks[i]), to: parseLoc(tok), raw: `${toks[i]}→${tok}` }));
  });

  if (dumpAt === `${t.n}:${t.dice.join('-')}`) {
    writeFileSync(dumpFile, JSON.stringify(game));
    console.log(`(state before roll ${dumpAt} written to ${dumpFile})`);
  }
  let plays = null;
  if (analyze && lookup(game.players[t.who])) plays = allPlays(game, t.who);
  const plan = findSequence(game, t.who, segs);
  for (const [si, s] of segs.entries()) {
    const cands = matching(game, t.who, s);
    if (cands.length === 0) {
      const legal = allLegalMoves(game, t.who);
      issues.push(`${tag}: ILLEGAL ${s.raw} — legal were: ${[0, 1].flatMap(d => legal[d] ?? []).map(m => describe(m, t.who)).join('; ') || 'none'}`);
      break;
    }
    const mv = plan ? plan[si] : cands[0];
    if (players[t.who].isRobot) {
      const pick = pickNextRobotMove(game, t.who);
      const same = pick && pick.marbleId === mv.marbleId && JSON.stringify(dest(pick)) === JSON.stringify(dest(mv));
      if (!same) differ++;
      if (!brief || !same) {
        const opts = realMoves(t.who).map(m => describe(m, t.who));
        notes.push(`${tag}: robot played ${describe(mv, t.who)}${same ? '' : `  [robot code would pick: ${pick ? describe(pick, t.who) : 'forfeit'}]`}` +
          (brief ? '' : `\n      options: ${opts.join('; ')}`));
      }
    }
    if (mv.optional) notes.push(`${tag}: took the optional go-around ${s.raw}`);
    for (const e of applyMove(game, t.who, mv)) {
      if (e.event === 'marbleBumped') notes.push(`${tag}: ${s.raw} bumped ${names[e.ownerIndex]} back to base`);
    }
  }

  // A die left unused must have had no mandatory move.
  for (let d = 0; d < 2; d++) {
    if (game.diceUsed[d]) continue;
    const real = (allLegalMoves(game, t.who)[d] ?? []).filter(m => !m.optional);
    if (real.length) issues.push(`${tag}: die ${t.dice[d]} unused but had moves: ${real.map(m => describe(m, t.who)).join('; ')}`);
  }
  if (plays && plays.size > 1) {
    const six = t.dice.includes(6);
    const scored = [...plays].map(([k, g]) => ({ k, v: raceValue(g, t.who, six) })).filter(x => x.v);
    const played = marblesKey(game, t.who);
    const mine = scored.find(x => x.k === played);
    if (mine && scored.length > 1) {
      const best = scored.reduce((a, b) => (b.v.turns < a.v.turns ? b : a));
      analysis.push({ tag, who: t.who, played, best: best.k, cost: mine.v.turns - best.v.turns,
        winPlayed: mine.v.win, winBest: best.v.win, choices: scored.length });
    }
  }
  prev = t;
}

console.log('=== Final position ===');
game.players.forEach((p, i) => console.log(`  ${names[i]}: ${p.marbles.map(marbleStr).join(' ')}`));
console.log(`Winner per engine: ${game.winner != null ? names[game.winner] : 'none'}`);
console.log(`\n=== Rule issues (${issues.length}) ===`);
issues.forEach(i => console.log('  ' + i));
console.log(`\n=== Robot moves that differ from the robot code: ${differ} ===`);
console.log(`\n=== ${brief ? 'Bumps and differing robot moves' : 'Robot decisions and bumps'} ===`);
notes.forEach(n => console.log('  ' + n));

if (analyze) {
  const pct = x => x == null ? '' : `${(100 * x).toFixed(1)}%`;
  console.log('\n=== Endgame analysis (exact race values; bumps not counted) ===');
  console.log('Every roll where the player was in the endgame table and had a real choice.');
  console.log('cost = extra expected turns to finish versus the best play.\n');
  for (const a of analysis) {
    const win = a.winPlayed == null ? '' : `   race win ${pct(a.winPlayed)}${a.cost > 0.005 ? ` (best ${pct(a.winBest)})` : ''}`;
    const verdict = a.cost > 0.005 ? `→ ${a.played.padEnd(14)} cost +${a.cost.toFixed(2)} turns; best ${a.best}` : `→ ${a.played.padEnd(14)} best play`;
    console.log(`  ${a.tag.padEnd(22)} ${verdict}${win}`);
  }
  console.log('\nSummary:');
  names.forEach((n, i) => {
    const mine = analysis.filter(a => a.who === i);
    if (!mine.length) return;
    const errs = mine.filter(a => a.cost > 0.005);
    const lost = mine.reduce((s, a) => s + a.cost, 0);
    console.log(`  ${n.padEnd(10)} ${mine.length} endgame decisions, ${errs.length} not best, ${lost.toFixed(2)} turns lost in total`);
  });
}
