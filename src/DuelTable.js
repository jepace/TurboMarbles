// DuelTable.js — exact values for two-player endgames (see tools/build-duel-table.mjs).
//
// Two tables, each solved completely offline:
//   "11": both players down to their last marble, any home layout
//         (the three home marbles in any three slots).
//   "12": one player down to the last marble with h2–h4 filled, the other with
//         two marbles out and h3–h4 filled (and everything that follows from
//         there, e.g. one of the two going home).
// duelWinChance() gives the exact chance that a player wins with perfect play
// by both sides: racing, hitting, and waiting out of reach.
//
// A player's position is a key "mask|outs": mask = home slots taken (bit s−1
// for slot s), outs = sorted locations of the marbles not home:
// 0 = base, 1 = hub, 2–85 = track squares 1–84 (rotated so that the table's
// player A sits on arm 0). Player B sits `offset` arms further on.
import { readFileSync, existsSync } from 'fs';
import { gunzipSync } from 'zlib';

export const L = 86;
export function locIndex(m, rot = 0) {
  if (m.zone === 'base') return 0;
  if (m.zone === 'center') return 1;
  if (m.zone === 'track') return 1 + ((m.space - 1 - 14 * rot) % 84 + 84) % 84 + 1;
  return -1;                                   // home
}
export function playerKey(p, rot = 0) {
  let mask = 0;
  const outs = [];
  for (const m of p.marbles) {
    if (m.zone === 'home') mask |= 1 << (m.slot - 1);
    else outs.push(locIndex(m, rot));
  }
  outs.sort((a, b) => a - b);
  return `${mask}|${outs.join(',')}`;
}

const TABLES = ['11', '12'];
let loaded = null;
function load() {
  if (loaded) return loaded;
  loaded = {};
  for (const name of TABLES) {
    const file = new URL(`./duel-${name}.json.gz`, import.meta.url);
    if (!existsSync(file)) continue;           // not built: that table is off
    const raw = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8'));
    const t = { statesA: new Map(raw.statesA.map((k, i) => [k, i])), offsets: {} };
    for (const [k, o] of Object.entries(raw.offsets)) {
      const buf = Buffer.from(o.values, 'base64');
      t.offsets[k] = {
        statesB: new Map(o.statesB.map((key, i) => [key, i])),
        nB: o.statesB.length,
        V: new Uint16Array(buf.buffer, buf.byteOffset, buf.length / 2),
      };
    }
    loaded[name] = t;
  }
  return loaded;
}

const armOf = p => (p.config.start - 1) / 14;

// Chance that A (= player index `a` of the game) wins with `mover` to roll,
// from table `name` with A as the table's player A; null if not covered.
function lookupAs(name, game, a, mover) {
  const t = load()[name];
  if (!t) return null;
  const b = 1 - a;
  const ra = armOf(game.players[a]);
  const off = t.offsets[(armOf(game.players[b]) - ra + 6) % 6];
  if (!off) return null;
  const ia = t.statesA.get(playerKey(game.players[a], ra));
  const ib = off.statesB.get(playerKey(game.players[b], ra));
  if (ia == null || ib == null) return null;
  const nA = t.statesA.size;
  return off.V[(mover === a ? 0 : 1) * nA * off.nB + ia * off.nB + ib] / 65535;
}

// Chance that player `me` wins, with `mover` about to roll; null when no table
// covers the position. A finished game gives 1 or 0.
export function duelWinChance(game, me, mover) {
  if (game.players.length !== 2) return null;
  if (game.winner != null) return game.winner === me ? 1 : 0;
  for (const name of TABLES) {
    const v = lookupAs(name, game, me, mover);
    if (v != null) return v;
    const w = lookupAs(name, game, 1 - me, mover);
    if (w != null) return 1 - w;
  }
  return null;
}

export function isDuel(game) {
  return game.players.length === 2 && game.winner == null && duelWinChance(game, 0, game.turnIndex ?? 0) != null;
}
