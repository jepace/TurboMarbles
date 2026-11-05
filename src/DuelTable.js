// DuelTable.js — exact values for the two-player last-marble duel.
//
// When both players of a two-player game have three marbles home in h2–h4 and
// one marble left, the game is small enough to solve completely (see
// tools/build-duel-table.mjs). duelWinChance() gives the exact chance that a
// player wins from such a position with perfect play by both sides: racing,
// hitting, and waiting out of reach until the other marble has gone past.
import { readFileSync, existsSync } from 'fs';

// Locations of a last marble: 0 = base, 1 = hub, 2–85 = track squares 1–84.
export const L = 86;
export const DONE = -1;
export function locIndex(m) {
  if (m.zone === 'base') return 0;
  if (m.zone === 'center') return 1;
  if (m.zone === 'track') return 1 + m.space;
  return DONE;                                 // home
}

let tables = null;
function load() {
  if (tables) return tables;
  const file = new URL('./duel-table.json', import.meta.url);
  tables = {};
  if (!existsSync(file)) return tables;        // not built yet: duel mode off
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  for (const [k, b64] of Object.entries(raw.tables)) {
    const buf = Buffer.from(b64, 'base64');
    tables[k] = new Uint16Array(buf.buffer, buf.byteOffset, buf.length / 2);
  }
  return tables;
}

const armOf = p => (p.config.start - 1) / 14;

// The marble a player still has out, if the player is in duel shape (three
// marbles in h2–h4, one elsewhere); otherwise null.
function lastMarble(p) {
  const home = p.marbles.filter(m => m.zone === 'home');
  if (home.length !== 3) return null;
  const slots = home.map(m => m.slot).sort().join('');
  if (slots !== '234') return null;
  return p.marbles.find(m => m.zone !== 'home');
}

export function isDuel(game) {
  return game.players.length === 2 && game.winner == null &&
    !!lastMarble(game.players[0]) && !!lastMarble(game.players[1]) && !!load()[1];
}

// Chance that player `me` wins, with `mover` about to roll. Null when the
// position isn't a duel. A finished game gives 1 or 0.
export function duelWinChance(game, me, mover) {
  if (game.players.length !== 2) return null;
  if (game.winner != null) return game.winner === me ? 1 : 0;
  if (!isDuel(game)) return null;
  const opp = 1 - me;
  const am = armOf(game.players[me]), ao = armOf(game.players[opp]);
  const k = (ao - am + 6) % 6;
  const t = load()[k];
  if (!t) return null;
  const rot = loc => {
    const i = locIndex(loc);
    if (i < 2) return i;
    const s = ((loc.space - 1 - 14 * am) % 84 + 84) % 84 + 1;
    return 1 + s;
  };
  const a = rot(lastMarble(game.players[me])), b = rot(lastMarble(game.players[opp]));
  const v = t[(mover === me ? 0 : 1) * L * L + a * L + b] / 65535;
  return v;
}
