// EndgameTable.js — lookups into the precomputed endgame table
// (src/endgame-table.json, built by tools/build-endgame-table.mjs).
//
// A player is "in the table" when every marble is home or within the last
// REGION squares before its home entry, or in the hub. For such a player the
// table gives exact race values (no opponents / no bumps):
//   expectedTurns — turns needed to get all marbles home, under best play
//   finishedBy(n) — probability of being done within n turns
// and raceWinProbability combines those for several players.
import { readFileSync } from 'fs';
import { TRACK_SIZE } from './GameEngine.js';

const table = JSON.parse(readFileSync(new URL('./endgame-table.json', import.meta.url), 'utf8'));
export const REGION = table.region;
const HUB = table.hub, HOME = table.homeBase, NMAX = table.nmax;

// Cell code for one marble, or null if it is outside the table's region.
function cellOf(player, m) {
  if (m.zone === 'home')   return HOME + m.slot;
  if (m.zone === 'center') return HUB;
  if (m.zone === 'track') {
    const offset = (player.config.homeEntry - m.space + TRACK_SIZE) % TRACK_SIZE;
    return offset < REGION ? offset : null;
  }
  return null;                                    // base
}

// Table entry for a list of marbles (default: the player's current marbles),
// or null if any marble is outside the region.
export function lookup(player, marbles = player.marbles) {
  const cells = [];
  for (const m of marbles) {
    const c = cellOf(player, m);
    if (c === null) return null;
    cells.push(c);
  }
  return table.positions[cells.sort((a, b) => a - b).join(',')] ?? null;
}

// Expected turns to finish, counted from the start of a turn.
export const expectedTurns = entry => entry[0];

// P(all marbles home within n turns).
export function finishedBy(entry, n) {
  if (entry[0] === 0) return 1;
  if (n <= 0) return 0;
  return entry[Math.min(n, NMAX)];
}

// Probability that `me` wins the race. `me` is about to start a turn and the
// opponents take their turns after it, in order: `me` wins if it finishes in
// no more turns than every opponent. Each argument is a table entry.
export function raceWinProbability(me, opponents) {
  if (me[0] === 0) return 1;                      // already home
  let p = 0;
  for (let n = 1; n <= NMAX; n++) {
    const finishNow = finishedBy(me, n) - finishedBy(me, n - 1);
    if (finishNow <= 0) continue;
    let othersNotDone = 1;
    for (const o of opponents) othersNotDone *= 1 - finishedBy(o, n - 1);
    p += finishNow * othersNotDone;
  }
  return p;
}
