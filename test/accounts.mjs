// test/accounts.mjs — account actions and game recording (in-memory store).
import { openStore, closeStore, playerStats, playerGames } from '../src/Store.js';
import { handleAccountAction } from '../src/Accounts.js';
import { createRoom, joinRoom, startGame, handleMove, handleDouble, handleTake, handleAnalyzeGame, storedGameReport,
  _reset, _getRoom, config as gmConfig } from '../src/GameManager.js';

let passed = 0, failed = 0;
const assert = (c, m) => { if (c) { console.log(`  ✓ ${m}`); passed++; } else { console.error(`  ✗ ${m}`); failed++; } };
let wsId = 1;
const mockWs = () => ({ _id: 'a' + wsId++, _ip: '10.0.0.1', readyState: 1, sent: [],
  send(d) { this.sent.push(JSON.parse(d)); }, find(e) { return this.sent.filter(m => m.event === e); } });
const send = (ws, msg) => ws.send(JSON.stringify(msg));
const cleanName = n => (typeof n === 'string' ? n.trim().slice(0, 20) : '');
const act = (ws, msg) => handleAccountAction(ws, msg, { send, cleanName,
  onOpenGame: (w, g) => send(w, { event: 'storedGame', game: { id: g.id }, report: storedGameReport(g) }) });

openStore(':memory:');

console.log('register / identify / link');
const a = mockWs();
act(a, { action: 'register', name: 'JEP' });
const reg = a.find('registered')[0];
assert(reg?.key && reg.player.name === 'JEP' && a._player?.id === reg.player.id, 'register signs the connection in');
const a2 = mockWs();
act(a2, { action: 'register', name: 'jep' });
assert(a2.find('error')[0]?.code === 'NAME_TAKEN', 'taken name refused');
act(a2, { action: 'identify', key: reg.key });
assert(a2.find('identity')[0]?.player?.id === reg.player.id, 'identify with the key on another connection');
act(a2, { action: 'linkCode' });
const code = a2.find('linkCode')[0]?.code;
const phone = mockWs();
act(phone, { action: 'redeemLink', code });
assert(phone.find('registered')[0]?.player.id === reg.player.id && phone.find('registered')[0].linked, 'link code signs in a new device');
const guess = mockWs(); guess._ip = '10.9.9.9';
for (let i = 0; i < 12; i++) act(guess, { action: 'redeemLink', code: 'ABCDE-FGHJK' });
assert(guess.find('error').some(e => e.code === 'RATE_LIMITED'), 'guessing link codes gets rate-limited');
const anon = mockWs();
act(anon, { action: 'profile' });
assert(anon.find('error')[0]?.code === 'NOT_SIGNED_IN', 'profile needs signing in');

console.log('a finished game is recorded, analysis saved');
_reset(); gmConfig.initialTurnIndex = 0; gmConfig.robotThinkMs = 0;
gmConfig.analysis = { screen: 4, deep: 8, keep: 2, maxDeep: 8 };
gmConfig.analysisLevels = [gmConfig.analysis, gmConfig.analysis];
const b = mockWs();
act(b, { action: 'register', name: 'Sloane' });
const host = a, guest = b;
const { code: room, roomId } = createRoom(host, 'JEP', 2, undefined, { cube: true });
joinRoom(guest, room, 'Sloane');
startGame(host, roomId);
const R = _getRoom(roomId);
assert(R.slots[0].accountId === reg.player.id && R.slots[1].accountId === b._player.id, 'seats carry the accounts');
handleDouble(host, roomId); handleTake(guest, roomId);
const g = R.game;
g.players[0].marbles.forEach((m, i) => Object.assign(m, i < 3 ? { zone: 'home', slot: 4 - i } : { zone: 'track', space: 84 }));
Object.assign(g.players[1].marbles[0], { zone: 'track', space: 30 });   // an aggro, not a baggro
g.dice = [1, 2]; g.diceUsed = [false, true]; g.phase = 'AWAITING_MOVE'; g._humanMadeMove = false; g._undoStack = [];
handleMove(host, roomId, { type: 'move', dieIndex: 0, marbleId: 3, toZone: 'home', toSlot: 1 });
const st = playerStats(reg.player.id);
assert(st.people.games === 1 && st.people.wins === 1 && st.people.points === 4 && st.people.doubles === 1, `JEP: 1 win, +4 (cube 2 × aggro), 1 double (points ${st.people.points})`);
assert(playerStats(b._player.id).people.takes === 1 && playerStats(b._player.id).people.points === -4, 'Sloane: 1 take, −4');
handleAnalyzeGame(host, roomId);
const t0 = Date.now();
while (!host.find('analysisResult').length && Date.now() - t0 < 30000) await new Promise(r => setTimeout(r, 50));
await new Promise(r => setTimeout(r, 300));
const games = playerGames(reg.player.id);
assert(games.length === 1 && games[0].analysed, 'game listed in history, with its analysis saved');
act(a, { action: 'profile' });
assert(a.find('profile')[0]?.stats?.headToHead?.[0]?.name === 'Sloane', 'profile has head-to-head');
act(a, { action: 'openGame', id: games[0].id });
assert(a.find('storedGame')[0]?.report?.rolls, 'a player can open the stored game');
const stranger = mockWs();
act(stranger, { action: 'register', name: 'Stranger' });
act(stranger, { action: 'openGame', id: games[0].id });
assert(stranger.find('error')[0]?.code === 'NOT_FOUND', "others can't open it");
act(guest, { action: 'deleteAccount', confirm: 'nope' });
assert(guest.find('error').some(e => e.code === 'CONFIRM_MISMATCH'), 'delete needs the name typed');
act(guest, { action: 'deleteAccount', confirm: 'sloane' });
assert(guest.find('accountDeleted').length === 1 && !guest._player, 'account deleted');

closeStore();
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
