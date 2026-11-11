// commentary.js — live text commentary from the game's own events.
//
// The game reports what happens (rolls, hits, marbles home, hub trips, the
// standings after each move, the result); the commentator picks out the
// moments worth calling, words them from a pool of phrasings, and paces them:
// at most one line every couple of seconds, a bigger moment replacing a
// smaller one still waiting, stale chatter dropped. Lines come back through
// onLine(parts, level) where parts mixes plain strings and { player } tokens
// (so the page can show names with their colour), level 1–3 (3 = big moment).

const pick = a => a[Math.floor(Math.random() * a.length)];

export function createCommentator(onLine) {
  let players = [];            // [{ name, color }]
  let standing = [];           // [{ pips, home, base }] by seat
  let leader = null, leaderSince = 0, lastLeadCall = 0;
  let pending = null, lastSaid = 0, timer = null;
  const said = new Set();      // one-off calls already made this game ("final:2", "baggro:1", …)
  const hitBy = {};            // victim seat → last seat that hit them (for revenge)
  let sixRun = { pi: null, n: 0 };
  let started = 0;

  const P = pi => ({ player: pi });
  // Queue a line; a bigger moment replaces a smaller one still waiting.
  function say(level, ...parts) {
    if (pending && pending.level > level) return;
    pending = { level, parts, at: Date.now() };
    flush();
  }
  function flush() {
    const now = Date.now();
    if (!pending) return;
    if (now - pending.at > (pending.level >= 3 ? 9000 : 5000)) { pending = null; return; }   // old news
    const gap = pending.level >= 3 ? 1200 : 2400;
    if (now - lastSaid < gap) { clearTimeout(timer); timer = setTimeout(flush, gap - (now - lastSaid) + 20); return; }
    const p = pending; pending = null; lastSaid = now;
    onLine(p.parts, p.level);
  }

  return {
    // A new game: who's playing (and, for fun, the soundtrack).
    start(list, song) {
      players = list; standing = []; leader = null; said.clear(); sixRun = { pi: null, n: 0 };
      for (const k of Object.keys(hitBy)) delete hitBy[k];
      started = Date.now(); lastLeadCall = Date.now();
      pending = null;
      const n = list.length;
      say(2, pick([`A fresh ${n}-player race is under way`, `New game! ${n} marble racers on the grid`, `And they're off: ${n} players, 16 marbles… well, ${n * 4}`, `Here we go again: ${n} players, one winner`])
        + (song ? pick([`. Tonight's soundtrack: ${song}.`, ` to the sound of ${song}.`, `. Cue the music: ${song}.`]) : '.'));
    },

    roll(pi, dice) {
      if (!dice) return;
      const six = dice.includes(6);
      sixRun = six ? { pi, n: sixRun.pi === pi ? sixRun.n + 1 : 1 } : { pi: null, n: 0 };
      if (dice[0] === 6 && dice[1] === 6) return say(1, P(pi), pick([' rolls double sixes! And goes again.', ' with boxcars: double six!', ': 6-6, the dream roll.', ' finds double sixes. Lovely.']));
      if (dice[0] === 1 && dice[1] === 1) return say(1, P(pi), pick([' rolls snake eyes.', ': double ones. Not a lot to work with.', ' gets 1-1… tiny steps.']));
      if (sixRun.n === 3) return say(2, P(pi), pick([' is on fire: three sixes in a row!', ' keeps rolling sixes. Three straight!', ' — another six! That\'s three.']));
    },

    // byPi sent victimPi's marble back to base from `dist` squares short of home.
    hit(byPi, victimPi, dist) {
      const revenge = hitBy[byPi] === victimPi;
      hitBy[victimPi] = byPi;
      if (revenge) return say(3, P(byPi), pick([' gets revenge on ', ' pays back ', ' settles the score with ']), P(victimPi), pick(['!', '! Sweet revenge.', '. That one was personal.']));
      if (dist != null && dist <= 14) return say(3, pick(['Heartbreak! ', 'Ouch! ', 'Brutal! ', 'Oh no! ']), P(byPi), ' sends ', P(victimPi),
        pick([` back to base from just ${dist} squares out.`, ` home… to base, ${dist} squares from safety.`, ` all the way back, with home in sight (${dist} away).`]));
      return say(2, P(byPi), pick([' bumps ', ' knocks out ', ' clips ', ' bonks ', ' takes out ']), P(victimPi),
        pick(['!', '. Back to base.', '. Back to the start for that one.', '. Rude!', '. See you at the start!']));
    },

    // A marble reached home; `count` = how many that player now has home.
    home(pi, count) {
      if (count >= 4) return;   // the win line covers it
      if (count === 1 && !said.has('firstHome')) { said.add('firstHome'); return say(2, P(pi), pick([' gets the first marble home!', ' is first to put one home.', ' opens the scoring: one marble home.'])); }
      if (count === 3 && !said.has('final:' + pi)) { said.add('final:' + pi); return say(3, P(pi), pick([' has three home. One to go!', ' is on the final marble!', ': three down, one to go. Final lap!'])); }
      if (count === 1) return say(1, P(pi), pick([' gets a first marble home.', ' is on the board: one home.', ' finally gets one home.']));
      return say(1, P(pi), pick([` brings another one home: ${count} now.`, ` safely home: that's ${count}.`, ` tucks marble number ${count} away.`]));
    },

    hub(pi, into) {
      if (into) return say(1, P(pi), pick([' dives into the hub.', ' takes the shortcut through the centre.', ' parks in the hub, waiting for a 1.']));
      return say(1, P(pi), pick([' escapes the hub!', ' pops out of the hub.', ' finds the 1 and leaves the hub.']));
    },

    // Standings after a move: [{ pips, home, base }] by seat.
    update(list) {
      standing = list;
      if (!list.length || !players.length) return;
      const order = list.map((s, i) => ({ ...s, i })).sort((a, b) => a.pips - b.pips);
      const lead = order[0], second = order[1];
      const progress = Math.max(0, Math.min(1, (346 - lead.pips) / 326));
      const now = Date.now();
      // Lead changes: only once the race has shape, a clear gap, not every flicker.
      if (leader == null) { leader = lead.i; leaderSince = now; }
      else if (lead.i !== leader && progress > 0.15 && second && second.pips - lead.pips >= 4 && now - lastLeadCall > 15000) {
        const was = leader; leader = lead.i; leaderSince = now; lastLeadCall = now;
        return say(3, pick(['Lead change! ', 'New leader! ', 'And there\'s a new leader: ']), P(lead.i), pick([' moves ahead of ', ' passes ', ' overtakes ']), P(was), '.');
      } else if (lead.i !== leader) { leader = lead.i; leaderSince = now; }
      // Danger of an aggro / baggro for a trailing player.
      for (const s of order.slice(1)) {
        if (s.base === 4 && progress > 0.5 && !said.has('baggro:' + s.i)) { said.add('baggro:' + s.i); return say(2, P(s.i), pick([' still has all four in base… baggro alert!', ' hasn\'t left base yet. This could be a baggro!', ': four marbles, zero progress. Baggro watch.'])); }
        if (s.home === 0 && lead.home >= 3 && !said.has('aggro:' + s.i)) { said.add('aggro:' + s.i); return say(2, P(s.i), pick([' has nothing home yet. Aggro danger!', ' needs to get one home, fast, or it\'s an aggro.', ' still has an empty home row…'])); }
      }
      // A tight race late on.
      if (second && progress > 0.6 && second.pips - lead.pips <= 6 && !said.has('tight')) { said.add('tight'); return say(2, pick(['It\'s neck and neck between ', 'Too close to call: ', 'What a race! ']), P(lead.i), ' and ', P(second.i), '.'); }
      // A runaway leader.
      if (second && progress > 0.4 && second.pips - lead.pips >= 70 && !said.has('runaway')) { said.add('runaway'); return say(2, P(lead.i), pick([' is running away with this one.', ' has opened up a big lead.', ' is way out in front.'])); }
    },

    win(pi, result) {
      pending = null;
      const losers = result?.losers ?? [];
      const big = losers.filter(l => (l.mult ?? 1) >= 2);
      const tail = result?.dropped ? ' The double was dropped.'
        : big.length ? ' ' + big.map(l => [players[l.pi]?.name, l.mult === 3 ? 'a baggro' : 'an aggro']).map(([n, w]) => `${n} takes ${w}.`).join(' ')
        : '';
      say(3, P(pi), pick([' wins it!', ' takes the game!', ' crosses the line first!', ' — winner!']), tail);
    },

    note(text, level = 1) { say(level, text); },
  };
}
