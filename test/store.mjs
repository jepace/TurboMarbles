// test/store.mjs — players, device keys, link codes, games and stats (in-memory SQLite).
import { getPrefs, setPrefs, openStore, closeStore, register, authenticate, rename, isNameTaken, createLinkCode, redeemLinkCode,
  deviceCount, revokeOtherDevices, deletePlayer, recordGame, saveAnalysis, getGame, playerStats, playerGames, playedIn } from '../src/Store.js';

let passed = 0, failed = 0;
const assert = (c, m) => { if (c) { console.log(`  ✓ ${m}`); passed++; } else { console.error(`  ✗ ${m}`); failed++; } };
const describe = (n, f) => { console.log(n); f(); };

assert(openStore(':memory:'), 'store opens');

describe('identity — register, sign in, names', () => {
  const a = register('JEP');
  assert(a.player?.id && typeof a.key === 'string' && a.key.length >= 40, 'register returns a player and a long key');
  assert(register('jep ').error === 'NAME_TAKEN' && register('JEP').error === 'NAME_TAKEN', 'names are unique, ignoring case and spaces');
  assert(authenticate(a.key)?.id === a.player.id, 'the key signs in');
  assert(authenticate('x'.repeat(43)) === null && authenticate(null) === null, 'a wrong key does not');
  assert(isNameTaken('Jep') && !isNameTaken('Jep', a.player.id), 'own name is not "taken" for yourself');
  const b = register('Sloane');
  assert(rename(a.player.id, 'sloane').error === 'NAME_TAKEN', "can't rename onto someone else's name");
  assert(rename(a.player.id, 'James').ok && authenticate(a.key).name === 'James', 'rename works');
  void b;
});

describe('identity — link codes and devices', () => {
  const a = register('Linker');
  const { code } = createLinkCode(a.player.id);
  assert(/^[A-Z2-9]{5}-[A-Z2-9]{5}$/.test(code), `link code looks like ${code}`);
  const d2 = redeemLinkCode(code.toLowerCase().replace('-', ' '));
  assert(d2?.player.id === a.player.id && d2.key !== a.key, 'code gives a second device its own key (case/spacing forgiven)');
  assert(redeemLinkCode(code) === null, 'a code works once');
  assert(redeemLinkCode('ABCDE-FGHJK') === null, 'a made-up code does not work');
  assert(deviceCount(a.player.id) === 2, 'two devices');
  assert(revokeOtherDevices(a.player.id, a.key) === 1 && authenticate(d2.key) === null && authenticate(a.key), 'sign out other devices');
});

describe('preferences', () => {
  const p = register('PrefTester').player;
  assert(JSON.stringify(getPrefs(p.id)) === '{}', 'no preferences at first');
  setPrefs(p.id, { apFilter: 'all', apPlayer: 'bogus', evil: 1 });
  assert(JSON.stringify(getPrefs(p.id)) === '{"apFilter":"all"}', 'only known keys and values are kept');
});

describe('games and stats', () => {
  const me = register('Stat').player, you = register('Opp').player;
  const g1 = recordGame({ cube: true, winnerSeat: 0, rolls: [{ turn: 1 }], seats: [
    { playerId: me.id, name: 'Stat', color: 'blue', isRobot: false, won: true, points: 4, aggro: true, doubles: 1 },
    { playerId: you.id, name: 'Opp', color: 'yellow', isRobot: false, won: false, points: -4, aggro: true, takes: 1 }] });
  recordGame({ cube: false, winnerSeat: 1, seats: [
    { playerId: me.id, name: 'Stat', color: 'blue', isRobot: false, won: false, points: -1 },
    { playerId: null, name: 'Hazel', color: 'yellow', isRobot: true, won: true, points: 1 }] });
  saveAnalysis(g1, { rolls: [] }, [{ choices: 20, errors: 2, blunders: 1, eqLost: 0.3 }, { choices: 18, errors: 0, blunders: 0, eqLost: 0.05 }]);
  const people = playerStats(me.id, { robots: 'none' }), all = playerStats(me.id);
  const st = people;
  assert(people.totals.games === 1 && people.totals.wins === 1 && people.totals.points === 4 && people.totals.aggro_wins === 1, 'people-only stats');
  assert(all.totals.games === 2 && all.totals.points === 3, 'all games: the robot game counts too');
  assert(people.totals.choices === 20 && Math.abs(people.totals.eq_lost - 0.3) < 1e-9, 'analysis numbers counted');
  assert(st.headToHead.length === 1 && st.headToHead[0].name === 'Opp' && st.headToHead[0].wins === 1, 'head to head vs people only');
  assert(st.trend.length === 1, 'error trend from analysed games');
  const list = playerGames(me.id);
  assert(list.length === 2 && list[0].endedAt >= list[1].endedAt && list.some(g => g.vsRobot), 'history newest first, robot game included');
  const g = getGame(g1);
  assert(g.rolls?.[0]?.turn === 1 && g.report?.rolls && g.seats.length === 2, 'game stored with rolls and report');
  assert(playedIn(me.id, g1) && !playedIn(register('Stranger').player.id, g1), 'only players of a game may open it');
  deletePlayer(you.id);
  assert(getGame(g1).seats[1].name === 'deleted player' && getGame(g1).seats[1].playerId === null, 'deleting an account anonymises their seats');
  assert(playerStats(me.id, { robots: 'none' }).totals.games === 1, "others' history survives");
});

closeStore();
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
