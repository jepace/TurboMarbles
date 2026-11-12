// LeagueTracker.js — turns robot stream games into a sport.
//
// One per robot watch room. It sees every broadcast (like the AI commentator)
// and keeps the game's numbers for each team (colour; the team is the player,
// seat) and marble (TEAMS in public/js/league.js): bonks dealt and taken,
// marbles home and in what order, hub trips and turns stuck there, rolls,
// sixes and doubles (luck), the lead (changes, wire-to-wire, the biggest
// deficit a winner came back from), the finish margin and the game's length.
// At the end it writes careers, streaks, rivalries, the month's season table
// and all-time records to the store, keeps the room's session table, and
// sends notable facts to the room as { event: 'leagueNote', level, parts }
// (parts: strings and { team }, { marble: [color, id] } tokens),
// plus { event: 'leagueState' } snapshots for the page.
import { TEAMS, marbleName, teamName, teamShort, LEAGUE_NAME, captainOf } from '../public/js/league.js';
import { pipCount, PLAYER_CONFIG, ALL_STARS } from '../public/js/constants.js';
import * as store from './Store.js';

const START_PIPS = 346;
const armOf = color => PLAYER_CONFIG.findIndex(c => c.color === color);
const season = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);   // '2026-11'
const ord = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');

export class LeagueTracker {
  constructor(room, { send }) {
    this.room = room;
    this.send = send;
    this.session = { games: 0, teams: {}, rivals: {}, startedAt: Date.now() };   // this room's session
    this.g = null;
  }

  colorOf(pi) { return this.room.game?.players[pi]?.color; }   // the team (not the seat)
  note(level, ...parts) { this.send({ event: 'leagueNote', level, parts }); }

  // ---- live game ----
  observe(msg) {
    const g = this.g, game = this.room.game;
    switch (msg.event) {
      case 'gameStarted': return this.start();
      case 'rolled': {
        if (!g) return;
        const t = g.teams[this.colorOf(msg.playerIndex)];
        if (!t) return;
        g.dice = msg.dice;
        g.rolls++; t.rolls++; t.sixes += msg.dice.filter(d => d === 6).length; if (msg.dice[0] === msg.dice[1]) t.doubles++;
        // Stuck in the hub: a turn starting with a marble there.
        const inHub = game?.players[msg.playerIndex]?.marbles.findIndex(m => m.zone === 'center') ?? -1;
        g.waitingInHub = inHub >= 0 ? `${t.color}:${inHub}` : null;
        if (inHub >= 0) { t.hubTurns++; g.marbles[`${t.color}:${inHub}`].hubTurns++; }
        // Luck: far more sixes than expected (1/3 a roll), once per game.
        if (t.rolls >= 12 && t.sixes >= t.rolls * 0.6 && !g.said.has('lucky:' + t.color)) { g.said.add('lucky:' + t.color); this.note(1, { team: t.color }, ` have rolled ${t.sixes} sixes in ${t.rolls} rolls. That's nearly double their share!`); }
        if (t.hubTurns === 5 && !g.said.has('hub:' + t.color)) { g.said.add('hub:' + t.color); this.note(1, { team: t.color }, ' have spent five turns stuck in the hub now.'); }
        return;
      }
      case 'marbleMoved': {
        if (!g) return;
        const color = this.colorOf(msg.playerIndex), m = g.marbles[`${color}:${msg.marbleId}`];
        g.lastMover = { color, id: msg.marbleId };
        // Spaces travelled: the die the move used.
        const steps = g.dice?.[msg.dieIndex] ?? 0;
        if (m) { m.distance += steps; g.teams[color].distance += steps; }
        if (m && steps) {
          const career = (store.leagueGet('marble', `${color}:${msg.marbleId}`).distance ?? 0) + m.distance, before = career - steps;
          if (Math.floor(career / 1000) > Math.floor(before / 1000)) this.note(2, { marble: [color, msg.marbleId] }, ` passes ${(Math.floor(career / 1000) * 1000).toLocaleString('en')} career spaces!`);
        }
        if (m && msg.from?.zone === 'base') {
          m.exits++;
          if (m.exits === 4 || m.exits === 6) this.note(1, { marble: [color, msg.marbleId] }, pick([` leaves base for the ${ord(m.exits)} time this game. Never gives up!`, ` is back out of base: that's ${m.exits} times now.`]));
        }
        if (m && msg.to?.zone === 'center') m.hubTrips++;
        // Star circle: the hops from star to star at the start of the path (only from a star).
        if (m && msg.from?.zone === 'track' && ALL_STARS.has(msg.from.space)) {
          let hops = 0;
          for (const p of msg.path ?? []) { if (p.zone === 'track' && ALL_STARS.has(p.space)) hops++; else break; }
          if (hops) { m.starSpaces += hops; g.teams[color].starSpaces += hops; }
        }
        // Leaving the hub: after how long?
        if (m && msg.from?.zone === 'center') {
          // An escape after waiting there (the rate is escapes / rolls spent waiting); in and out on one roll is a pass-through.
          if (g.waitingInHub === `${color}:${msg.marbleId}`) m.hubExits++; else m.hubPassThrough++;
          if (m.hubTurns >= 3 && !g.said.has('escape:' + color + msg.marbleId + m.hubExits)) { g.said.add('escape:' + color + msg.marbleId + m.hubExits); this.note(1, { marble: [color, msg.marbleId] }, ` finally escapes the hub after ${m.hubTurns} turns waiting!`); }
        }
        // Crossing its own home line and going round again.
        const entry = this.room.game?.players[msg.playerIndex]?.config.homeEntry;
        // (It stepped on its home entry square on the way and ended up out on the track beyond it.)
        if (m && msg.to?.zone === 'track' && msg.to.space !== entry && (msg.from?.space === entry || (msg.path ?? []).slice(0, -1).some(p => p.zone === 'track' && p.space === entry))) {
          m.goArounds++;
          if (Math.random() < 0.6) this.note(1, { marble: [color, msg.marbleId] }, pick([' crosses the home line and goes round again!', ' skips home and takes another lap.', ' rolls straight past home. Another lap!']));
        }
        if (m && msg.to?.zone === 'home' && msg.from?.zone !== 'home') {
          m.homeOrder = ++g.homes;
          if (g.homes === 1) m.firstHome = true;
        }
        return this.standings();
      }
      case 'marbleBumped': {
        if (!g) return;
        // The engine reports the bump before the attacker's move: the attacker is
        // the mover's marble now standing where the victim was.
        const victimColor = this.colorOf(msg.ownerIndex), by = attackerOf(game, msg.from);
        const vm = g.marbles[`${victimColor}:${msg.marbleId}`], bm = by && g.marbles[`${by.color}:${by.id}`];
        g.bonks++;
        if (vm) vm.bonked++;
        if (bm) bm.bonks++;
        const inHub = msg.from?.zone === 'center', onStar = msg.from?.zone === 'track' && ALL_STARS.has(msg.from.space);
        if (bm && inHub) bm.hubHits++;
        if (bm && onStar) bm.circleHits++;
        if (by) {
          g.teams[by.color].bonks++; g.teams[victimColor].bonked++;
          const pair = [by.color, victimColor].sort().join('|');
          g.rivals[pair] = (g.rivals[pair] ?? 0) + 1;
          this.session.rivals[pair] = (this.session.rivals[pair] ?? 0) + 1;
          const r = this.session.rivals[pair];
          if ((r === 5 || r % 10 === 0) && !g.said.has('rival:' + pair + r)) { g.said.add('rival:' + pair + r); this.note(2, 'Rivalry watch: ', { team: by.color }, ' and ', { team: victimColor }, ` have traded ${r} bonks this session.`); }
          const career = (store.leagueGet('marble', `${by.color}:${by.id}`).bonks ?? 0) + bm.bonks;
          if (career > 0 && career % 25 === 0) this.note(2, { marble: [by.color, by.id] }, ` lands career bonk number ${career}!`);
        }
        return this.standings();
      }
      case 'gameResult': return this.finish(msg);
    }
  }

  start() {
    const game = this.room.game;
    if (!game) return;
    const teams = {}, marbles = {};
    game.players.forEach((p, pi) => {
      const color = p.color;
      teams[color] = { color, pi, distance: 0, starSpaces: 0, rolls: 0, sixes: 0, doubles: 0, hubTurns: 0, bonks: 0, bonked: 0, maxDeficit: 0, ledEver: false, lostLead: false };
      p.marbles.forEach((_, id) => { marbles[`${color}:${id}`] = { color, id, distance: 0, starSpaces: 0, hubTurns: 0, hubExits: 0, hubPassThrough: 0, goArounds: 0, hubHits: 0, circleHits: 0, bonks: 0, bonked: 0, exits: 0, hubTrips: 0, homeOrder: null, firstHome: false }; });
    });
    this.g = { at: Date.now(), teams, marbles, rolls: 0, bonks: 0, homes: 0, leader: null, leadChanges: 0, said: new Set(), rivals: {} };
    this.sendState();
    // Coach matchups and streaks worth a word.
    const notes = [];
    for (const t of Object.values(teams)) {
      const s = store.leagueGet('team', t.color);
      if ((s.streak ?? 0) >= 3) notes.push([2, { team: t.color }, ` come in on a ${s.streak}-game winning streak.`]);
      if ((s.lossStreak ?? 0) >= 6) notes.push([1, { team: t.color }, ` haven't won in ${s.lossStreak} games. Can captain `, { marble: [t.color, captainOf(t.color)] }, ' turn it around?']);
    }
    // One team in the spotlight: its captain and record.
    const spot = Object.values(teams)[Math.floor(Math.random() * Object.keys(teams).length)], tm = spot && TEAMS[spot.color];
    if (tm) {
      const rec = store.leagueGet('team', spot.color), cap = captainOf(spot.color);
      notes.push([1, { team: spot.color }, ' are led by captain ', { marble: [spot.color, cap] }, '.',
        rec.games ? ` ${rec.wins ?? 0} wins from ${rec.games} so far.` : '', ` "${tm.marbles[cap]?.cheer ?? ''}"`]);
    }
    notes.slice(0, 3).forEach((n, i) => setTimeout(() => this.note(...n), 4000 + i * 5000));
  }

  standings() {
    const game = this.room.game, g = this.g;
    if (!game || !g) return;
    const pips = game.players.map(p => ({ color: p.color, pips: pipCount(armOf(p.config.color), p.marbles) }));
    const order = [...pips].sort((a, b) => a.pips - b.pips), lead = order[0];
    const progress = (START_PIPS - lead.pips) / START_PIPS;
    for (const x of pips) { const t = g.teams[x.color]; t.maxDeficit = Math.max(t.maxDeficit, x.pips - lead.pips); }
    if (progress > 0.12) {
      if (g.leader && lead.color !== g.leader) {
        g.leadChanges++; g.teams[g.leader].lostLead = true;
        if ([5, 8, 12].includes(g.leadChanges)) this.note(1, `That's ${g.leadChanges} lead changes already. What a game!`);
      }
      g.leader = lead.color; g.teams[lead.color].ledEver = true;
    }
  }

  // ---- end of game: careers, streaks, records, season, notes ----
  finish(msg) {
    const g = this.g, game = this.room.game;
    if (!g || !game || msg.winnerIndex == null) return;
    this.g = null;
    const wColor = this.colorOf(msg.winnerIndex), w = g.teams[wColor];
    const turns = g.rolls, ms = Date.now() - g.at, n = game.players.length;
    const pts = {};   // points this game by colour
    const losers = msg.result?.losers ?? game.players.map((_, i) => ({ pi: i, points: msg.result?.points ?? 1, mult: 1 })).filter(l => l.pi !== msg.winnerIndex);
    for (const l of losers) { pts[this.colorOf(l.pi)] = -(l.points ?? 1); }
    pts[wColor] = losers.reduce((s, l) => s + (l.points ?? 1), 0);
    const pipsLeft = game.players.map(p => ({ color: p.color, pips: pipCount(armOf(p.config.color), p.marbles) })).filter(x => x.color !== wColor).sort((a, b) => a.pips - b.pips);
    const margin = pipsLeft[0]?.pips ?? 0;
    const wire = w.ledEver && !w.lostLead;
    const notes = [];
    let aggroed = null;

    // MVP: bonks count most, first home and homes help; the winners get a nudge.
    const mvp = Object.values(g.marbles).map(m => ({ m, score: m.bonks * 3 + (m.firstHome ? 3 : 0) + (m.homeOrder ? 1 : 0) - m.bonked + (m.color === wColor ? 2 : 0) }))
      .sort((a, b) => b.score - a.score)[0]?.m;

    // Careers.
    const mon = season();
    for (const t of Object.values(g.teams)) {
      const won = t.color === wColor, big = losers.find(l => this.colorOf(l.pi) === t.color)?.mult ?? 1;
      const before = store.leagueGet('team', t.color);
      const streak = won ? (before.streak ?? 0) + 1 : 0, lossStreak = won ? 0 : (before.lossStreak ?? 0) + 1;
      const tm = Object.values(g.marbles).filter(m => m.color === t.color), sum = k => tm.reduce((x, m) => x + m[k], 0);
      store.leagueAdd('team', t.color, { distance: t.distance, starSpaces: t.starSpaces, hubTrips: sum('hubTrips'), hubExits: sum('hubExits'), hubWaits: sum('hubTurns'), exits: sum('exits'), goArounds: sum('goArounds'), hubHits: sum('hubHits'), circleHits: sum('circleHits'), games: 1, wins: won ? 1 : 0, points: pts[t.color] ?? 0, bonks: t.bonks, bonked: t.bonked, rolls: t.rolls, sixes: t.sixes, doubles: t.doubles, hubTurns: t.hubTurns,
        aggrosTaken: big === 2 ? 1 : 0, baggrosTaken: big === 3 ? 1 : 0, wireToWire: won && wire ? 1 : 0, comebacks: won && t.maxDeficit >= 60 ? 1 : 0 });
      store.leagueSet('team', t.color, { streak, lossStreak, bestStreak: Math.max(before.bestStreak ?? 0, streak) });
      store.leagueAdd('season:' + mon, t.color, { games: 1, wins: won ? 1 : 0, points: pts[t.color] ?? 0, bonks: t.bonks });
      // How often each pair of teams has met this month (for fair line-ups).
      for (const o of Object.keys(g.teams)) if (o > t.color) store.leagueAdd('meets:' + mon, `${t.color}|${o}`, { games: 1 });
      // Session table.
      const st = (this.session.teams[t.color] ??= { wins: 0, points: 0, games: 0, bonks: 0 });
      st.games++; st.wins += won ? 1 : 0; st.points += pts[t.color] ?? 0; st.bonks += t.bonks;
      if (won && streak >= 3) notes.push([2, { team: t.color }, ` have now won ${streak} in a row!`]);
      if (won && (before.lossStreak ?? 0) >= 5) notes.push([2, { team: t.color }, ` end a ${before.lossStreak}-game drought!`]);
      if (!won && (before.streak ?? 0) >= 3) notes.push([2, 'That ends the ', { team: t.color }, `' ${before.streak}-game winning streak.`]);
      if (big === 2) (aggroed ??= []).push(t.color);
      if (big === 3) notes.push([2, { team: wColor }, ' win a baggro over ', { team: t.color }, ': they never left base!']);
    }
    if (aggroed?.length === 1) notes.push([1, { team: wColor }, pick([' win an aggro over ', ' take an aggro off ']), { team: aggroed[0] }, ': not one marble home.']);
    else if (aggroed?.length > 1) notes.push([1, { team: wColor }, ' win aggros over ', ...aggroed.flatMap((c, i) => [i ? (i === aggroed.length - 1 ? ' and ' : ', ') : '', { team: c }]), ': nothing home.']);
    for (const m of Object.values(g.marbles)) {
      store.leagueAdd('marble', `${m.color}:${m.id}`, { distance: m.distance, starSpaces: m.starSpaces, hubTurns: m.hubTurns, hubExits: m.hubExits, hubPassThrough: m.hubPassThrough, goArounds: m.goArounds, hubHits: m.hubHits, circleHits: m.circleHits, games: 1, bonks: m.bonks, bonked: m.bonked, exits: m.exits, hubTrips: m.hubTrips, homes: m.homeOrder ? 1 : 0, firstHomes: m.firstHome ? 1 : 0, mvps: mvp === m ? 1 : 0, wins: m.color === wColor ? 1 : 0 });
    }
    for (const [pair, c] of Object.entries(g.rivals)) store.leagueAdd('rival', pair, { bonks: c });
    this.session.games++;

    // Records (all-time).
    // Records are kept from the first game, but only announced once the league has some history.
    store.leagueAdd('league', 'all', { games: 1 });
    const seasoned = (store.leagueGet('league', 'all').games ?? 0) > 20;
    const rec = (k, v, holder, detail, label, opts) => {
      const r = store.leagueRecord(k, v, holder, detail, opts);
      if (r && !r.first && seasoned) notes.push([3, '🏅 NEW RECORD! ', label, r.previous != null ? ` (was ${r.previous})` : '', '.']);
    };
    const topBonker = Object.values(g.marbles).sort((a, b) => b.bonks - a.bonks)[0];
    if (topBonker?.bonks >= 2) rec('mostBonksMarbleGame', topBonker.bonks, `${topBonker.color}:${topBonker.id}`, `${marbleName(topBonker.color, topBonker.id)} (${teamName(topBonker.color)})`,
      `${marbleName(topBonker.color, topBonker.id)} with ${topBonker.bonks} bonks in one game`);
    if (g.bonks) rec('mostBonksGame', g.bonks, wColor, `${n}-player game won by ${teamName(wColor)}`, `${g.bonks} bonks in a single game`);
    if (w.maxDeficit >= 30) rec('biggestComeback', w.maxDeficit, wColor, `${teamName(wColor)}`, `the biggest comeback: ${teamName(wColor)} from ${w.maxDeficit} pips behind`);
    rec('longestGame', turns, wColor, `${turns} rolls, ${Math.round(ms / 60000)} min`, `the longest game: ${turns} rolls`);
    if (margin > 0 && margin <= 40) rec('closestFinish', margin, wColor, `${teamName(wColor)} by ${margin} pips`, `the closest finish: ${margin} pips`, { lowerIsBetter: true });
    const tw = store.leagueGet('team', wColor);
    if ((tw.streak ?? 0) >= 2) rec('longestStreak', tw.streak, wColor, `${teamName(wColor)}`, `${teamName(wColor)} with ${tw.streak} straight wins`);
    const roamer = Object.values(g.marbles).sort((a, b) => b.distance - a.distance)[0];
    if (roamer?.distance) rec('mostDistanceGame', roamer.distance, `${roamer.color}:${roamer.id}`, `${marbleName(roamer.color, roamer.id)} (${teamName(roamer.color)})`,
      `${marbleName(roamer.color, roamer.id)} travelled ${roamer.distance} spaces in one game`);
    const luckiest = Object.values(g.teams).sort((a, b) => b.sixes - a.sixes)[0];
    if (luckiest?.sixes >= 5) rec('mostSixesGame', luckiest.sixes, luckiest.color, `${teamName(luckiest.color)}`, `${teamName(luckiest.color)} with ${luckiest.sixes} sixes in one game`);

    // The story of the game.
    if (w.maxDeficit >= 60) notes.unshift([3, 'What a comeback! ', { team: wColor }, ` were ${w.maxDeficit} pips behind at one point.`]);
    else if (wire && g.leadChanges === 0) notes.unshift([2, 'Wire to wire for ', { team: wColor }, '!']);
    if (margin > 0 && margin <= 8) notes.push([2, `Won by just ${margin} pip${margin === 1 ? '' : 's'}!`]);
    if (g.leadChanges >= 6) notes.push([1, `${g.leadChanges} lead changes in that one. A classic.`]);
    if (roamer && roamer.distance >= 150 && Math.random() < 0.5) notes.push([1, 'The workhorse: ', { marble: [roamer.color, roamer.id] }, ` covered ${roamer.distance} spaces.`]);
    if (mvp) notes.push([2, '⭐ Marble of the game: ', { marble: [mvp.color, mvp.id] }, mvpWhy(mvp), '.']);
    const lead = Object.entries(this.session.teams).sort((a, b) => b[1].wins - a[1].wins || b[1].points - a[1].points)[0];
    if (lead && this.session.games >= 3) notes.push([1, { team: lead[0] }, ` lead the session with ${lead[1].wins} win${lead[1].wins === 1 ? '' : 's'} from ${this.session.games} games.`]);

    store.leagueLogGame({ players: n, winner: wColor, coach: null, summary: {
      turns, ms, bonks: g.bonks, margin, leadChanges: g.leadChanges, deficit: w.maxDeficit, wire, mvp: mvp ? `${mvp.color}:${mvp.id}` : null,
      teams: Object.values(g.teams).map(t => ({ color: t.color, points: pts[t.color] ?? 0, bonks: t.bonks, sixes: t.sixes, distance: t.distance })) } });

    this.sendState({ mvp: mvp ? [mvp.color, mvp.id] : null, gamePoints: pts });
    // Spread the notes out after the win line.
    notes.slice(0, 5).forEach((nt, i) => setTimeout(() => this.note(...nt), 2500 + i * 2600));
  }

  // Snapshot for the page: teams in this game, with session and season numbers.
  state() {
    const game = this.room.game, mon = season();
    if (!game) return null;
    return {
      season: mon,
      teams: game.players.map((p, pi) => {
        const c = p.color, career = store.leagueGet('team', c), sea = store.leagueGet('season:' + mon, c);
        return { color: c, name: teamName(c), short: teamShort(c), emoji: TEAMS[c]?.emoji, captain: captainOf(c),
          marbles: (TEAMS[c]?.marbles ?? []).map(m => m.name),
          session: this.session.teams[c] ?? { wins: 0, points: 0, games: 0, bonks: 0 },
          season: { wins: sea.wins ?? 0, points: sea.points ?? 0, games: sea.games ?? 0 },
          streak: career.streak ?? 0 };
      }),
      sessionGames: this.session.games,
      // The month's table, all six teams (the line-up changes every game).
      table: Object.keys(TEAMS).map(c => {
        const sea = store.leagueGet('season:' + mon, c), ses = this.session.teams[c];
        return { color: c, games: sea.games ?? 0, wins: sea.wins ?? 0, points: sea.points ?? 0,
          sessionGames: ses?.games ?? 0, sessionWins: ses?.wins ?? 0, sessionPoints: ses?.points ?? 0 };
      }).sort((a, b) => b.points - a.points || b.wins - a.wins || a.games - b.games),
    };
  }
  sendState(extra = {}) { const s = this.state(); if (s) this.send({ event: 'leagueState', ...s, ...extra }); }
}

// The next line-up of n teams, for a fair season: the teams that have played
// the fewest games this month go first, and among them the pairs that have met
// least (ties at random). Six teams: everyone plays.
export function pickLineup(n) {
  const mon = season(), all = Object.keys(TEAMS);
  const games = Object.fromEntries(all.map(c => [c, store.leagueGet('season:' + mon, c).games ?? 0]));
  const meets = (a, b) => store.leagueGet('meets:' + mon, a < b ? `${a}|${b}` : `${b}|${a}`).games ?? 0;
  const pick = [];
  const pool = all.map(c => ({ c, r: Math.random() }));
  while (pick.length < Math.min(n, all.length)) {
    let best = null, bestKey = Infinity;
    for (const { c, r } of pool) {
      if (pick.includes(c)) continue;
      const key = games[c] * 1000 + pick.reduce((s, o) => s + meets(c, o), 0) * 10 + r;
      if (key < bestKey) { bestKey = key; best = c; }
    }
    pick.push(best);
  }
  return pick.sort(() => Math.random() - 0.5);   // random seats
}

function attackerOf(game, from) {
  const pi = game?.turnIndex, p = game?.players[pi];
  if (!p || !from) return null;
  const id = p.marbles.findIndex(m => m.zone === from.zone && (from.zone === 'center' || m.space === from.space));
  return id >= 0 ? { color: p.color, id } : null;
}

function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
function mvpWhy(m) {
  const bits = [];
  if (m.bonks) bits.push(`${m.bonks} bonk${m.bonks === 1 ? '' : 's'}`);
  if (m.firstHome) bits.push('first home');
  else if (m.homeOrder) bits.push(`home ${ord(m.homeOrder)}`);
  return bits.length ? ` (${bits.join(', ')})` : '';
}

// ---- The League page: all-time tables (public, read only) ----
export function leagueOverview() {
  const mon = season();
  const teams = Object.keys(TEAMS).map(c => {
    const t = store.leagueGet('team', c), s = store.leagueGet('season:' + mon, c);
    const cap = captainOf(c);
    return { color: c, name: teamName(c), emoji: TEAMS[c].emoji, captain: TEAMS[c].marbles[cap]?.name, career: t, season: s };
  });
  const marbles = store.leagueAll('marble').map(m => {
    const [color, id] = m.id.split(':');
    const info = TEAMS[color]?.marbles[+id];
    return { ...m, color, mid: +id, name: info?.name, trait: info?.trait, bio: info?.bio, captain: !!info?.captain, team: teamName(color) };
  });
  const rivals = store.leagueAll('rival').sort((a, b) => (b.bonks ?? 0) - (a.bonks ?? 0)).slice(0, 8);
  return { league: LEAGUE_NAME, season: mon, teams, marbles, rivals, records: store.leagueRecords(), recent: store.leagueRecentGames(15) };
}
