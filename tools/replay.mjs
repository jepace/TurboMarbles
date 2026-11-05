#!/usr/bin/env node
// Replay a TurboMarbles game log (the text from the in-game "Copy Log" button)
// through the real rules engine and audit it.
//
// Usage:
//   node tools/replay.mjs <logfile> [--brief] [--robot <module>] [--dump <turn>:<dice> <out.json>]
//
//   --brief    print only rule issues, bumps, and robot moves that differ from
//              what the robot code would pick (omit the full decision list)
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
  console.error('usage: node tools/replay.mjs <logfile> [--brief] [--robot <module>] [--dump <turn>:<dice> <out.json>]');
  process.exit(2);
}
const brief = args.includes('--brief');
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
  return { zone: 'track', space: +tok };
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
const locStr = l => l.zone === 'track' ? String(l.space) : l.zone === 'home' ? `h${l.slot}` : l.zone === 'center' ? 'hub' : 'base';
const marbleStr = m => m.zone === 'track' ? String(m.space) : m.zone === 'home' ? `h${m.slot}` : m.zone === 'center' ? 'hub' : 'base';
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
