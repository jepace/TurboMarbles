// League tracker: robot games played through it (engine + robot, no server),
// checking careers, streaks, records, session table and the notes it sends.
import { createGame, applyMove, earnsExtraRoll, rollDice, skipDie, gameResult } from '../src/GameEngine.js';
import { pickNextRobotMove } from '../src/RobotPlayer.js';
import { LeagueTracker, leagueOverview } from '../src/LeagueTracker.js';
import * as store from '../src/Store.js';
import { TEAMS } from '../public/js/league.js';

let passed = 0, failed = 0;
const assert = (c, l) => { if (c) { console.log(`  ✓ ${l}`); passed++; } else { console.error(`  ✗ ${l}`); failed++; } };

const sent = [];
const room = { slots: ['Data', 'Worf', 'Kira', 'Odo'].map(name => ({ name })), game: null };
const lt = new LeagueTracker(room, { send: m => sent.push(m) });
const realSetTimeout = setTimeout; globalThis.setTimeout = (fn) => { fn(); return 0; };   // notes at once

function playGame() {
  room.game = createGame(room.slots.map(s => ({ name: s.name })), undefined, 0);
  const g = room.game, ev = m => lt.observe(m);
  ev({ event: 'gameStarted' });
  for (let t = 0; t < 3000 && g.winner == null; t++) {
    const pi = g.turnIndex; let again = true;
    while (again && g.winner == null) {
      g.dice = rollDice(); g.diceUsed = [false, false]; g.phase = 'AWAITING_MOVE';
      ev({ event: 'rolled', playerIndex: pi, dice: g.dice });
      while (!(g.diceUsed[0] && g.diceUsed[1]) && g.winner == null) {
        const mv = pickNextRobotMove(g, pi);
        if (mv) for (const e of applyMove(g, pi, mv)) ev(e); else skipDie(g, g.diceUsed[0] ? 1 : 0);
      }
      again = earnsExtraRoll(g.dice);
    }
    g.turnIndex = (pi + 1) % g.players.length;
  }
  ev({ event: 'gameResult', winnerIndex: g.winner, result: gameResult(g, g.winner) });
  return g.winner;
}

console.log('\nleague: six games of four teams');
const wins = {};
for (let i = 0; i < 6; i++) { const w = playGame(); const c = room.game.players[w].config.color; wins[c] = (wins[c] ?? 0) + 1; }
const colors = room.game.players.map(p => p.config.color);
const teams = colors.map(c => ({ c, ...store.leagueGet('team', c) }));
assert(teams.every(t => t.games === 6), 'every team played 6 games');
assert(teams.reduce((s, t) => s + t.wins, 0) === 6 && colors.every(c => (store.leagueGet('team', c).wins ?? 0) === (wins[c] ?? 0)), 'wins add up');
assert(teams.reduce((s, t) => s + t.points, 0) === 0, 'points are zero-sum');
const marbles = store.leagueAll('marble');
assert(marbles.length === 16 && marbles.every(m => m.games === 6), '16 marbles, each with 6 games');
const bonks = marbles.reduce((s, m) => s + (m.bonks ?? 0), 0), bonked = marbles.reduce((s, m) => s + (m.bonked ?? 0), 0);
assert(bonks === bonked && bonks > 0, `bonks dealt = bonks taken (${bonks})`);
assert(marbles.reduce((s, m) => s + (m.mvps ?? 0), 0) === 6, 'one marble of the game per game');
const recs = Object.fromEntries(store.leagueRecords().map(r => [r.k, r]));
assert(recs.longestGame && recs.mostBonksGame, 'records kept (longest game, most bonks)');
const notes = sent.filter(m => m.event === 'leagueNote').map(m => m.parts.map(x => typeof x === 'string' ? x : x.team ? TEAMS[x.team].short : x.marble ? TEAMS[x.marble[0]].marbles[x.marble[1]].name : x.coach).join(''));
assert(notes.some(n => n.startsWith('⭐ Marble of the game')), 'marble of the game announced');
assert(sent.some(m => m.event === 'leagueState' && m.teams?.length === 4 && m.teams[0].marbles.length === 4), 'state snapshots with teams and marbles');
const ov = leagueOverview();
assert(ov.teams.length === 6 && ov.marbles.length === 16 && ov.recent.length === 6, 'overview: all teams, marbles, recent games');
console.log('\n  sample notes:\n' + [...new Set(notes)].slice(0, 12).map(n => '    ' + n).join('\n'));
globalThis.setTimeout = realSetTimeout;
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed ? 1 : 0);
