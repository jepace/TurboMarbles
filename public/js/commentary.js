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
  const mobile = {};           // seat → had full mobility (no marbles in base) at the last update
  const mobileOnce = new Set();// seats already celebrated for full mobility this game
  let rollNo = 0, lastHit = null;   // for double hits (two hits on one roll)
  const explained = { aggro: 0, baggro: 0 };   // when we last explained the term
  // Now and then (first time, then about one call in three, never twice within 2 minutes) explain the term.
  const explain = term => {
    const now = Date.now();
    if (now - explained[term] < 120000 || (explained[term] && Math.random() > 0.35)) return '';
    explained[term] = now;
    return term === 'aggro' ? pick([' (An aggro: losing with no marbles home costs double.)', ' (That\'s an aggro: lose with nothing home and you pay twice.)'])
      : pick([' (A baggro: losing with all four still in base costs triple!)', ' (Baggro = all four still in base at the end: triple the loss.)']);
  };
  // Home debt: exact rolls still needed to settle the home row (0 = tidy: filled from the top).
  const debt = slots => [...slots].sort((a, b) => b - a).reduce((d, slot, i) => d + (4 - i - slot), 0);

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
      for (const k of Object.keys(mobile)) delete mobile[k];
      mobileOnce.clear(); lastHit = null;
      started = Date.now(); lastLeadCall = Date.now();
      pending = null;
      const n = list.length;
      say(2, pick([`A fresh ${n}-player race is under way`, `New game! ${n} marble racers on the grid`, `And they're off: ${n} players, 16 marbles… well, ${n * 4}`, `Here we go again: ${n} players, one winner`])
        + (song ? pick([`. Tonight's soundtrack: ${song}.`, ` to the sound of ${song}.`, `. Cue the music: ${song}.`]) : '.'));
    },

    roll(pi, dice) {
      if (!dice) return;
      rollNo++;
      const six = dice.includes(6);
      sixRun = six ? { pi, n: sixRun.pi === pi ? sixRun.n + 1 : 1 } : { pi: null, n: 0 };
      if (dice[0] === 6 && dice[1] === 6) return say(1, P(pi), pick([' rolls double sixes! And goes again.', ' with boxcars: double six!', ': 6-6, the dream roll.', ' finds double sixes. Lovely.']));
      if (dice[0] === 1 && dice[1] === 1) return say(1, P(pi), pick([' rolls snake eyes.', ': double ones. Not a lot to work with.', ' gets 1-1… tiny steps.']));
      if (sixRun.n === 3) return say(2, P(pi), pick([' is on fire: three sixes in a row!', ' keeps rolling sixes. Three straight!', ' — another six! That\'s three.']));
    },

    // byPi sent victimPi's marble back to base from `dist` squares short of home.
    // The current roll's number (taken when a hit happens; the line comes later, after the animation).
    rollId() { return rollNo; },

    hit(byPi, victimPi, dist, roll = rollNo) {
      const revenge = hitBy[byPi] === victimPi;
      hitBy[victimPi] = byPi;
      // Two hits on the same roll: a double hit (one call for both).
      const double = lastHit && lastHit.roll === roll && lastHit.by === byPi;
      const first = lastHit?.victim;
      lastHit = { roll, by: byPi, victim: victimPi };
      if (double) {
        mobile[victimPi] = false;
        pending = null;
        return first === victimPi
          ? say(3, pick(['Double hit! ', 'Two for one! ', 'DOUBLE BONK! ']), P(byPi), ' sends two of ', P(victimPi), pick(['\'s marbles back to base!', '\'s marbles home to base in one roll!']))
          : say(3, pick(['Double hit! ', 'Two for one! ', 'DOUBLE BONK! ']), P(byPi), ' bonks ', P(first), ' and ', P(victimPi), pick([' on the same roll!', '. What a roll!', ' in one go!']));
      }
      if (revenge) return say(3, P(byPi), pick([' gets revenge on ', ' pays back ', ' settles the score with ']), P(victimPi), pick(['!', '! Sweet revenge.', '. That one was personal.']));
      if (dist != null && dist <= 14) return say(3, pick(['Heartbreak! ', 'Ouch! ', 'Brutal! ', 'Oh no! ', 'BONK! ']), P(byPi), ' sends ', P(victimPi),
        pick([` back to base from just ${dist} squares out.`, ` home… to base, ${dist} squares from safety.`, ` all the way back, with home in sight (${dist} away).`]));
      // Losing full mobility (every marble was out of base) is worth a word.
      if (mobile[victimPi] && Math.random() < 0.7) { mobile[victimPi] = false; return say(2, P(byPi), pick([' bonks ', ' bumps ']), P(victimPi), pick([', and there goes full mobility.', '. Full mobility lost, back to waiting for a 1 or 6.', '. So much for full mobility.'])); }
      return say(2, P(byPi), pick([' bumps ', ' bonks ', ' bonks ', ' knocks out ', ' clips ', ' takes out ']), P(victimPi),
        pick(['!', '. Bonk!', '. Back to base.', '. Back to the start for that one.', '. Rude!', '. See you at the start!']));
    },

    // A marble reached home; `count` = how many that player now has home,
    // `slots` = their home slots now (1 = h1 … 4 = h4).
    home(pi, count, slots = []) {
      if (count >= 4) return;   // the win line covers it
      const d = debt(slots);
      if (count >= 2 && d >= 2 && Math.random() < 0.9) return say(2, P(pi), pick([
        ` has ${count} home, but untidy: they'll need exact rolls to shuffle up. Risky.`,
        `'s home row is a bit messy: low marbles still need exact rolls.`,
        ` gets one in, low. Untidy homes can cost turns at the end.`]));
      if (count >= 2 && d === 0 && Math.random() < 0.7) return say(1, P(pi), pick([
        ` has ${count} home, nice and tidy.`, `: ${count} home, tidily packed from the top.`, ` keeps a tidy home row: ${count} in, no gaps.`]));
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
      // Everyone has a marble home: no aggros (or baggros) possible any more (home marbles can't be bumped).
      if (list.length > 1 && list.every(s => s.home >= 1) && !said.has('noAggro')) {
        said.add('noAggro');
        return say(2, pick(['Everyone has a marble home: aggros are off the table.', 'That\'s every player on the board at home. No aggros this game.',
          'All players have one home now, so nobody can lose an aggro.']));
      }
      // Full mobility: every marble out of base (and not all home yet).
      let mobilityCall = null;
      list.forEach((s, i) => {
        const full = s.base === 0 && s.home < 4;
        if (full && mobile[i] === false && mobilityCall == null) mobilityCall = i;
        mobile[i] = full;
      });
      // Celebrated the first time per player; regaining it later gets a short note now and then.
      if (mobilityCall != null && !mobileOnce.has(mobilityCall)) { mobileOnce.add(mobilityCall); return say(2, P(mobilityCall), pick([' has full mobility: every marble out of base!', ' gets the last marble out. Full mobility!', ': all marbles in play. Full mobility.'])); }
      if (mobilityCall != null && Math.random() < 0.3) return say(1, P(mobilityCall), pick([' is back to full mobility.', ' regains full mobility.']));
      // Danger of an aggro / baggro for a trailing player.
      for (const s of order.slice(1)) {
        if (s.base === 4 && progress > 0.5 && !said.has('baggro:' + s.i)) { said.add('baggro:' + s.i); return say(2, P(s.i), pick([' still has all four in base… baggro alert!', ' hasn\'t left base yet. This could be a baggro!', ': four marbles, zero progress. Baggro watch.']), explain('baggro')); }
        if (s.home === 0 && lead.home >= 3 && !said.has('aggro:' + s.i)) { said.add('aggro:' + s.i); return say(2, P(s.i), pick([' has nothing home yet. Aggro danger!', ' needs to get one home, fast, or it\'s an aggro.', ' still has an empty home row…']), explain('aggro')); }
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
          + explain(big.some(l => l.mult === 3) ? 'baggro' : 'aggro')
        : '';
      say(3, P(pi), pick([' wins it!', ' takes the game!', ' crosses the line first!', ' — winner!']), tail);
    },

    note(text, level = 1) { say(level, text); },
  };
}
