// main.js — UI controller, screen management, game event handling

import { connect, on, send, setReconnectInfo, onOpen } from './socket.js';
import { init as initBoard, drawBoard, resize as resizeBoard,
         hitTestMarble, highlightSpaces, highlightMarbleAt, getSpacePosition,
         setMarbleOverride, clearMarbleOverride,
         setAnimatingMarble, clearAnimatingMarble,
         getBasePosition, clearAllMarbleOverrides, spaceAt, drawMoveArrows, setViewArm, setSquareLabels, setColorShift, setBoardLook } from './board.js';
import { ARM_MAP, ARM_COLORS, PLAYER_CONFIG, spaceName, pipCount, countdown, armOf } from './constants.js';
import { playBonk, playClick, playHomeChime } from './sounds.js';

// ---- State ----
let myPlayerIndex = null;
let myName = null;
let roomId = null;
let gameState = null;
let selectedMarble = null;      // { playerIndex, marbleId } currently selected
let legalMovesCache = null;     // { 0: [...], 1: [...] } from server after roll
let legalCombos = {};           // { marbleId: [{ toZone, toSpace, toSlot, first, second }] }: both dice on one marble
let selectedComboMoves = [];    // the selected marble's two-dice destinations (not reachable with one die)
let pendingSecond = null;       // second move of a two-dice destination the player clicked
let selectedMarbleMoves = [];   // filtered moves for selectedMarble (for highlighting)
let selectedDie = null;         // 0 or 1 — player-locked die; null means auto
let commitPending = false;      // true when readyToCommit received, waiting for Commit click

// ---- Per-turn move log accumulation (for backgammon notation) ----
let turnNumber    = 0;    // increments each turnChanged; set to 1 on gameStarted
let turnLogMoves  = [];   // [{ marbleId, path: [str,...], bumped }] for current turn
let turnLogDice   = null; // [die0, die1] rolled this turn
let turnLogPlayer = null; // playerIndex for current turn
let pendingFeedback = null; // { text, cls } — robot comparison for my roll, logged with it

// ---- Player options (remembered in this browser) ----
// Move feedback: after committing a roll, show how the robot would have played it.
// Post-game analysis: offer the "Analyze Game" button when a game ends.
const settings = { feedback: true, analysis: true, numbers: true };
try {
  const saved = JSON.parse(localStorage.getItem('tm.settings') ?? '{}');
  if (typeof saved.feedback === 'boolean') settings.feedback = saved.feedback;
  if (typeof saved.analysis === 'boolean') settings.analysis = saved.analysis;
  if (typeof saved.numbers === 'boolean') settings.numbers = saved.numbers;
  if (typeof saved.myColor === 'string') settings.myColor = saved.myColor;
  if (typeof saved.boardTrack === 'string') settings.boardTrack = saved.boardTrack;
  if (typeof saved.boardMarbles === 'string') settings.boardMarbles = saved.boardMarbles;
} catch { /* storage unavailable: use defaults */ }
function saveSettings() {
  try { localStorage.setItem('tm.settings', JSON.stringify(settings)); } catch { /* ignore */ }
}
// Bumps seen since the last marbleMoved. The server emits marbleBumped right
// before the attacker's marbleMoved, so we stash them here and the very next
// marbleMoved enqueues their fly-home tweens (after the attacker's). Purely an
// event-correlation handoff — never held across animations.
let bumpHandoff   = []; // [{ ownerIndex, marbleId, fromPos }]
let lastAnimEnd   = null; // { playerIndex, marbleId } — last marble whose tween just finished

// Maps color name (from gameState / lobbyState) to hex — ARM_MAP means player 1 in
// a 2-player game uses 'white' not 'orange', so we can't index COLORS by player index.
const COLOR_MAP = {
  yellow: '#f5d000', orange: '#ff7800', pink: '#e8208c',
  white:  '#e0e0e0', green:  '#44bb44', blue: '#2288f0',
};

// ARM_MAP and ARM_COLORS imported from ./constants.js

let selectedHostColor = 'blue';

// ---- My colour: the board's colours turn round the ring (order kept) so my
// arm shows in my favourite colour. Display only, for me alone; chosen on the
// start screen or the settings page, applied when a game starts.
let colorShift = 0;
const armOfColor = c => PLAYER_CONFIG.findIndex(x => x.color === c);
function dc(c) {
  const a = armOfColor(c);
  return !colorShift || a < 0 ? c : PLAYER_CONFIG[(a + colorShift) % 6].color;
}
function applyColorSwap() {
  const fav = settings.myColor, mine = gameState?.players?.[myPlayerIndex]?.color;
  colorShift = fav && mine ? (armOfColor(fav) - armOfColor(mine) + 6) % 6 : 0;
  setColorShift(colorShift);
}

// ---- Screen management ----
function show(id) {
  const prev = document.querySelector('.screen.active')?.id;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const el = document.getElementById(id);
  el.classList.add('active');
  // Pages outside a game get the side navigation.
  document.body.classList.toggle('with-nav', el.classList.contains('page'));
  for (const b of document.querySelectorAll('#side-nav .nav-item')) b.classList.toggle('on', b.dataset.go === id);
  // The Board page borrows the board renderer for its preview: give it back.
  if (prev === 'screen-board' && id !== 'screen-board') { initBoard($('board-canvas')); setColorShift(0); }
  if (id === 'screen-landing') focusName();
}

// Put the cursor in the name box (selected, so typing replaces a remembered
// name and Enter keeps it). Browsers don't reliably honour autofocus on reload.
function focusName() {
  const el = $('landing-name');
  if (!el) return;
  requestAnimationFrame(() => { el.focus(); el.select(); });
}
window.addEventListener('pageshow', () => { if ($('screen-landing').classList.contains('active')) focusName(); });

// ---- DOM refs ----
const $ = id => document.getElementById(id);

// ---- Landing ----
// Login → home (the lobby to everything).
function goHome() {
  $('home-hello').textContent = me ? '' : `Playing as ${myName} (guest). Keep your stats, rating and friends by signing in: Log out, then tick "Keep my stats".`;
  renderNavMe();
  for (const b of document.querySelectorAll('#side-nav .acct')) b.style.display = me ? '' : 'none';
  show('screen-home');
  if (me) send({ action: 'friends' });
}
// ---- Side navigation ----
function renderNavMe() {
  $('nav-me').replaceChildren(el('div', { class: 'nav-name' }, me?.name ?? myName ?? ''),
    el('div', { class: 'muted' }, me ? (myRating ? `Rating ${myRating.rating}` : '') : 'guest'));
}
let myRating = null;
function navigate(id) {
  if (id === 'screen-profile' || id === 'screen-settings') { openProfile(id, 'screen-home'); return; }
  if (id === 'screen-board') { show(id); renderBoardPage(); return; }
  if (id === 'screen-leaderboard') send({ action: 'leaderboard' });
  if (id === 'screen-friends') send({ action: 'friends' });
  show(id);
  if (id === 'screen-friends') renderMessages();
}
for (const b of document.querySelectorAll('#side-nav [data-go]')) b.addEventListener('click', () => navigate(b.dataset.go));

// ---- Quick match ----
function updateQmOptions() {
  const two = $('qm-players').value === '2';
  $('qm-match-row').style.display = two ? '' : 'none';
  const m = Number($('qm-match').value);
  $('qm-cube-row').style.display = two && !m ? '' : 'none';
}
$('qm-players').addEventListener('change', updateQmOptions);
$('qm-match').addEventListener('change', updateQmOptions);
$('qm-cube').addEventListener('change', updateQmOptions);
updateQmOptions();
$('btn-quick').addEventListener('click', () => {
  const n = Number($('qm-players').value), m = n === 2 ? Number($('qm-match').value) : 0;
  connect();
  send({ action: 'quickMatch', name: me?.name ?? myName, players: n, matchTo: m, cube: n === 2 && (m ? m >= 2 : $('qm-cube').checked) });
  $('qm-status').textContent = 'Looking for players…';
  $('btn-quick').disabled = true; $('btn-quick-cancel').style.display = '';
});
$('btn-quick-cancel').addEventListener('click', () => send({ action: 'quickMatchCancel' }));
function resetQuick() { $('qm-status').textContent = ''; $('btn-quick').disabled = false; $('btn-quick-cancel').style.display = 'none'; }
on('quickMatchWaiting', ({ waiting, need }) => { $('qm-status').textContent = `Waiting for players… ${waiting} of ${need}`; });
on('quickMatchCancelled', resetQuick);
on('quickMatchFound', resetQuick);

// Played better too: the rating exchange counted twice.
on('ratingBonus', ({ winSeat, loseSeat, ratings }) => {
  log(`📈 Analysis: ${playerName(winSeat)} also outplayed ${playerName(loseSeat)} — rating exchange ×2`);
  const mine = ratings?.[myPlayerIndex];
  if (mine?.rating) { myRating = { ...(myRating ?? {}), rating: mine.rating }; renderNavMe();
    log(`Your rating: ${mine.rating} (${mine.change >= 0 ? '+' : ''}${mine.change} more)`); }
});
// ---- Leaderboard ----
on('leaderboard', ({ players, me: mine }) => {
  if (mine) { myRating = mine; renderNavMe(); }
  $('lb-me').textContent = mine ? `Your rating: ${mine.rating} (${mine.games} rated game${mine.games === 1 ? '' : 's'})` : '';
  $('lb-table').replaceChildren(el('tr', {}, el('th', {}, '#'), el('th', {}, 'Player'), el('th', {}, 'Rating'), el('th', {}, 'Games')),
    ...players.map(p => el('tr', { class: me && p.id === me.id ? 'me' : '' }, el('td', {}, String(p.rank)), el('td', {}, p.name), el('td', {}, String(p.rating)), el('td', {}, String(p.games)))));
  if (!players.length) $('lb-table').append(el('tr', {}, el('td', { colSpan: 4, class: 'muted' }, 'No rated games yet.')));
});

// ---- Friends ----
let friendsData = { friends: [], incoming: [], outgoing: [], blocked: [] };
const dot = on_ => el('span', { class: 'online-dot' + (on_ ? ' on' : ''), title: on_ ? 'online' : 'offline' });
function smallBtn(label, fn, cls = 'secondary') { const b = el('button', { class: cls + ' small' }, label); b.addEventListener('click', fn); return b; }
on('friends', data => {
  friendsData = data;
  const unread = data.friends.reduce((n, f) => n + (f.unread || 0), 0);
  $('badge-friends').textContent = (data.incoming.length + unread) || '';
  renderFriends(); renderMessages(); renderLobbyInvite();
});
on('presence', ({ id, online }) => {
  const f = friendsData.friends.find(x => x.id === id);
  if (f) { f.online = online; renderFriends(); renderMessages(); renderLobbyInvite(); }
});
function renderFriends() {
  const d = friendsData, box = $('friends-box');
  const sec = (title, rows) => rows.length ? [el('h3', {}, title), ...rows] : [];
  box.replaceChildren(
    ...sec('Requests', d.incoming.map(f => el('div', { class: 'friend-row' }, el('span', { class: 'fname' }, f.name),
      smallBtn('Accept', () => send({ action: 'friendRespond', id: f.id, accept: true }), 'btn-go'),
      smallBtn('Decline', () => send({ action: 'friendRespond', id: f.id, accept: false }))))),
    ...sec('Sent requests', d.outgoing.map(f => el('div', { class: 'friend-row' }, el('span', { class: 'fname' }, f.name), el('span', { class: 'muted' }, 'waiting'),
      smallBtn('Cancel', () => send({ action: 'friendRemove', id: f.id }))))),
    ...sec('Blocked', d.blocked.map(f => el('div', { class: 'friend-row' }, el('span', { class: 'fname' }, f.name), smallBtn('Unblock', () => send({ action: 'unblock', id: f.id }))))),
  );

}
$('btn-friend-add').addEventListener('click', () => { const n = $('friend-name').value.trim(); if (n) { send({ action: 'friendRequest', name: n }); $('friend-name').value = ''; } });
$('friend-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-friend-add').click(); });

// ---- Messages ----
let dmWith = null;
const dmLogs = new Map();          // friend id → [messages]
function renderMessages() {
  $('dm-list').replaceChildren(...friendsData.friends.map(f => {
    const b = el('button', { class: 'dm-friend' + (f.id === dmWith ? ' on' : '') }, dot(f.online), f.name, f.unread ? el('span', { class: 'nav-badge' }, String(f.unread)) : '');
    b.addEventListener('click', () => { dmWith = f.id; renderMessages(); });
    return b;
  }));
  if (!friendsData.friends.length) $('dm-list').append(el('p', { class: 'muted' }, 'Add friends to message them.'));
  const f = friendsData.friends.find(x => x.id === dmWith);
  $('dm-input').disabled = $('btn-dm-send').disabled = !f;
  $('dm-head').replaceChildren(...(f ? [el('b', {}, f.name), el('span', { class: 'muted' }, ` ${f.rating}`), el('span', { style: 'flex:1' }),
    smallBtn('Remove', () => { if (confirm(`Remove ${f.name} from your friends?`)) send({ action: 'friendRemove', id: f.id }); }),
    smallBtn('Block', () => { if (confirm(`Block ${f.name}?`)) send({ action: 'block', id: f.id }); })] : [el('span', { class: 'muted' }, friendsData.friends.length ? 'Pick a friend.' : 'No friends yet.')]));
  if (f && $('screen-friends').classList.contains('active') && !dmLogs.has(f.id)) send({ action: 'conversation', with: f.id });
  if (f && f.unread && $('screen-friends').classList.contains('active')) { send({ action: 'conversation', with: f.id }); f.unread = 0; }
  renderDmLog();
}
function renderDmLog() {
  const log = $('dm-log');
  log.replaceChildren(...(dmLogs.get(dmWith) ?? []).map(m => el('div', { class: 'dm-msg' + (me && m.from === me.id ? ' mine' : '') }, m.body)));
  log.scrollTop = log.scrollHeight;
}
on('conversation', ({ with: w, messages }) => { dmLogs.set(w, messages); if (w === dmWith) renderDmLog(); send({ action: 'friends' }); });
on('dm', ({ message: m }) => {
  const other = me && m.from === me.id ? m.to : m.from;
  if (dmLogs.has(other)) dmLogs.get(other).push(m);
  if (other === dmWith && $('screen-friends').classList.contains('active')) { renderDmLog(); if (m.from !== me?.id) send({ action: 'conversation', with: other }); }
  else if (m.from !== me?.id) { const f = friendsData.friends.find(x => x.id === other); if (f) { f.unread = (f.unread || 0) + 1; $('badge-friends').textContent = (friendsData.incoming.length + friendsData.friends.reduce((n, x) => n + (x.unread || 0), 0)) || ''; renderFriends(); }
    if (!$('screen-friends').classList.contains('active')) toastAnywhere(`💬 ${m.fromName}: ${m.body.slice(0, 80)}`); }
});
function sendDm() { const t = $('dm-input').value.trim(); if (t && dmWith) { send({ action: 'dm', to: dmWith, body: t }); $('dm-input').value = ''; } }
$('btn-dm-send').addEventListener('click', sendDm);
$('dm-input').addEventListener('keydown', e => { if (e.key === 'Enter') sendDm(); });

// ---- Invitations ----
function renderLobbyInvite() {
  const box = $('lobby-invite');
  if (!box) return;
  const on_ = friendsData.friends.filter(f => f.online);
  box.replaceChildren(...(me && on_.length ? [el('div', { class: 'muted' }, 'Invite a friend:'),
    el('div', { class: 'chips' }, ...on_.map(f => { const b = el('button', { class: 'chip' }, dot(true), f.name);
      b.addEventListener('click', () => { send({ action: 'invite', to: f.id }); b.disabled = true; b.append(' ✓'); }); return b; }))] : []));
}
on('invited', ({ from, code }) => {
  const pop = $('invite-pop');
  const join = el('button', { class: 'btn-go' }, 'Join'), no = el('button', { class: 'secondary' }, 'Not now');
  pop.replaceChildren(el('div', {}, `${from} invites you to a game`), el('div', { class: 'btn-row' }, join, no));
  pop.style.display = 'flex';
  join.addEventListener('click', () => { pop.style.display = 'none'; myName = me?.name ?? myName; send({ action: 'joinRoom', code, name: myName }); });
  no.addEventListener('click', () => { pop.style.display = 'none'; });
});
// A notice that works on any screen.
function toastAnywhere(msg) {
  const t = el('div', { class: 'toast global' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 5000);
}

// ---- Chat (lobby and game) ----
function chatLine(name, text, color) {
  return el('div', { class: 'chat-line' }, el('b', { style: color ? `color:${COLOR_MAP[dc(color)] ?? ''}` : '' }, name + ': '), text);
}
on('chat', ({ playerIndex, name, text }) => {
  const color = gameState?.players?.[playerIndex]?.color;
  if ($('screen-lobby').classList.contains('active')) {
    const box = document.querySelector('#lobby-chat .chat-log');
    box.append(chatLine(name, text)); box.scrollTop = box.scrollHeight;
  } else {
    const entry = chatLine(name, text, color); entry.classList.add('log-entry', 'log-chat');
    $('game-log').append(entry); $('game-log').scrollTop = $('game-log').scrollHeight;
  }
});
for (const inp of [document.querySelector('#lobby-chat .chat-input'), $('game-chat-input')]) {
  inp.addEventListener('keydown', e => {
    e.stopPropagation();                       // typing must not trigger game keys
    if (e.key === 'Enter' && inp.value.trim()) { send({ action: 'chat', text: inp.value.trim() }); inp.value = ''; }
  });
}
// ---- Login screen: Log in / Create account / Guest (and a password reset) ----
const loginForms = { login: 'form-login', signup: 'form-signup', guest: 'form-guest', reset: 'form-reset' };
function loginTab(t) {
  for (const [k, id] of Object.entries(loginForms)) $(id).style.display = k === t ? '' : 'none';
  for (const b of document.querySelectorAll('#login-tabs .tab')) b.classList.toggle('on', b.dataset.tab === t);
  $('login-tabs').style.display = t === 'reset' ? 'none' : '';
  $('account-line').textContent = '';
  const first = $(loginForms[t]).querySelector('input:not([type=checkbox])');
  requestAnimationFrame(() => first?.focus());
}
for (const b of document.querySelectorAll('#login-tabs .tab')) b.addEventListener('click', () => loginTab(b.dataset.tab));
const loginMsg = m => { $('account-line').textContent = m; };
$('form-login').addEventListener('submit', e => {
  e.preventDefault();
  const name = $('login-name').value.trim(), password = $('login-pass').value;
  if (!name || !password) { loginMsg('Enter your name and password.'); return; }
  pendingAfterRegister = () => { myName = me.name; goHome(); };
  connect(); send({ action: 'login', name, password });
});
$('form-signup').addEventListener('submit', e => {
  e.preventDefault();
  const name = $('signup-name').value.trim(), password = $('signup-pass').value, email = $('signup-email').value.trim();
  if (!name) { loginMsg('Choose a name.'); return; }
  if (password.length < 8) { loginMsg('Use a password of 8 or more characters.'); return; }
  pendingAfterRegister = () => { myName = me.name; goHome(); if (email) toastAnywhere(`We sent a link to ${email} to confirm it.`); };
  connect(); send({ action: 'register', name, password, ...(email ? { email } : {}) });
});
$('form-guest').addEventListener('submit', e => { e.preventDefault(); withName(goHome); });
$('btn-forgot').addEventListener('click', () => {
  const n = prompt('Your name, or the email on your account:', $('login-name').value.trim());
  if (!n) return;
  connect(); send({ action: 'forgotPassword', name: n.trim() });
});
on('resetSent', () => loginMsg("If that account has a confirmed email, we've sent it a link to reset the password (it works for an hour)."));
// Links from emails: ?reset=… (new password) and ?verify=… (confirm an email).
const urlQ = new URLSearchParams(location.search);
const resetToken = urlQ.get('reset'), verifyToken = urlQ.get('verify');
if (resetToken || verifyToken) history.replaceState(null, '', location.pathname);
if (resetToken) loginTab('reset');
$('form-reset').addEventListener('submit', e => {
  e.preventDefault();
  const password = $('reset-pass').value;
  if (password.length < 8) { loginMsg('Use a password of 8 or more characters.'); return; }
  pendingAfterRegister = () => { myName = me.name; goHome(); toastAnywhere('Password changed. Other devices were signed out.'); };
  connect(); send({ action: 'resetPassword', token: resetToken, password });
});
if (verifyToken) { connect(); onOpen(() => send({ action: 'verifyEmail', token: verifyToken })); }
on('emailCleared', () => { if (profileData) { profileData.email = null; renderAccountSection(); } });
on('passwordSet', () => { if (profileData) { profileData.hasPassword = true; renderAccountSection(); } });
on('emailVerified', ({ email }) => { toastAnywhere(`Email confirmed: ${email}`); if (profileData) { profileData.email = email; renderAccountSection(); } });
// An account from before passwords: choose one now.
$('btn-pw-pop').addEventListener('click', () => {
  const password = $('pw-pop-pass').value, email = $('pw-pop-email').value.trim();
  if (password.length < 8) { alert('Use a password of 8 or more characters.'); return; }
  send({ action: 'setPassword', password });
  if (email) send({ action: 'setEmail', email });
  $('pw-pop').style.display = 'none';
});
on('passwordSet', () => toastAnywhere('Password saved.'));
on('emailPending', ({ email }) => toastAnywhere(`We sent a link to ${email}. Open it to confirm the address.`));
// Log out: this device's session ends on the server too.
$('btn-switch-user').addEventListener('click', () => {
  if (me) send({ action: 'logout' });
  saveKey(null); me = null; myPrefs = {}; myRating = null;
  updateLanding(); loginTab('login'); show('screen-landing');
});
// Friends & robots: a private room with the rules chosen above; robots and
// invitations are added in its waiting room.
$('btn-create').addEventListener('click', () => withName(() => {
  const n = Number($('qm-players').value), m = n === 2 ? Number($('qm-match').value) : 0;
  connect();
  send({ action: 'createRoom', name: myName, totalPlayers: n, hostColor: selectedHostColor,
    cube: n === 2 && (m ? m >= 2 : $('qm-cube').checked), matchTo: m });
}));
$('btn-join').addEventListener('click', () => withName(() => show('screen-join')));
function validateName() {
  const n = me ? me.name : $('landing-name').value.trim();
  if (!n) { $('landing-name').focus(); return false; }
  myName = n;
  return true;
}
// Continue once there is a name — registering it first if "Keep my stats" is
// ticked and this browser isn't signed in yet.
function withName(next) {
  if (!validateName()) return;
  if (me || !$('landing-remember').checked) { next(); return; }
  pendingAfterRegister = next;
  connect();
  send({ action: 'register', name: myName });
}
$('landing-name').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-continue').click(); });

// ---- Create ----
function updateColorPicker(n) {
  const el = $('create-colors');
  if (!el) return;
  const arms = ARM_MAP[n] ?? [0];
  el.innerHTML = '';
  for (const arm of arms) {
    const color = ARM_COLORS[arm];
    const swatch = document.createElement('button');
    swatch.className = 'color-swatch' + (color === selectedHostColor ? ' selected' : '');
    swatch.style.background = COLOR_MAP[color];
    swatch.title = color;
    swatch.dataset.color = color;
    swatch.addEventListener('click', e => {
      e.preventDefault();
      selectedHostColor = color;
      updateColorPicker(n);
    });
    el.appendChild(swatch);
  }
  // If current selectedHostColor not in available arms, reset to first
  const available = arms.map(a => ARM_COLORS[a]);
  if (!available.includes(selectedHostColor)) {
    selectedHostColor = available[0];
    updateColorPicker(n);
  }
}

$('btn-create-confirm').addEventListener('click', () => {
  const n = parseInt($('create-count').value, 10);
  if (n < 2 || n > 6) return;
  connect();
  const matchTo = n === 2 ? Math.max(0, Math.min(25, parseInt($('create-match').value, 10) || 0)) : 0;
  send({ action: 'createRoom', name: myName, totalPlayers: n, hostColor: selectedHostColor, cube: n === 2 && (matchTo ? matchTo >= 2 : $('create-cube').checked),
    matchTo });
});
$('btn-create-back').addEventListener('click', () => show('screen-home'));
// Enter on player-count field → confirm create
$('create-count').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-create-confirm').click(); });
$('create-count').addEventListener('input', () => {
  const n = parseInt($('create-count').value, 10);
  if (n >= 2 && n <= 6) updateColorPicker(n);
  updateCubeOption(n);
});
// The cube is for two-player games: always shown, enabled only for 2.
function updateCubeOption(n) {
  const ok = n === 2;
  $('create-cube').disabled = !ok;
  if (!ok) $('create-cube').checked = false;
  $('create-cube-note').textContent = ok ? '' : '— 2 players only';
  $('create-cube-row').style.opacity = ok ? '1' : '0.55';
  // Matches: two players.
  $('create-match').disabled = !ok;
  $('create-match-row').style.opacity = ok ? '1' : '0.55';
  const mlen = ok ? (parseInt($('create-match').value, 10) || 0) : 0;
  const match = mlen > 0;
  // A match is played with the cube (a 1-point match without): not a choice.
  if (match) { $('create-cube').checked = mlen >= 2; $('create-cube').disabled = true; }
}
$('create-cube').addEventListener('change', () => updateCubeOption(parseInt($('create-count').value, 10)));
$('create-match').addEventListener('input', () => updateCubeOption(parseInt($('create-count').value, 10)));
updateCubeOption(parseInt($('create-count').value, 10));
updateColorPicker(4); // initialize with default

// ---- Join ----
$('btn-join-confirm').addEventListener('click', () => {
  const code = $('join-code').value.trim().toUpperCase();
  if (!code) return; // the server validates the code itself
  connect();
  send({ action: 'joinRoom', code, name: myName });
});
$('btn-join-back').addEventListener('click', () => show('screen-home'));
// Enter on room-code field → confirm join
$('join-code').addEventListener('keydown', e => { if (e.key === 'Enter') $('btn-join-confirm').click(); });

// ---- Lobby ----
$('btn-add-robot').addEventListener('click', () => send({ action: 'addRobot' }));
$('btn-start').addEventListener('click', () => send({ action: 'startGame' }));
$('btn-copy-code').addEventListener('click', () => {
  const code = $('lobby-code').textContent;
  navigator.clipboard.writeText(code).then(() => {
    const btn = $('btn-copy-code');
    btn.textContent = '✓';
    setTimeout(() => { btn.textContent = '⧉'; }, 1500);
  });
});

// ---- Roll ----
$('btn-roll').addEventListener('click', doRoll);

for (let i = 0; i < 2; i++) {
  $(`die-${i}`).addEventListener('click', () => {
    if (!isMyTurn() || gameState?.phase !== 'AWAITING_MOVE') return;
    if (gameState?.diceUsed?.[i]) return;
    selectedDie = (selectedDie === i) ? null : i;
    selectedMarbleMoves = selectedMarble ? computeLegalDestinations(selectedMarble) : [];
    selectedComboMoves = selectedMarble ? computeComboDestinations(selectedMarble) : [];
    renderDice(gameState.dice);
    if (selectedMarble) {
      drawBoard(gameState);
      showDestinations();
    }
  });
}

function doRoll() {
  if ($('btn-roll').disabled) return;
  hideRollPopup();
  send({ action: 'roll' });
  $('die-0').classList.add('rolling');
  $('die-1').classList.add('rolling');
  setTimeout(() => { $('die-0').classList.remove('rolling'); $('die-1').classList.remove('rolling'); }, 500);
}

// ---- Commit / Undo ----
$('btn-commit').addEventListener('click', doCommit);
$('btn-undo').addEventListener('click', doUndo);
$('btn-skip').addEventListener('click', doSkipDie);

function doSkipDie() {
  const i = skippableDieIndex();
  if (i < 0) return;
  send({ action: 'forfeitDie', dieIndex: i });
  $('btn-skip').style.display = 'none';
  setUndoVisible(true);             // a skip is undoable; the turn ends with Commit
}

function doCommit() {
  send({ action: 'commit' });
  commitPending = false;
  $('btn-commit').style.display = 'none';
  $('btn-undo').style.display   = 'none';
  $('btn-skip').style.display   = 'none';  syncActionBar();
}

function doUndo() {
  send({ action: 'undo' });
  pendingSecond = null;
  commitPending = false;
  $('btn-commit').style.display = 'none';
  $('btn-undo').style.display   = 'none';
  syncActionBar();
  legalMovesCache = null;
  selectedMarble = null;
  selectedMarbleMoves = []; selectedComboMoves = [];
}

// Undo available after any move; Commit only when both dice are used.
function setUndoVisible(visible)   { $('btn-undo').style.display   = visible ? 'inline-flex' : 'none'; syncActionBar(); }
function setCommitVisible(visible) { $('btn-commit').style.display  = visible ? 'inline-flex' : 'none'; syncActionBar(); }
// The action corner shows only while one of its buttons does.
function syncActionBar() {
  const any = ['btn-undo', 'btn-skip', 'btn-commit'].some(id => $(id).style.display !== 'none');
  $('commit-area').style.display = any ? 'flex' : 'none';
}

// The first unused die whose ONLY legal moves are optional (e.g. the pass-home
// "go around the board again" choice). Such a die can be voluntarily skipped
// rather than forcing the player to loop the track. Returns the die index or -1.
function skippableDieIndex() {
  if (!isMyTurn() || !legalMovesCache || commitPending) return -1;
  const used = gameState?.diceUsed ?? [false, false];
  // Mirrors the server: no skipping while the other die still has a mandatory
  // move, since playing it first might give this die one.
  const mandatory = i => !used[i] && (legalMovesCache[i] ?? []).some(m => !m.optional);
  for (let i = 0; i < 2; i++) {
    if (used[i]) continue;
    const moves = legalMovesCache[i] ?? [];
    if (moves.length > 0 && moves.every(m => m.optional) && !mandatory(1 - i)) return i;
  }
  return -1;
}

// Show the Skip Die button only when the active player has a die whose sole
// remaining option is to go around the board again.
function updateSkipButton() {
  $('btn-skip').style.display = skippableDieIndex() >= 0 ? 'inline-flex' : 'none';
  syncActionBar();
}

// ---- [Enter] key — create/start/roll/commit shortcuts ----
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  // Don't fire if user is typing in an input/textarea
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  // Create screen: Enter confirms
  if ($('screen-create').classList.contains('active')) {
    $('btn-create-confirm').click(); return;
  }
  // Lobby: host can Enter to start
  if ($('screen-lobby').classList.contains('active')) {
    if ($('host-controls').style.display !== 'none') $('btn-start').click();
    return;
  }
  // Game: roll or commit
  if (!gameState) return;
  if (commitPending && isMyTurn()) {
    doCommit();
  } else if (!$('btn-roll').disabled && isMyTurn()) {
    doRoll();
  }
});

// ---- In-game [-] key — Skip Die (next to Enter on the number pad) ----
// The lobby's own "-" (remove a robot) only acts on the lobby screen.
document.addEventListener('keydown', e => {
  if (e.key !== '-') return;
  if (!$('screen-game').classList.contains('active')) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  if ($('btn-skip').style.display === 'none') return; // nothing to skip right now
  e.preventDefault();
  doSkipDie();
});

// ---- In-game [u] key — Undo the last die ----
document.addEventListener('keydown', e => {
  if (e.key !== 'u' && e.key !== 'U') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (!$('screen-game').classList.contains('active')) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  if ($('btn-undo').style.display === 'none') return; // nothing to undo right now
  e.preventDefault();
  doUndo();
});

// ---- Lobby [+]/[-] keys — host adds/removes a robot ----
document.addEventListener('keydown', e => {
  // "=" is an undocumented alias for "+" so adding robots doesn't require Shift.
  if (e.key !== '+' && e.key !== '=' && e.key !== '-') return;
  // Only in the waiting room, and only the host (host-controls visible)
  if (!$('screen-lobby').classList.contains('active')) return;
  if ($('host-controls').style.display === 'none') return;
  // Don't fire while typing in an input/textarea
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;

  if (e.key === '+' || e.key === '=') {
    if (!$('btn-add-robot').disabled) send({ action: 'addRobot' });
  } else {
    // Remove the highest-index robot currently in a slot
    const items = [...document.querySelectorAll('#lobby-slots li')];
    for (let i = items.length - 1; i >= 0; i--) {
      const nameEl = items[i].querySelector('.slot-name');
      if (nameEl && nameEl.textContent.includes('🤖')) {
        const playerIndex = Number(items[i].id.replace('slot-', ''));
        send({ action: 'removeRobot', playerIndex });
        break;
      }
    }
  }
  e.preventDefault();
});

// ---- Play again ----
// Leave the room for good (after a game: back to the start screen to set up
// a different game; during one: quit — against people, a resignation).
function leaveForGood() {
  send({ action: 'quit' });
  setReconnectInfo(null);
  clearTimeout(autoRollTimer);
  $('win-overlay').style.display = 'none';
  if ($('game-layout').classList.contains('analysis-mode')) closeAnalysis();
  gameState = null;
  show(myName || me ? 'screen-home' : 'screen-landing');
}
$('btn-play-again').addEventListener('click', leaveForGood);
$('btn-quit').addEventListener('click', () => {
  const g = gameState;
  if (!g || g.winner != null || g.phase === 'GAME_OVER') { leaveForGood(); return; }
  const people = g.players.filter((p, i) => i !== myPlayerIndex && !p.isRobot).length;
  if (g.players.length > 2) { if (confirm(people ? 'Quit? A robot will play your marbles.' : 'Quit this game?')) leaveForGood(); return; }
  openResignDialog();
});
// Two players: offer to resign at 1×/2×/3× (on your turn), or abandon.
function boardPopup(id, ...kids) {
  $(id)?.remove();
  const p = el('div', { id, class: 'action-box resign-popup' }, ...kids);
  $('action-slot').append(p);
  return p;
}
const ptsTxt = n => `${n} pt${n === 1 ? '' : 's'}`;
function openResignDialog() {
  const g = gameState, stake = g.cube?.value ?? 1, opp = 1 - myPlayerIndex;
  const people = !g.players[opp]?.isRobot;
  const myTurn = isMyTurn() && ['IN_TURN', 'AWAITING_MOVE'].includes(g.phase) && !g.cubeOffer && !g.resignOffer;
  const mine = g.players[myPlayerIndex];
  const abandonMult = mine.marbles.some(m => m.zone === 'home') ? 1 : 3;
  const btn = (label, cls, fn, title = '') => { const b = el('button', { class: cls, title }, label); b.addEventListener('click', fn); return b; };
  const close = () => $('resign-popup')?.remove();
  clearTimeout(autoRollTimer);
  const offers = [[1, 'Single'], [2, 'Aggro'], [3, 'Baggro']].map(([m, name]) => {
    const b = btn(`${name} ${ptsTxt(stake * m)}`, 'secondary', () => { send({ action: 'resign', mult: m }); close(); });
    b.disabled = !myTurn;
    return b;
  });
  boardPopup('resign-popup',
    el('div', {}, 'Resign', help(`Offer the game at a single, aggro or baggro (× the cube). ${playerName(opp)} accepts or plays on. Only on your turn.`)),
    el('div', { class: 'btn-row' }, ...offers),
    el('div', { class: 'btn-row' },
      btn(people ? (g.match ? 'Abandon the match' : `Abandon −${stake * abandonMult}`) : 'Quit', 'secondary',
        () => { close(); leaveForGood(); }, people ? 'Leave now: you lose the most you still could' : ''),
      btn('Cancel', 'secondary', () => { close(); if (isMyTurn() && !$('btn-roll').disabled) enableRoll(); })));
}
on('resignOffered', ({ playerIndex, mult, points }) => {
  gameState.resignOffer = { from: playerIndex, to: 1 - playerIndex, mult, points, prevPhase: gameState.phase };
  gameState.phase = 'RESIGN_OFFERED';
  clearTimeout(autoRollTimer);
  hideRollPopup();
  const name = ['', 'a single game', 'an aggro', 'a baggro'][mult];
  log(`${playerName(playerIndex)} offers to resign: ${name}, ${ptsTxt(points)}`, gameState.players[playerIndex]?.color);
  if (playerIndex === myPlayerIndex) { $('turn-banner').textContent = `${playerName(1 - playerIndex)} to answer`; return; }
  const btn = (label, cls, accept) => { const b = el('button', { class: cls }, label); b.addEventListener('click', () => { send({ action: 'resignAnswer', accept }); $('resign-popup')?.remove(); }); return b; };
  boardPopup('resign-popup', el('div', {}, `${playerName(playerIndex)} resigns: ${ptsTxt(points)}`),
    el('div', { class: 'btn-row' }, btn('Play on', 'secondary', false), btn('Accept', 'btn-go', true)));
  $('turn-banner').textContent = 'Resignation offered';
});
on('resignAnswered', ({ playerIndex, accept }) => {
  $('resign-popup')?.remove();
  const o = gameState?.resignOffer;
  log(`${playerName(playerIndex)} ${accept ? 'accepts' : 'plays on'}`, gameState?.players[playerIndex]?.color);
  if (!gameState || !o) return;
  gameState.resignOffer = null;
  if (accept) return;
  gameState.phase = o.prevPhase;
  $('turn-banner').textContent = isMyTurn() ? 'Your turn' : `${playerName(gameState.turnIndex)}'s turn`;
  if (isMyTurn() && o.prevPhase === 'IN_TURN') enableRoll();
});
on('playerQuit', ({ playerIndex, resigned }) => {
  if (playerIndex !== myPlayerIndex) log(`${playerName(playerIndex)} ${resigned ? 'resigns' : 'left'}`, gameState?.players[playerIndex]?.color);
});

// ---- Copy log ----
// Plain-text move log, with a header naming each player's color, so a finished
// game can be pasted somewhere for review.
function moveLogText() {
  const players = (gameState?.players ?? [])
    .map(p => `  ${p.name} (${p.color})`)
    .join('\n');
  // Just the raw log: the robot's comments (feedback lines) stay on screen only.
  const lines = [...$('game-log').children].filter(el => !el.classList.contains('log-feedback')).map(el => el.textContent);
  return [
    `TurboMarbles game log — ${new Date().toISOString()}`,
    'Players:',
    players,
    '',
    ...lines,
    '',
  ].join('\n');
}

// A past game opened from the profile has no live log: rebuild it from the
// report (same format: mover's numbers; cube decisions in their place).
function reportLogText(rep, endedAt) {
  const name = i => rep.players[i]?.name ?? `Player ${i + 1}`;
  const cubes = rep.cube ?? [];
  const lines = [];
  let k = 0;
  const cubeLine = c => c.kind === 'double'
    ? (c.action ? `${name(c.pi)} doubles to ${c.v * 2}` : null)
    : `${name(c.pi)} ${c.action ? `takes — cube at ${c.v * 2}` : 'drops'}`;
  rep.rolls.forEach((r, idx) => {
    while (k < cubes.length && cubes[k].rollIdx <= idx) { const l = cubeLine(cubes[k++]); if (l) lines.push(l); }
    lines.push(`${r.turn}. ${name(r.pi)}: ${r.dice.join('-')}: ${r.played}`);
  });
  while (k < cubes.length) { const l = cubeLine(cubes[k++]); if (l) lines.push(l); }
  if (rep.winner != null) lines.push(`🏆 ${name(rep.winner)} wins the game!`);
  return [`TurboMarbles game log — ${new Date(endedAt ?? Date.now()).toISOString()}`, 'Players:',
    rep.players.map(p => `  ${p.name} (${p.color})`).join('\n'), '', ...lines, ''].join('\n');
}

// Copy text to the clipboard (or download it when the clipboard is unavailable).
async function copyText(btn, text, label) {
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied ✓';
  } catch {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = `turbomarbles-log-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
    btn.textContent = 'Downloaded ✓';
  }
  setTimeout(() => { btn.textContent = label; }, 2000);
}
$('btn-ap-copy').addEventListener('click', () => {
  const text = viewingStored && analysisReport ? reportLogText(analysisReport, storedEndedAt) : moveLogText();
  copyText($('btn-ap-copy'), text, 'Copy log');
});

$('btn-copy-log').addEventListener('click', async () => {
  const btn  = $('btn-copy-log');
  const text = moveLogText();
  try {
    await navigator.clipboard.writeText(text);
    btn.textContent = 'Copied ✓';
  } catch {
    // Clipboard unavailable (e.g. non-HTTPS origin) — fall back to a download.
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = `turbomarbles-log-${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
    btn.textContent = 'Downloaded ✓';
  }
  setTimeout(() => { btn.textContent = 'Copy Log'; }, 2000);
});

// ---- Canvas click (marble selection & move) ----
$('board-canvas').addEventListener('click', onCanvasClick);

// ---- Square names on hover ----
// Shows e.g. "B↓3 · 3 before Blue's home entry" next to the cursor.
const armName = a => ARM_COLORS[a][0].toUpperCase() + ARM_COLORS[a].slice(1);
function describeSquare(hit) {
  if (hit.kind === 'hub')  return ['hub', 'centre hub — leave with a 1'];
  if (hit.kind === 'base') return ['base', `${armName(hit.arm)}'s base`];
  if (hit.kind === 'home') return [`h${hit.slot}`, `${armName(hit.arm)}'s home, slot ${hit.slot}`];
  // Each player's number for this square: mine first ("30 for you · 54 for Sloane").
  const players = gameState?.players ?? [];
  const me = myPlayerIndex ?? 0;
  const mine = String(countdown(playerArm(me), hit.space));
  const others = players.filter(p => p.index !== me).slice(0, 5)
    .map(p => `${countdown(playerArm(p.index), hit.space)} for ${p.name}`);
  const arm = PLAYER_CONFIG.findIndex(c => c.start === hit.space || c.homeEntry === hit.space || c.star === hit.space);
  let what = '';
  if (arm !== -1) {
    const c = PLAYER_CONFIG[arm];
    what = c.start === hit.space ? `${armName(arm)}'s start` : c.homeEntry === hit.space ? `${armName(arm)}'s home entry` : `${armName(arm)}'s star`;
  }
  return [mine, [players.length ? 'for you' : '', ...others, what].filter(Boolean).join(' · ')];
}
$('board-canvas').addEventListener('mousemove', e => {
  const canvas = e.currentTarget, tip = $('board-tip');
  const rect = canvas.getBoundingClientRect();
  const hit = spaceAt((e.clientX - rect.left) * canvas.width / rect.width,
                      (e.clientY - rect.top) * canvas.height / rect.height);
  if (!hit) { tip.style.display = 'none'; return; }
  const [name, what] = describeSquare(hit);
  tip.replaceChildren();
  const b = document.createElement('b'); b.textContent = name;
  tip.append(b, what);
  const area = $('board-area').getBoundingClientRect();
  tip.style.left = `${e.clientX - area.left + 14}px`;
  tip.style.top  = `${e.clientY - area.top + 14}px`;
  tip.style.display = 'block';
});
$('board-canvas').addEventListener('mouseleave', () => { $('board-tip').style.display = 'none'; });

// ---- Socket events ----

on('error', ({ code, message }) => {
  // A reconnect to a game that is gone (closed, or the server restarted):
  // stop trying, and say so quietly instead of a popup.
  if (code === 'GAME_GONE' || code === 'RECONNECT_FAILED') {
    setReconnectInfo(null);
    log(code === 'GAME_GONE' ? 'This game is no longer on the server (it was closed, or the server restarted).' : 'Could not reconnect to this game.');
    return;
  }
  if (code && code.startsWith('ANALYSIS')) resetAnalyzeButton();
  if (code === 'STATS_UNAVAILABLE') { statsUnavailable = true; pendingAfterRegister = null; updateLanding(); loginMsg('Accounts are off on this server: play as a guest.'); return; }
  // Login screen problems show under the form.
  if ($('screen-landing').classList.contains('active') && ['BAD_LOGIN', 'BAD_PASSWORD', 'BAD_EMAIL', 'NAME_TAKEN', 'RATE_LIMITED', 'BAD_TOKEN', 'MISSING_FIELDS'].includes(code)) {
    pendingAfterRegister = null; loginMsg(message); return;
  }
  if (code === 'NAME_TAKEN' || code === 'RATE_LIMITED' || code === 'BAD_LINK_CODE') pendingAfterRegister = null;
  alert(message);
});

// ---- Accounts: sign-in, profile, stats, history ----
// The device key (the login) lives in this browser only. The server keeps
// just its hash; see src/Accounts.js.
const KEY_STORE = 'tm.key';
let me = null;                    // { id, name } when signed in
let pendingAfterRegister = null;  // continue Create/Join after registering
let statsUnavailable = false;
let viewingStored = false;        // the analysis page is showing a past game
let storedEndedAt = null;
let profileData = null, profileTab = 'people';
const loadKey = () => { try { return localStorage.getItem(KEY_STORE); } catch { return null; } };
const saveKey = k => { try { k ? localStorage.setItem(KEY_STORE, k) : localStorage.removeItem(KEY_STORE); } catch { /* private mode */ } };

onOpen(() => { const k = loadKey(); if (k) send({ action: 'identify', key: k }); });
if (loadKey()) connect();         // sign in straight away

function updateLanding() {
  $('btn-game-profile').style.display = me ? '' : 'none';
  // Accounts unavailable on this server: guests only.
  if (statsUnavailable && !me) { loginTab('guest'); $('login-tabs').style.display = 'none'; }
}
updateLanding();

let myPrefs = {};                  // account preferences (signed in)
on('prefs', ({ prefs }) => { myPrefs = prefs ?? {}; });
on('identity', ({ player, prefs, needsPassword }) => {
  if (player && profileData) setTimeout(() => renderAccountSection(), 0);   // a rename shows at once
  if (player && needsPassword) { $('pw-pop-name').textContent = player.name; $('pw-pop').style.display = 'flex'; }
  if (!player) { saveKey(null); me = null; myPrefs = {}; } else { me = player; if (prefs) myPrefs = prefs; }
  for (const k of ['myColor', 'boardTrack', 'boardMarbles']) if (myPrefs[k] && myPrefs[k] !== settings[k]) { settings[k] = myPrefs[k]; saveSettings(); }
  applyBoardLook();
  updateLanding();

  // Signed in already: skip the login screen.
  if (me && $('screen-landing').classList.contains('active')) { myName = me.name; goHome(); }
});
on('registered', ({ player, key, linked, prefs }) => {
  saveKey(key);
  me = player; myPrefs = prefs ?? {};
  updateLanding();
  if (linked) alert(`Signed in as ${player.name} on this device.`);
  const next = pendingAfterRegister; pendingAfterRegister = null;
  if (next) next();
});
on('accountDeleted', () => {
  saveKey(null); me = null; profileData = null;
  updateLanding(); show('screen-landing');
  alert('Your account has been deleted.');
});


// Stats and Settings both come from the profile data.
let profileFrom = 'screen-home', profileTarget = 'screen-profile';
const openProfile = (target, from) => { profileTarget = target; profileFrom = from; connect(); send({ action: 'profile', ...(typeof statsFilter !== 'undefined' ? statsFilter : {}) }); };
$('btn-profile-back').addEventListener('click', () => show(profileFrom));
$('btn-settings-back').addEventListener('click', () => show(profileFrom));
$('btn-game-profile').addEventListener('click', () => openProfile('screen-settings', 'screen-game'));
const statsFilter = { players: 'all', robots: 'any' };
for (const [box, key] of [['sf-players', 'players'], ['sf-robots', 'robots']]) {
  for (const b of $(box).querySelectorAll('.chip')) b.addEventListener('click', () => {
    statsFilter[key] = b.dataset.v;
    for (const x of $(box).querySelectorAll('.chip')) x.classList.toggle('on', x === b);
    send({ action: 'profile', ...statsFilter });
  });
}

on('profile', data => { profileData = data; if (data.rating) { myRating = data.rating; renderNavMe(); } renderProfile(); show(profileTarget); });
on('history', ({ games }) => {
  if (!profileData) return;
  profileData.games.push(...games);
  renderProfile();
  if (games.length < 30) $('btn-more-games').style.display = 'none';
});
$('btn-more-games').addEventListener('click', () => {
  const last = profileData?.games.at(-1);
  if (last) send({ action: 'history', before: last.endedAt });
});

function renderProfile() {
  const d = profileData;
  if (!d) return;
  const t = d.stats.totals;
  const pct = (a, b) => (b ? `${Math.round(100 * a / b)}%` : '—');
  const nDec = t.choices + t.cube_decisions;
  const rate = nDec ? (2 * t.eq_lost + (+t.cube_eq_lost)) / nDec : null;
  const skill = rate == null ? '—' : RATINGS.find(([max]) => rate < max)[1];
  const stat = (v, k, title) => el('div', { class: 'stat', title: title ?? '' }, el('div', { class: 'v' }, String(v)), el('div', { class: 'k' }, k));
  const signed = n => `${n > 0 ? '+' : ''}${n}`;
  $('profile-stats').replaceChildren(el('div', { class: 'stat-grid' },
    stat(d.rating?.rating ?? '—', 'rating'),
    stat(skill, 'skill', rate == null ? 'Needs analysed games' : `Equity lost per decision: ${rate.toFixed(3)} (${t.analysed} games analysed)`),
    stat(t.games, 'games'),
    stat(pct(t.wins, t.games), 'won', `${t.wins} of ${t.games}; an average player would win ${pct(t.expected * t.games, t.games)}`),
    stat(signed(t.points), 'points'),
    stat(`${t.aggro_wins} / ${t.aggro_losses}`, 'aggros dealt / taken'),
  ));
  // Skill trend: equity lost per decision, game by game.
  const tr = d.stats.trend;
  if (tr.length >= 2) {
    const ns = 'http://www.w3.org/2000/svg', Wd = 600, Ht = 80;
    const ys = tr.map(x => (2 * x.eq_lost + (+x.cube_eq_lost)) / (x.choices + x.cube_decisions)), top = Math.max(0.05, ...ys);
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', `0 0 ${Wd} ${Ht}`); svg.setAttribute('preserveAspectRatio', 'none');
    const pl = document.createElementNS(ns, 'polyline');
    pl.setAttribute('points', ys.map((y, i) => `${8 + i * (Wd - 16) / (ys.length - 1)},${Ht - 6 - (y / top) * (Ht - 12)}`).join(' '));
    pl.setAttribute('fill', 'none'); pl.setAttribute('stroke', '#e94560'); pl.setAttribute('stroke-width', '2'); pl.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(pl);
    $('profile-trend').replaceChildren(el('h3', {}, 'Error rate'), svg, el('div', { class: 'muted', style: 'font-size:0.75rem' }, 'per game · lower is better'));
  } else $('profile-trend').replaceChildren();
  const h = d.stats.headToHead;
  $('profile-h2h').replaceChildren(h.length ? el('table', { class: 'ptable' },
    el('tr', {}, el('th', {}, 'Opponent'), el('th', {}, 'Games'), el('th', {}, 'Won'), el('th', {}, 'Points')),
    ...h.map(r => el('tr', {}, el('td', {}, r.name), el('td', {}, String(r.games)), el('td', {}, pct(r.wins, r.games)), el('td', {}, signed(r.points)))))
    : el('div', { class: 'muted' }, '—'));
  const games = d.games.filter(g => (statsFilter.players === 'all' || (statsFilter.players === '2' ? g.players === 2 : g.players >= 3))
    && (statsFilter.robots === 'any' || !g.vsRobot));
  $('profile-games').replaceChildren(games.length ? el('table', { class: 'ptable' },
    el('tr', {}, el('th', {}, 'When'), el('th', {}, 'Players'), el('th', {}, 'Result'), el('th', {}, 'Points'), el('th', {}, 'Error rate')),
    ...games.map(g => {
      const row = el('tr', { class: 'click', title: 'Open' },
        el('td', {}, new Date(g.endedAt).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })),
        el('td', {}, g.seats.map((x, i) => (i === g.seat ? 'You' : x.name + (x.isRobot ? ' 🤖' : ''))).join(' · ')),
        el('td', { class: g.won ? 'won' : 'lost' }, (g.won ? 'Won' : 'Lost') + (g.aggro ? ' (aggro)' : '')),
        el('td', {}, signed(g.points)),
        el('td', {}, g.errorRate == null ? '—' : eqOf(g.errorRate)));
      row.addEventListener('click', () => send({ action: 'openGame', id: g.id }));
      return row;
    })) : el('div', { class: 'muted' }, 'No games yet.'));
  $('btn-more-games').style.display = d.games.length >= 30 ? '' : 'none';
  renderAccountSection();
}

const TRACK_LOOKS = [['', 'muted track'], ['solid', 'solid track'], ['deep', 'deep track'], ['outline', 'outlined track']];
const MARBLE_LOOKS = [['', 'socketed marbles'], ['classic', 'plain marbles'], ['dark', 'dark-ringed marbles'], ['white', 'white-ringed marbles']];
function applyBoardLook() { setBoardLook({ track: settings.boardTrack, marbles: settings.boardMarbles }); if (gameState) drawBoard(gameState); }
function prefSelect(key, opts) {
  const s = el('select', {}, ...opts.map(([v, t]) => el('option', { value: v, textContent: t })));
  s.value = myPrefs[key] ?? '';
  s.addEventListener('change', () => {
    myPrefs = { ...myPrefs, [key]: s.value || undefined }; send({ action: 'setPrefs', prefs: myPrefs });

  });
  return s;
}
// Small inline editors: a value with ✎; click to edit in place.
function inlineEdit(display, makeForm) {
  const box = el('span', { class: 'inline-edit' });
  const view = () => { const pen = el('button', { class: 'icon-btn', title: 'Edit' }, '✎'); pen.addEventListener('click', () => box.replaceChildren(...makeForm(view))); box.replaceChildren(...display, pen); };
  view();
  return box;
}
function nameEditor() {
  return inlineEdit([el('b', {}, me?.name ?? '')], done => {
    const inp = el('input', { type: 'text', value: me?.name ?? '', maxLength: 20 });
    const save = () => { const n = inp.value.trim(); if (n && n !== me?.name) send({ action: 'rename', name: n }); done(); };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') done(); });
    setTimeout(() => inp.select(), 0);
    return [inp, smallBtn('Save', save, 'btn-go'), smallBtn('Cancel', done)];
  });
}
function emailEditor() {
  return inlineEdit([], done => {
    const inp = el('input', { type: 'email', value: profileData?.email ?? '', placeholder: 'you@example.com', maxLength: 200 });
    const save = () => { const e = inp.value.trim(); if (e) send({ action: 'setEmail', email: e }); done(); };
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') done(); });
    return [inp, smallBtn('Send link', save, 'btn-go'),
      ...(profileData?.email ? [smallBtn('Remove', () => { send({ action: 'clearEmail' }); done(); })] : []), smallBtn('Cancel', done)];
  });
}
function passwordEditor() {
  return inlineEdit([el('span', { class: 'muted' }, profileData?.hasPassword ? '••••••••' : 'not set')], done => {
    const cur = el('input', { type: 'password', placeholder: 'Current', maxLength: 200, autocomplete: 'current-password' });
    const nw = el('input', { type: 'password', placeholder: 'New (8+ characters)', maxLength: 200, autocomplete: 'new-password' });
    const save = () => {
      if (nw.value.length < 8) { alert('Use 8 or more characters.'); return; }
      send({ action: 'setPassword', password: nw.value, current: cur.value }); done();
    };
    return [...(profileData?.hasPassword ? [cur] : []), nw, smallBtn('Save', save, 'btn-go'), smallBtn('Cancel', done)];
  });
}
function renderAccountSection(extra) {
  const box = $('profile-account');
  const btn = (label, fn, cls = 'secondary') => { const b = el('button', { class: cls }, label); b.addEventListener('click', fn); return b; };
  const section = (title, ...kids) => el('section', { class: 'panel' }, el('h3', {}, title), ...kids);
  const row = (label, ...kids) => el('div', { class: 'set-row' }, el('div', { class: 'set-label' }, label), el('div', { class: 'set-ctl' }, ...kids));
  box.replaceChildren(
    section('Account', row('Name', nameEditor()),
      row('Email', profileData?.email ? el('span', {}, profileData.email) : el('span', { class: 'muted' }, '—'), emailEditor())),
    section('Analysis',
      row('Opens on', prefSelect('apFilter', [['', 'last used'], ['errors', 'errors only'], ['inacc', 'inaccuracies and worse'], ['all', 'all rolls']]),
        prefSelect('apPlayer', [['', 'last used'], ['me', 'my plays'], ['all', 'all players']]))),
    section('Security',
      row('Password', passwordEditor()),
      row('Devices', el('span', {}, `${profileData?.devices ?? 1} signed in`),
        ...(profileData?.devices > 1 ? [btn('Sign out the others', () => { if (confirm('Sign out every other device?')) send({ action: 'signOutOthers' }); })] : [])),
      ...(extra ? [extra] : [])),
    section('Danger zone',
      row('Account', btn('Delete account', () => {
        const c = prompt(`This deletes your account and stats for good (your past games stay in your opponents' histories, without your name). Type your name to confirm:`);
        if (c) send({ action: 'deleteAccount', confirm: c });
      }, 'secondary danger'))));
}
on('linkCode', ({ code, expiresInMin }) => renderAccountSection(el('div', {},
  el('div', { class: 'muted' }, `On your other device, open the start screen, choose "Use a link code" and enter this code within ${expiresInMin} minutes (it works once):`),
  el('div', { class: 'keybox', style: 'font-size:1.4rem;letter-spacing:2px;text-align:center' }, code))));

// A past game, opened from the history: the analysis page as a replay viewer.
on('storedGame', ({ game, report }) => {
  const mySeat = game.seats.findIndex(x => me && x.playerId === me.id);
  const last = report.rolls.at(-1)?.marbles;
  gameState = {
    players: report.players.map((p, i) => ({ index: i, name: p.name, color: p.color, isRobot: p.isRobot, marbles: last?.[i] ?? [] })),
    turnIndex: 0, phase: 'GAME_OVER', dice: null, diceUsed: [false, false], cube: null, score: null,
  };
  myPlayerIndex = mySeat >= 0 ? mySeat : 0;
  viewingStored = true;
  storedEndedAt = game.endedAt;
  analysisReport = report; apSel = -1;
  show('screen-game');
  $('win-overlay').style.display = 'none';
  initBoard($('board-canvas'));
  faceMyArm();
  openAnalysis();
  if (!report.rolls.some(r => r.analysis)) log('This game was not analysed — showing the moves only.');
});

// ---- Move feedback (robot comparison after each committed roll) ----
on('moveFeedback', fb => {
  if (fb.playerIndex !== myPlayerIndex || !settings.feedback) return;
  // A forced roll was played the only way it could be — the robot agrees.
  if (fb.forced) { pendingFeedback = { text: '✓ Robot agrees', cls: 'agree' }; return; }
  let text = fb.robotAgrees ? '✓ Robot agrees' : `Robot would play ${fb.robotMoves}`;
  if (fb.endgame) {
    text += fb.endgame.best ? ' · exact: best play'
      : ` · exact: costs +${fb.endgame.cost.toFixed(2)} turns (best ${fb.endgame.bestMoves})`;
  }
  const good = fb.robotAgrees && (!fb.endgame || fb.endgame.best);
  pendingFeedback = { text, cls: good ? 'agree' : 'differ' };
});

// ---- Post-game analysis ----
function resetAnalyzeButton() {
  const btn = $('btn-analyze');
  btn.disabled = false;
  btn.textContent = matchOver && matchGames.length > 1 ? 'Analyze Match' : 'Analyze Game';
}
// ---- Several games (a match): one report per game, by game number ----
const reports = new Map();         // game number → report
let curGame = null;                // game shown on the analysis page (null = match view)
let matchGames = [];               // finished games of this match/session: { n, score, result, winner }
let lastGameNo = null;
let matchOver = false;
const inMatch = () => !!gameState?.match;
$('btn-analyze').addEventListener('click', () => {
  if (reports.has(lastGameNo)) { showGame(lastGameNo); return; }
  const btn = $('btn-analyze');
  btn.disabled = true;
  btn.textContent = 'Analyzing…';
  if (inMatch() && matchGames.length > 1) send({ action: 'analyzeMatch' });
  else send({ action: 'analyzeGame', game: lastGameNo ?? undefined });
});
on('analysisProgress', ({ done, total, game }) => {
  if (game === waitingFor) $('ap-status').replaceChildren(el('span', {}, `Game ${game}: analysing… ${done}/${total}`));
  $('btn-analyze').textContent = matchGames.length > 1 ? `Analyzing game ${game}… ${done}/${total}` : `Analyzing… ${done}/${total}`;
});
on('analysisQueued', ({ game, ahead }) => {
  if (game === waitingFor) $('ap-status').replaceChildren(el('span', {}, `Game ${game}: queued${ahead > 0 ? ` (${ahead} ahead)` : ''}…`)); if (matchGames.length > 1) $('btn-analyze').textContent = `Game ${game} queued…`; });
on('analysisResult', ({ report, game }) => {
  const n = game ?? lastGameNo;
  reports.set(n, report);
  const btn = $('btn-analyze');
  btn.disabled = false;
  btn.textContent = matchGames.length > 1 ? 'Show Analysis' : 'Show Analysis';
  // Open the page on the first report; later games of a match just appear in the tabs.
  if (!$('game-layout').classList.contains('analysis-mode') || curGame === n || waitingFor === n) showGame(n);
  else renderGameTabs();
});
let waitingFor = null;
// Show one game's analysis (fetching it if needed), or the match view.
function showGame(n) {
  if (n === 'match') { curGame = null; openAnalysis(true); return; }
  const rep = reports.get(n);
  if (!rep) {
    waitingFor = n; send({ action: 'analyzeGame', game: n }); renderGameTabs();
    $('ap-status').replaceChildren(el('span', {}, `Game ${n}: analysing…`));
    return;
  }
  waitingFor = null;
  curGame = n;
  analysisReport = rep;
  deepening.clear(); cubeDeep.clear(); apSel = -1; apCube = null;
  openAnalysis();
}
// Tabs: Game 1 · Game 2 · … · Match (only when there is more than one game).
function renderGameTabs() {
  const box = $('ap-games');
  if (matchGames.length < 2 || viewingStored) { box.replaceChildren(); box.style.display = 'none'; return; }
  box.style.display = 'flex';
  const tab = (key, label, title) => {
    const b = el('button', { class: 'tab' + ((key === 'match' ? curGame == null : curGame === key) ? ' on' : ''), title }, label);
    b.addEventListener('click', () => showGame(key));
    return b;
  };
  box.replaceChildren(...matchGames.map(g => tab(g.n, `Game ${g.n}`,
    `${g.winner != null ? playerName(g.winner) + ' won' : ''}${g.result ? ` ${g.result.points} pt` : ''}${reports.has(g.n) ? '' : ' · not analysed yet'}`)),
    tab('match', 'Match', 'All games together'));
}
// The match view: everyone's numbers over all analysed games, and the games.
function renderMatchView() {
  const reps = matchGames.map(g => reports.get(g.n)).filter(Boolean);
  const base = reps[0];
  $('ap-status').replaceChildren(el('span', {}, `${reps.length} of ${matchGames.length} games analysed` + (reps.length < matchGames.length ? ' · open a game to analyse it' : '')));
  if (base) {
    analysisReport = { players: base.players, winner: null, rolls: reps.flatMap(r => r.rolls), cube: reps.flatMap(r => r.cube ?? []) };
    renderSummary();
    $('ap-status').prepend(el('span', {}, 'Whole match · '));
  } else $('ap-summary').replaceChildren();
  $('ap-chart').replaceChildren();
  $('ap-detail').replaceChildren();
  $('ap-moves').replaceChildren(...matchGames.map(g => {
    const row = el('div', { class: 'ap-row', style: 'grid-template-columns: 5em 1fr auto' },
      el('span', {}, `Game ${g.n}`),
      el('span', {}, `${g.winner != null ? playerName(g.winner) + ' won' : ''}${g.result ? ` · ${g.result.points} pt${g.result.points === 1 ? '' : 's'}${g.result.baggro ? ' (baggro)' : g.result.aggro ? ' (aggro)' : g.result.dropped ? ' (drop)' : ''}` : ''}${g.score ? ` · ${g.score.join('–')}` : ''}`),
      el('span', { class: 'muted' }, reports.has(g.n) ? 'open ›' : 'analyse ›'));
    row.addEventListener('click', () => showGame(g.n));
    return row;
  }));
}

// ---- Analysis page ----
// Every roll of the game in a list; the board shows the position of the
// selected roll, or the result of one of its options. Rolls with one way to
// play (or none) are correct by definition; the others were rolled out.
let analysisReport = null;
let apSel = -1;          // selected roll index
let apOpt = null;        // selected option index within the roll, or null = position before the roll
const SEV_LABEL = { error: 'Error', blunder: 'Blunder' };
const pts = x => (100 * x).toFixed(1);
// Everything evaluative is shown in equity: decimals of the stake (losing a
// game = 1.0). A move's win-chance loss x is 2x in equity.
const eqOf = x => (2 * x).toFixed(3);
const eqv = x => x.toFixed(3);
const pctTxt = x => `${Math.round(100 * x)}%`;
const colorVar = c => `var(--${dc(c)})`;

// Error-rate bands: equity lost per decision (moves and cube). Calibrated by
// tools/calibrate-ratings.mjs at the "checked" level: the robot ≈ 0.007,
// robot with 20% random plays ≈ 0.019, 50% random ≈ 0.051, all random ≈ 0.057.
const RATINGS = [[0.008, 'World Class'], [0.013, 'Expert'], [0.020, 'Advanced'], [0.030, 'Intermediate'], [0.045, 'Casual'], [Infinity, 'Beginner']];

function playerStats(rep, pi) {
  const rolls = rep.rolls.filter(r => r.pi === pi);
  const choices = rolls.filter(r => r.analysis);
  const sev = k => choices.filter(r => r.analysis.severity === k).length;
  // Every loss beyond the rollout noise counts, however small (a difference
  // inside the noise counts as 0; instant evaluations have no noise).
  const lost = choices.reduce((s, r) => s + (r.analysis.loss > 1.96 * (r.analysis.se ?? 0) ? r.analysis.loss : 0), 0);
  const cube = cubeStats(rep, pi);
  // One game, one score: moves and cube decisions together, in equity
  // (a move's win-chance loss x is 2x equity; cube losses already are).
  const moveEq = 2 * lost;
  const decisions = choices.length + cube.cubeN;
  const eqLost = moveEq + cube.cubeLost;
  const eqRate = decisions ? eqLost / decisions : 0;
  return {
    rolls: rolls.length, forced: rolls.length - choices.length, choices: choices.length,
    agree: choices.filter(r => r.analysis.robotAgrees).length,
    moveError: sev('error'), moveBlunder: sev('blunder'), moveEq,
    error: sev('error') + cube.cubeError, blunder: sev('blunder') + cube.cubeBlunder,
    decisions, eqLost, eqRate,
    rating: decisions ? RATINGS.find(([max]) => eqRate < max)[1] : '—',
    ...cube,
  };
}
function cubeStats(rep, pi) {
  const mine = (rep.cube ?? []).filter(c => c.pi === pi && c.analysis && !c.analysis.skip);
  const bad = mine.filter(c => c.analysis.severity !== 'ok');
  return { cubeN: mine.length, cubeError: bad.filter(c => c.analysis.severity === 'error').length,
    cubeBlunder: bad.filter(c => c.analysis.severity === 'blunder').length,
    // Every wrong cube action that isn't a close call counts, per unit of cube.
    cubeLost: mine.filter(c => !c.analysis.close && c.analysis.played !== c.analysis.best)
      .reduce((x, c) => x + (c.analysis.lossNorm ?? c.analysis.loss), 0), cubePending: (rep.cube ?? []).some(c => c.pi === pi && c.pending) };
}

// A small "?" whose explanation shows on hover, or on tap (touch screens).
const help = tip => {
  const h = el('span', { class: 'help', title: tip }, '?');
  h.addEventListener('click', e => {
    e.stopPropagation();
    const open = h.nextElementSibling?.classList.contains('help-tip');
    if (open) h.nextElementSibling.remove(); else h.after(el('span', { class: 'help-tip' }, tip));
  });
  return h;
};
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v; else if (k === 'style') e.style.cssText = v; else e[k] = v;
  }
  for (const c of kids) e.append(c);
  return e;
}

function loadApView() { try { return JSON.parse(localStorage.getItem('apView') ?? '{}'); } catch { return {}; } }
const apSession = {};
function saveApView() { apSession.filter = $('ap-filter').value; apSession.player = $('ap-player').value; try { localStorage.setItem('apView', JSON.stringify({ filter: $('ap-filter').value, player: $('ap-player').value })); } catch {} }
for (const id of ['ap-filter', 'ap-player']) $(id).addEventListener('change', saveApView);
function openAnalysis(matchView = false) {
  $('game-layout').classList.add('analysis-mode');
  $('analysis-panel').style.display = 'flex';
  renderGameTabs();
  if (matchView) { renderMatchView(); return; }
  const rep = analysisReport;
  if (!rep) return;
  renderSummary();

  const sel = $('ap-player');
  sel.replaceChildren(el('option', { value: 'all', textContent: 'All players' }),
    ...rep.players.map((p, i) => el('option', { value: String(i), textContent: p.name })));
  // Default view: my own errors.
  const analysed = rep.rolls.some(r => r.analysis);
  if (myPlayerIndex != null && rep.players[myPlayerIndex]) { sel.value = String(myPlayerIndex); $('ap-filter').value = analysed ? 'errors' : 'all'; }
  else { sel.value = 'all'; $('ap-filter').value = 'all'; }
  // Sticky: once chosen, the filter and player stay across games (and visits).
  // This session's choice, else the account's preference, else the last choice in this browser.
  const last = loadApView();
  const filter = apSession.filter ?? myPrefs.apFilter ?? last.filter;
  const player = apSession.player ?? (myPrefs.apPlayer === 'all' ? 'all' : myPrefs.apPlayer === 'me' && myPlayerIndex != null ? String(myPlayerIndex) : null) ?? last.player;
  if (filter) $('ap-filter').value = filter;
  if (player && [...sel.options].some(o => o.value === player)) sel.value = player;
  drawChart();
  renderMoveList();
  const firstErr = rep.rolls.findIndex(r => r.pi === myPlayerIndex && r.analysis && r.analysis.severity !== 'ok');
  selectRoll(firstErr >= 0 ? firstErr : 0);
}

// How much work is behind the report: estimates vs played-out decisions.
let playingOutAll = false;
function renderStatus() {
  const rep = analysisReport;
  if (!rep) return;
  const dec = rep.rolls.filter(r => r.analysis);
  const played = dec.filter(r => !r.analysis.estimate);
  const games = played.reduce((s, r) => s + r.analysis.options.reduce((x, o) => x + (o.n ?? 0), 0), 0);
  const cubeGames = (rep.cube ?? []).reduce((s, c) => s + (c.analysis?.n ?? 0), 0);
  const parts = [`${dec.length} decisions`, `${dec.length - played.length} estimated`,
    `${played.length} played out (${(games + cubeGames).toLocaleString()} games)`];
  if (deepening.size) parts.push(`checking ${deepening.size}…`);
  // Clocks: the quick pass, the base play-outs, Play out all.
  const t = rep.timing ?? {}, clock = ms => ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.floor(ms / 60000)}:${String(Math.round(ms / 1000) % 60).padStart(2, '0')}`;
  const tp = [];
  if (t.quickMs != null) tp.push(`quick ${clock(t.quickMs)}`);
  if (t.playoutMs != null) tp.push(`play-outs ${clock(t.playoutMs)}`);
  else if (apPhase.playout) tp.push(`play-outs ${clock(Date.now() - apPhase.playout)}…`);
  if (t.playOutAllMs != null) tp.push(`play out all ${clock(t.playOutAllMs)}`);
  else if (apPhase.all) tp.push(`play out all ${clock(Date.now() - apPhase.all)}…`);
  if (tp.length) parts.push('⏱ ' + tp.join(' · '));
  const kids = [el('span', { title: 'Estimated = judged instantly by the formula (one roll ahead). Played out = options played to the end many times.' }, parts.join(' · '))];
  if (!viewingStored && dec.some(r => (r.analysis.level ?? 0) < 2)) {
    const b = el('button', { class: 'secondary', title: 'Play out every decision at the deep level (minutes; runs in the background)' },
      playingOutAll ? 'Playing out all…' : 'Play out all');
    b.disabled = playingOutAll;
    b.addEventListener('click', () => { send({ action: 'playOutAll', game: curGame ?? undefined }); });
    kids.push(b);
  }
  $('ap-status').replaceChildren(...kids);
}
on('playOutAll', ({ running, game, started, timing }) => {
  if (game != null && game !== curGame) return;
  playingOutAll = running;
  if (started) apPhase.all = Date.now();
  if (!running) { apPhase.all = null; if (timing && analysisReport) analysisReport.timing = timing; }
  renderStatus();
});
// Analysis clocks (client-side tick while something runs).
const apPhase = { playout: null, all: null };
on('analysisPhase', ({ game, phase }) => { if (game != null && game !== curGame) return; if (phase === 'playout') apPhase.playout = Date.now(); renderStatus(); });
on('analysisTiming', ({ game, timing }) => {
  const rep = reports.get(game) ?? (game === curGame ? analysisReport : null);
  if (rep) rep.timing = timing;
  if (game == null || game === curGame) { apPhase.playout = null; renderStatus(); }
});
setInterval(() => { if ((apPhase.playout || apPhase.all) && $('game-layout').classList.contains('analysis-mode')) renderStatus(); }, 1000);

// Hover text splitting a combined number into moves and cube.
function cubeSplit(s, f) { return (analysisReport?.cube ?? []).length ? f(s) : ''; }

function renderSummary() {
  renderStatus();
  const rep = analysisReport;
  // Summary table, one column per player.
  const stats = rep.players.map((_, i) => playerStats(rep, i));
  const head = el('tr', {}, el('th'), ...rep.players.map((p, i) =>
    el('th', {}, el('span', { class: 'log-dot', style: `background:${colorVar(p.color)};margin-right:4px` }),
      p.name + (rep.winner === i ? ' 🏆' : ''))));
  const row = (label, f, title) => el('tr', title ? { title } : {}, el('td', {}, label), ...stats.map(s => el('td', {}, f(s))));
  const table = el('table', {}, el('thead', {}, head), el('tbody', {},
    row('Rating', s => el('span', { class: 'rating' }, s.rating), 'From the error rate'),
    row('Error rate', s => s.decisions ? `${s.eqRate.toFixed(3)} per decision` : '—',
      'Average equity lost per decision — moves and cube together (clear errors only); losing a game = 1.0'),
    row('Equity lost', s => el('span', { title: cubeSplit(s, x => `${eqv(x.moveEq)} on moves, ${eqv(x.cubeLost)} on the cube`) }, eqv(s.eqLost)),
      'Total over the game, moves and cube together'),
    row('Errors / Blunders', s => el('span', { title: cubeSplit(s, x => `moves ${x.moveError} / ${x.moveBlunder}, cube ${x.cubeError} / ${x.cubeBlunder}`) },
      el('span', { class: s.error ? 'sev-error' : '' }, String(s.error)), ' / ',
      el('span', { class: s.blunder ? 'sev-blunder' : '' }, String(s.blunder)), s.cubePending ? ' …' : ''),
      'Moves and cube decisions together. Error: 0.06–0.20 equity lost. Blunder: 0.20 or more'),
  ));
  $('ap-summary').replaceChildren(table);
}

// ---- Go deeper on one decision ----
const LEVEL_NAMES = ['instant', 'checked', 'deep', 'deepest'];
const deepening = new Set();       // roll indexes being redone
function analyzeDeeper(idx) {
  const a = analysisReport?.rolls[idx]?.analysis;
  if (!a || (a.level ?? 0) >= LEVEL_NAMES.length - 1 || deepening.has(idx)) return;
  send({ action: 'analyzeDeeper', idx, game: curGame ?? undefined });
}
const deepQueued = new Set();       // Go deeper requests waiting for the base analysis
on('analysisDeepening', ({ idx, game, queued }) => {
  if (game != null && game !== curGame) return;
  deepening.add(idx);
  if (queued) deepQueued.add(idx); else deepQueued.delete(idx);
  if ($('game-layout').classList.contains('analysis-mode')) { renderMoveList(); renderStatus(); }
  if (idx === apSel) selectRoll(apSel, apOpt === 'played' || apOpt === 'before' ? apOpt : null);
});
on('cubeUpdate', ({ i, analysis, failed, game }) => {
  const rep0 = reports.get(game ?? curGame);
  if (game != null && game !== curGame) { const c0 = rep0?.cube?.[i]; if (c0) { c0.analysis = analysis; c0.pending = false; } return; }
  cubeDeep.delete(i);
  if (failed) log('Deeper cube analysis failed — try again.');
  const c = analysisReport?.cube?.[i];
  if (!c) return;
  c.analysis = analysis; c.pending = false;
  if (!$('game-layout').classList.contains('analysis-mode')) return;
  renderSummary();
  renderMoveList();
  if (apCube === i) selectCube(i); else drawChart();
});
on('cubeFeedback', ({ playerIndex, text, agrees }) => {
  if (playerIndex !== myPlayerIndex || !settings.feedback) return;
  log(`↳ cube: ${text}`, null, `log-feedback ${agrees ? 'agree' : 'differ'}`);
});

on('analysisUpdate', ({ idx, analysis, failed, game }) => {
  if (game != null && game !== curGame) { const r0 = reports.get(game)?.rolls?.[idx]; if (r0) r0.analysis = analysis; return; }
  deepening.delete(idx); deepQueued.delete(idx);
  if (!analysisReport?.rolls[idx]) return;
  analysisReport.rolls[idx].analysis = analysis;
  if (!$('game-layout').classList.contains('analysis-mode')) return;
  renderSummary();
  renderMoveList();
  if (idx === apSel) selectRoll(apSel, typeof apOpt === 'number' ? null : apOpt);
  else drawChart();
  if (failed) log('Deeper analysis failed — try again.');
});

function closeAnalysis() {
  $('game-layout').classList.remove('analysis-mode');
  $('analysis-panel').style.display = 'none';
  if (viewingStored) {
    viewingStored = false; gameState = null; analysisReport = null;
    show('screen-profile');
    return;
  }
  resizeBoard();
  if (gameState) drawBoard(gameState);
}
$('btn-close-analysis').addEventListener('click', closeAnalysis);
$('ap-filter').addEventListener('change', renderMoveList);
$('ap-player').addEventListener('change', renderMoveList);

// The move list: rolls, with each cube decision just before the roll it
// preceded. Items: { type: 'roll', r, idx } | { type: 'cube', c }.
function visibleItems() {
  const f = $('ap-filter').value, who = $('ap-player').value;
  // Skipped no-doubles (nowhere near the window) only show under "All rolls".
  const cubeOk = c => (c.analysis?.skip !== true || f === 'all') && (who === 'all' || c.pi === Number(who)) &&
    (f === 'all' || f === 'choices' || (f === 'errors' && c.analysis && c.analysis.severity !== 'ok')
      || (f === 'inacc' && c.analysis && (c.analysis.severity !== 'ok' || cubeInaccuracy(c.analysis))));
  const cubes = (analysisReport.cube ?? []).filter(cubeOk);
  const out = [];
  let k = 0;
  for (const it of visibleRolls()) {
    while (k < cubes.length && cubes[k].rollIdx <= it.idx) out.push({ type: 'cube', c: cubes[k++] });
    out.push({ type: 'roll', ...it });
  }
  while (k < cubes.length) out.push({ type: 'cube', c: cubes[k++] });
  return out;
}
const itemKey = it => (it.type === 'cube' ? 'c' + it.c.i : 'r' + it.idx);
let apCube = null;                 // selected cube decision (index into report.cube), or null

function visibleRolls() {
  const f = $('ap-filter').value, who = $('ap-player').value;
  return analysisReport.rolls.map((r, idx) => ({ r, idx })).filter(({ r }) =>
    (who === 'all' || r.pi === Number(who)) &&
    (f === 'all' || (f === 'choices' && r.analysis) || (f === 'errors' && r.analysis && r.analysis.severity !== 'ok')
      || (f === 'inacc' && r.analysis && (r.analysis.severity !== 'ok' || isInaccuracy(r.analysis)))));
}

// Inaccuracy: a real loss (clear of the noise, at least 0.01 equity) below the error threshold.
const isInaccuracy = a => a && a.severity === 'ok' && 2 * a.loss >= 0.01 && a.loss > 1.96 * (a.se ?? 0);
const cubeInaccuracy = a => a && !a.skip && a.severity === 'ok' && !a.close && a.played !== a.best && a.lossNorm >= 0.01;
function badgeFor(r, idx) {
  if (deepening.has(idx)) return deepQueued.has(idx)
    ? el('span', { class: 'badge unclear', title: 'Go deeper starts when the base analysis finishes' }, 'queued')
    : el('span', { class: 'badge unclear', title: 'Being played out to check the estimate' }, 'checking…');
  if (!r.analysis) return el('span', { class: 'badge forced', title: r.played === '--' ? 'No legal move' : 'Only one way to play' }, 'forced ✓');
  const a = r.analysis;
  if (a.severity === 'ok' && a.loss >= 0.03) {
    return el('span', { class: 'badge unclear', title: `Maybe −${eqOf(a.loss)}, but within the noise (± ${eqOf(1.96 * a.se)}). Go deeper (+) to settle it.` }, `−${eqOf(a.loss)}?`);
  }
  if (isInaccuracy(a)) return el('span', { class: 'badge inacc', title: `Inaccuracy: −${eqOf(a.loss)} equity against the best play (below the error threshold of 0.06)` }, `−${eqOf(a.loss)}`);
  if (a.severity === 'ok') return el('span', { class: 'badge ok', title: a.loss > 0 ? `−${eqOf(a.loss)} ± ${eqOf(1.96 * a.se)}: within the noise` : 'Best play' }, '✓');
  return el('span', { class: `badge ${a.severity}`, title: `${SEV_LABEL[a.severity]}: ${eqOf(a.loss)} equity worse than the best play (± ${eqOf(1.96 * a.se)})` },
    `${SEV_LABEL[a.severity]} −${eqOf(a.loss)}`);
}

function renderMoveList() {
  const rep = analysisReport;
  const box = $('ap-moves');
  // Cube decisions sit on the roll that follows them, as a small cube (like
  // backgammon apps); only one with no roll after it (a drop) gets its own row.
  const list = [];
  for (const it of visibleItems()) {
    const prev = list.at(-1);
    if (it.type === 'roll' && prev?.type === 'cube' && prev.c.rollIdx === it.idx) {
      const cubes = [];
      while (list.at(-1)?.type === 'cube' && list.at(-1).c.rollIdx === it.idx) cubes.unshift(list.pop().c);
      list.push({ ...it, cubes });
    } else list.push(it);
  }
  box.replaceChildren(...list.map(it => {
    if (it.type === 'cube') return cubeRow(it.c);
    const { r, idx } = it;
    const p = rep.players[r.pi];
    const rowEl = el('div', { class: 'ap-row' + (idx === apSel && apCube == null ? ' sel' : ''), title: p.name },
      el('span', { class: 'turn' }, `${r.turn}.`),
      el('span', { class: 'log-dot', style: `background:${colorVar(p.color)}` }),
      el('span', {}, r.dice.join('-')),
      el('span', { class: 'play' }, r.played, ...(it.cubes ?? []).map(inlineCube).filter(Boolean)),
      badgeFor(r, idx));
    rowEl.dataset.idx = idx;
    rowEl.dataset.key = 'r' + idx;
    if (it.cubes) rowEl.dataset.cubes = it.cubes.map(c => 'c' + c.i).join(' ');
    rowEl.addEventListener('click', () => selectRoll(idx));
    return rowEl;
  }));
  if (!list.length) box.append(el('div', { class: 'muted', style: 'padding:6px' }, 'Nothing to show.'));
}

// Draw a position; with `movedFrom` (the position before the roll), arrows
// show which marbles moved where, and red dashed arrows show bumped marbles.
// `steps` (one per die: { marbleId, from, to, die }) draws one arrow per die,
// numbered with the die; without steps, one arrow per marble that moved.
function showPosition(marbles, movedFrom, mover, steps) {
  if (!gameState || !marbles) return;
  resizeBoard();
  const gs = { ...gameState, players: gameState.players.map((p, i) => ({ ...p, marbles: marbles[i] ?? p.marbles })) };
  drawBoard(gs, { instantHub: true });
  if (movedFrom) {
    const moves = [];
    marbles.forEach((ms, pi) => ms.forEach((m, k) => {
      const o = movedFrom[pi]?.[k];
      if (!o || JSON.stringify(o) === JSON.stringify(m)) return;
      if (pi === mover && steps?.length) return;         // drawn die by die below
      moves.push({ from: o, to: m, playerIndex: pi, bumped: pi !== mover });
    }));
    for (const st of steps ?? []) {
      moves.push({ from: { ...st.from, id: st.marbleId }, to: { ...st.to, id: st.marbleId }, playerIndex: mover, label: st.die });
    }
    drawMoveArrows(moves);
  }
}

// The position after roll i was played = the position at the next roll.
function afterOf(i) { return analysisReport.rolls[i + 1]?.marbles ?? null; }

function diceEl(dice, color) {
  return el('span', { class: 'ap-dice' }, ...dice.map(d =>
    el('span', { class: 'die small', style: `--die-color:${colorVar(color)}` }, String(d))));
}

// ---- Cube decisions on the analysis page ----
const CUBE_ACTION = { double: a => (a ? 'Doubles' : 'No double'), take: a => (a ? 'Takes' : 'Drops') };
const cubeDeep = new Set();        // cube decisions being redone deeper
function cubeBadge(c) {
  const a = c.analysis;
  if (!a || cubeDeep.has(c.i)) return el('span', { class: 'badge unclear' }, 'checking…');
  if (a.skip) return el('span', { class: 'badge forced', title: 'Nowhere near a double (estimate under 60% to win), so not analysed. Click the row to analyse it anyway.' }, '—');
  if (a.severity === 'ok') return el('span', { class: a.close ? 'badge unclear' : 'badge ok', title: a.close ? "Close call: within the estimate's noise" : 'Right decision' }, a.close ? 'close ✓' : '✓');
  return el('span', { class: `badge ${a.severity}`, title: `${SEV_LABEL[a.severity]}: lost ${eqv(a.loss)} equity` }, `${a.label ?? SEV_LABEL[a.severity]} −${eqv(a.loss)}`);
}
function analyzeDeeperCube(i) {
  const c = analysisReport?.cube?.[i];
  if (!c || viewingStored || cubeDeep.has(i) || c.analysis?.exact) return;
  send({ action: 'analyzeDeeperCube', i, game: curGame ?? undefined });
}
on('cubeDeepening', ({ i, game }) => {
  if (game != null && game !== curGame) return;
  cubeDeep.add(i);
  if (!$('game-layout').classList.contains('analysis-mode')) return;
  renderMoveList();
  if (apCube === i) selectCube(i);
});
// A cube decision on its roll's row: a small cube with the value at stake,
// red for a blunder, amber for an error. Plain right no-doubles aren't shown.
function inlineCube(c) {
  const a = c.analysis;
  const bad = a && !a.skip && a.severity !== 'ok';
  if (!c.action && !bad && !cubeInaccuracy(a) && !(apCube === c.i)) return null;
  const p = analysisReport.players[c.pi];
  const what = CUBE_ACTION[c.kind](c.action) + (c.kind === 'double' && c.action ? ` to ${c.v * 2}` : '');
  const tip = `${p.name}: ${what}` + (!a ? ' · being worked out' : bad ? ` · ${a.label ?? SEV_LABEL[a.severity]}, −${eqv(a.loss)}` : a.close ? ' · close call' : ' · right') + ' · click for details';
  const b = el('span', { class: 'cube-ico inline' + (bad ? ' ' + a.severity : '') + (apCube === c.i ? ' sel' : ''), title: tip },
    String(c.kind === 'double' && !c.action ? c.v : c.v * 2));
  b.dataset.key = 'c' + c.i;
  b.addEventListener('click', e => { e.stopPropagation(); selectCube(c.i); });
  return b;
}
function cubeRow(c) {
  const p = analysisReport.players[c.pi];
  const label = CUBE_ACTION[c.kind](c.action) + (c.kind === 'double' && c.action ? ` → ${c.v * 2}` : '');
  const rowEl = el('div', { class: 'ap-row cube-row' + (apCube === c.i ? ' sel' : ''), title: `${p.name}: cube decision` },
    el('span', { class: 'turn' }, `${c.turn}.`),
    el('span', { class: 'log-dot', style: `background:${colorVar(p.color)}` }),
    el('span', { class: 'cube-ico', title: `Cube at ${c.v}` }, String(c.v)),
    el('span', { class: 'play' }, label),
    cubeBadge(c));
  rowEl.dataset.key = 'c' + c.i;
  rowEl.addEventListener('click', () => selectCube(c.i));
  return rowEl;
}
function markSelected(key) {
  for (const rowEl of $('ap-moves').children) rowEl.classList.toggle('sel', rowEl.dataset.key === key || (rowEl.dataset.cubes ?? '').split(' ').includes(key));
  for (const b of $('ap-moves').querySelectorAll('.cube-ico.inline')) b.classList.toggle('sel', b.dataset.key === key);
  $('ap-moves').querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
}
function selectCube(i) {
  const rep = analysisReport;
  const c = rep?.cube?.[i];
  if (!c) return;
  apCube = i; apSel = Math.min(c.rollIdx, rep.rolls.length - 1); apOpt = null;
  markSelected('c' + i);
  drawChart();
  const p = rep.players[c.pi];
  const a = c.analysis;
  const kids = [el('div', { class: 'ap-title' }, el('span', { class: 'cube-ico big' }, String(c.v)),
    el('b', {}, `Turn ${c.turn} · ${p.name}`), el('span', { class: 'muted' }, ` ${CUBE_ACTION[c.kind](c.action).toLowerCase()} (cube at ${c.v})`))];
  if (!a) kids.push(el('div', { class: 'muted' }, '…'));
  else if (a.skip) kids.push(el('div', { class: 'muted' }, `Not near a double (${a.p != null ? (100 * a.p).toFixed(0) + '%' : '<60%'}) — skipped`));
  else {
    const isDouble = c.kind === 'double';
    kids.push(el('div', { class: 'ap-opt head' }, el('span', {}, 'Decision'), el('span'), el('span', { class: 'num', title: 'Equity: expected stake won (+) or lost (−), at this cube' }, 'Equity'), el('span')));
    // A double is worth the lower of take and drop (the opponent's best answer):
    // that row carries the double's tags.
    const dblKey = isDouble ? (a.options[1].eq <= a.options[2].eq ? 'dt' : 'dp') : null;
    for (const o of a.options) {
      const side = o.key === 'nd' ? 'no double' : o.key === dblKey ? 'double' : null;
      const bestHere = isDouble ? side != null && a.best === side : o.key === a.best;
      const playedHere = isDouble ? side != null && a.played === side : o.key === a.played;
      const tag = [bestHere ? 'best' : '', playedHere ? 'played' : ''].filter(Boolean).join(' · ');
      kids.push(el('div', { class: 'ap-opt' }, el('span', {}, o.label, el('span', { class: 'tags' }, tag)), el('span'),
        el('span', { class: 'num' }, (o.eq > 0 ? '+' : '') + eqv(o.eq)), el('span')));
    }
    kids.push(el('div', { class: 'fact' }, `${p.name} ${(100 * a.p).toFixed(1)}%` +
      (a.aggroWin || a.aggroLoss ? ` (aggro ${(100 * a.aggroWin).toFixed(1)}% / ${(100 * a.aggroLoss).toFixed(1)}%)` : '') +
      (a.exact ? ' · exact' : '')));
    const verdict = a.severity !== 'ok' ? `${a.label ?? SEV_LABEL[a.severity]}: −${eqv(a.loss)}`
      : a.close ? 'Close' : '✓';
    kids.push(el('div', { class: 'muted' }, verdict + (a.match ? ` · ${isDouble ? a.match.a : a.match.b}-away / ${isDouble ? a.match.b : a.match.a}-away` : ''),
      help((a.match ? `Match equity in game units (EMG), from ${p.name}'s side.` : `Equity at cube ${c.v}, from ${p.name}'s side; losing a game at cube 1 = −1.`)
        + (isDouble ? ' A double is worth the lower of take and drop.' : '') + ' Janowski model, cube efficiency 0.68.'
        + (a.exact ? ' Chances exact (duel table).' : ` Chances from ${a.n} played-out games.`))));
  }
  // Depth, and going deeper (more games; or analyse a skipped no-double anyway).
  if (a && !a.exact) {
    const depth = el('div', { class: 'ap-depth' }, el('span', { class: 'muted' }, a.skip ? 'Not analysed' : `Depth: ${a.n} games`));
    const LV = [400, 1600, 6400];
    const next = a.skip ? LV[0] : LV[(a.level ?? 0) + 1];
    if (cubeDeep.has(i)) depth.append(el('span', { class: 'muted' }, ' · going deeper…'));
    else if (next && !viewingStored) {
      const b = el('button', { class: 'secondary ap-view', title: 'Redo this cube decision with more games (+)' },
        a.skip ? `Analyse anyway (${next} games)` : `Go deeper (+) → ${next.toLocaleString()} games`);
      b.addEventListener('click', () => analyzeDeeperCube(i));
      depth.append(b);
    }
    kids.push(depth);
  }
  $('ap-detail').replaceChildren(...kids);
  showPosition(c.marbles);
}

function selectRoll(idx, opt = null) {
  const rep = analysisReport;
  if (!rep || idx < 0 || idx >= rep.rolls.length) return;
  apSel = idx; apOpt = opt; apCube = null;
  const r = rep.rolls[idx];
  markSelected('r' + idx);
  $('ap-moves').querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  drawChart();

  const p = rep.players[r.pi];
  const box = $('ap-detail');
  const after = afterOf(idx);
  // Views: 'before' (just rolled), 'played' (what was played, with arrows), or an option index.
  const view = opt ?? (after ? 'played' : 'before');
  apOpt = view;
  const title = el('div', { class: 'ap-title' }, diceEl(r.dice, p.color),
    el('b', {}, `Turn ${r.turn} · ${p.name}`), el('span', { class: 'muted' }, ` played ${r.played}`));
  const viewBtn = (key, label, tip) => {
    const b = el('button', { class: 'secondary ap-view' + (view === key ? ' on' : ''), title: tip }, label);
    b.addEventListener('click', () => selectRoll(idx, key));
    return b;
  };
  const kids = [title, el('div', { class: 'ap-views' },
    viewBtn('before', 'Before', 'The board right after the roll, before moving (B)'),
    ...(after ? [viewBtn('played', 'Played', 'What was played: arrows show who moved where (P)')] : []))];
  if (!r.analysis) {
    kids.push(el('div', { class: 'muted' }, r.played === '--' ? 'No legal move — nothing to decide.'
      : 'Only one way to play this roll — correct by definition.'));
  } else {
    const a = r.analysis;
    kids.push(el('div', { class: 'ap-opt head' },
      el('span', {}, 'Options (click to see on the board)'),
      el('span', { class: 'num', title: 'Chance an opponent can hit one of these marbles with their next roll' }, 'Hit'),
      el('span', { class: 'num', title: a.valued === 'match' ? 'Equity at this match score, in game units (EMG): what each ending (single, aggro, baggro) is worth to the match'
        : a.valued === 'money' ? 'Equity: points expected per unit of cube, counting aggros (2) and baggros (3)' : 'Equity: 2 × win chance − 1' }, a.valued === 'match' ? 'EMG' : 'Equity'),
      el('span', { class: 'num' }, 'vs best')));
    a.options.forEach((o, k) => {
      const tags = [k === 0 && 'best', o.played && 'played', o.robot && 'robot'].filter(Boolean).join(' · ');
      const cls = o.played ? (a.severity === 'ok' ? ' good' : ` ${a.severity}`) : '';
      const line = el('div', { class: 'ap-opt' + cls + (view === k ? ' sel' : ''), title: `${o.n} playouts` },
        el('span', {}, o.moves, el('span', { class: 'tags' }, tags)),
        el('span', { class: 'num hit' }, o.facts && o.facts.anyHit > 0 ? pctTxt(o.facts.anyHit) : '—'),
        el('span', { class: 'num', title: o.win != null ? `wins ${pctTxt(o.win)}` : '' }, (e => `${e >= 0 ? '+' : ''}${e.toFixed(3)}`)(o.eq ?? 2 * o.win - 1)),
        el('span', { class: 'num' }, o.loss > 0 ? `−${eqOf(o.loss)}` : ''));
      line.addEventListener('click', () => selectRoll(idx, k));
      kids.push(line);
    });
    const verdict = a.severity === 'ok'
      ? (a.loss > 0 ? `✓ −${eqOf(a.loss)}${a.estimate ? '' : ` ± ${eqOf(1.96 * a.se)}`}` : '✓ Best')
      : `${SEV_LABEL[a.severity]}: −${eqOf(a.loss)}${a.estimate ? ' (estimate)' : ` ± ${eqOf(1.96 * a.se)}`}`;
    kids.push(el('div', { class: 'muted' }, `${verdict} · ${r.options} plays`,
      help(a.estimate ? 'From the instant evaluator; go deeper to play it out.'
        : `Equity lost against the best play, with its 95% noise range; a loss inside the noise counts as correct. The best few plays, yours and the robot's were played out.`)));
    const lvl = a.level ?? 0;
    const games = Math.max(...a.options.map(o => o.n ?? 0));
    const depth = el('div', { class: 'ap-depth' },
      el('span', { class: 'muted' }, a.estimate
        ? 'Depth: instant estimate (a formula, no games played)'
        : `Depth: ${LEVEL_NAMES[lvl] ?? lvl} · up to ${games} games per option${a.ms ? ` · ${(a.ms / 1000).toFixed(1)} s` : ''}`));
    if (deepening.has(idx)) depth.append(el('span', { class: 'muted' }, deepQueued.has(idx) ? ' · queued: starts when the base analysis finishes' : ' · going deeper…'));
    else if (lvl < LEVEL_NAMES.length - 1 && !viewingStored) {
      const b = el('button', { class: 'secondary ap-view', title: 'Redo this decision with more games (+)' }, `Go deeper (+) → ${LEVEL_NAMES[lvl + 1]}`);
      b.addEventListener('click', () => analyzeDeeper(idx));
      depth.append(b);
    }
    kids.push(depth);
  }
  if (r.analysis) {
    const a = r.analysis;
    const o = view === 'before' ? null : view === 'played' ? a.options.find(x => x.played) : a.options[view];
    const factsBox = renderFacts(rep, r, o, view === 'before' ? a.before : o?.facts);
    if (factsBox) kids.splice(kids.length - 1, 0, factsBox);
  }
  box.replaceChildren(...kids);
  if (view === 'before') showPosition(r.marbles);
  else if (view === 'played') showPosition(after, r.marbles, r.pi, r.steps);
  else showPosition(r.analysis.options[view].marbles, r.marbles, r.pi, r.analysis.options[view].steps);
}

// The exact facts behind an option: which of the mover's marbles can be hit
// next roll and by which rolls, and race odds for players near home.
function renderFacts(rep, r, opt, facts) {
  if (!facts) return null;
  const who = rep.players[r.pi].name;
  const lines = [];
  if (opt) {
    lines.push(el('div', { class: 'facts-head' }, `After ${opt.moves}:`));
    if (!facts.hits?.length) lines.push(el('div', { class: 'fact safe' }, `✓ None of ${who}'s marbles can be hit next roll.`));
    for (const h of facts.hits ?? []) {
      // Which rolls hit, and by whom (named when there are several opponents).
      const by = h.byOpp && rep.players.length > 2
        ? h.byOpp.map(x => `${x.rolls} by ${rep.players[x.opp]?.name ?? 'player ' + (x.opp + 1)}`).join('; ') : h.rolls;
      lines.push(el('div', { class: 'fact danger' }, el('b', {}, h.at), ` can be hit: ${pctTxt(h.p)} `, el('span', { class: 'muted' }, `(${by})`)));
    }
    if ((facts.hits?.length ?? 0) > 1) lines.push(el('div', { class: 'fact' }, `At least one hit: ${pctTxt(facts.anyHit)}`));
  }
  if (facts.duel != null) {
    lines.push(el('div', { class: 'fact' }, `🎯 Last-marble duel, exact with perfect play: ${who} wins ${(100 * facts.duel).toFixed(1)}%`));
  }
  for (const x of facts.race ?? []) {
    lines.push(el('div', { class: 'fact' }, `🏁 ${rep.players[x.pi].name} finishes next turn ${(100 * x.next).toFixed(1)}% · expected ${x.turns.toFixed(2)} turns to finish`));
  }
  if (!lines.length) return null;
  return el('div', { class: 'facts', title: 'Exact: every roll and every way to play it. Extra rolls after a 6 are not counted.' }, ...lines);
}

// Win chance through the game. For two players one line (the first player's
// chance; the other's is the rest); otherwise one line per player.
function drawChart() {
  const rep = analysisReport;
  const n = rep.rolls.length;
  const Wd = 500, Ht = 120, padX = 6, padY = 8;
  const x = i => padX + (n > 1 ? i / (n - 1) : 0.5) * (Wd - 2 * padX);
  const y = v => padY + (1 - v) * (Ht - 2 * padY);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${Wd} ${Ht}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const add = (tag, attrs) => { const e = document.createElementNS(ns, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); svg.append(e); return e; };
  add('line', { x1: 0, x2: Wd, y1: y(0.5), y2: y(0.5), stroke: '#fff3', 'stroke-dasharray': '4 4' });
  if (apSel >= 0) add('line', { x1: x(apSel), x2: x(apSel), y1: 0, y2: Ht, stroke: '#fff6' });
  const two = rep.players.length === 2;
  const lines = two ? [0] : rep.players.map((_, i) => i);
  for (const pi of lines) {
    const ptsArr = rep.rolls.map((r, i) => {
      if (!r.analysis || r.analysis.playedWin == null) return null;
      if (r.pi === pi) return [i, r.analysis.playedWin];
      return two ? [i, 1 - r.analysis.playedWin] : null;
    }).filter(Boolean);
    if (rep.winner != null) ptsArr.push([n - 1, rep.winner === pi ? 1 : 0]);
    if (!ptsArr.length) continue;
    const pl = add('polyline', { points: ptsArr.map(([i, v]) => `${x(i)},${y(v)}`).join(' '), fill: 'none', 'stroke-width': 2, 'vector-effect': 'non-scaling-stroke' });
    pl.style.stroke = colorVar(rep.players[pi].color);
  }
  rep.rolls.forEach((r, i) => {
    const a = r.analysis;
    if (!a || a.severity === 'ok') return;
    const v = two && r.pi !== 0 ? 1 - a.playedWin : a.playedWin;
    // In the colour of the player who made it; blunders bigger, with a red ring.
    const big = a.severity === 'blunder';
    const c = add('circle', { cx: x(i), cy: y(v), r: big ? 6 : 4, stroke: big ? '#ff2040' : '#000', 'stroke-width': big ? 2 : 1, style: `cursor:pointer;fill:${colorVar(rep.players[r.pi].color)}` });
    const t = document.createElementNS(ns, 'title');
    t.textContent = `Turn ${r.turn} ${rep.players[r.pi].name}: ${SEV_LABEL[a.severity]} −${eqOf(a.loss)}`;
    c.append(t);
    c.addEventListener('click', () => selectRoll(i));
  });
  // A thin line follows the mouse; a box shows the moves around that point;
  // clicking anywhere jumps there.
  const hover = add('line', { x1: 0, x2: 0, y1: 0, y2: Ht, stroke: '#fffa', 'stroke-width': 1, 'vector-effect': 'non-scaling-stroke', visibility: 'hidden' });
  const tip = el('div', { class: 'chart-tip' });
  tip.style.display = 'none';
  const wrap = el('div', { class: 'chart-wrap' }, svg, tip);
  const idxAt = ev => {
    const box = svg.getBoundingClientRect();
    const fx = (ev.clientX - box.left) / box.width * Wd;
    return Math.max(0, Math.min(n - 1, Math.round(n > 1 ? (fx - padX) / (Wd - 2 * padX) * (n - 1) : 0)));
  };
  const lineFor = (r, i) => {
    const a = r.analysis;
    const v = !a ? '' : a.severity === 'ok' ? ' ✓' : ` · ${SEV_LABEL[a.severity]} −${eqOf(a.loss)}`;
    return el('div', { class: 'tip-line' + (i === apSel ? ' sel' : '') },
      el('span', { class: 'log-dot', style: `background:${colorVar(rep.players[r.pi].color)}` }),
      `${r.turn}. ${rep.players[r.pi].name} ${r.dice.join('-')}: ${r.played}${v}`);
  };
  svg.addEventListener('mousemove', ev => {
    const i = idxAt(ev);
    hover.setAttribute('x1', x(i)); hover.setAttribute('x2', x(i)); hover.setAttribute('visibility', 'visible');
    const from = Math.max(0, i - 2), to = Math.min(n, i + 3);
    tip.replaceChildren(...rep.rolls.slice(from, to).map((r, k) => { const d = lineFor(r, from + k); if (from + k === i) d.classList.add('cur'); return d; }));
    tip.style.display = 'block';
    const box = svg.getBoundingClientRect(), px = ev.clientX - box.left;
    tip.style.left = `${Math.min(Math.max(0, px - 120), box.width - 250)}px`;
  });
  svg.addEventListener('mouseleave', () => { hover.setAttribute('visibility', 'hidden'); tip.style.display = 'none'; });
  svg.addEventListener('click', ev => { if (ev.target.tagName !== 'circle') selectRoll(idxAt(ev)); });
  svg.style.cursor = 'crosshair';
  const label = two ? `${rep.players[0].name}'s chance to win` : 'Each player’s chance to win';
  $('ap-chart').replaceChildren(wrap, el('div', { class: 'muted', style: 'font-size:0.72rem' }, label + ' after each real choice · dots are errors · click anywhere to jump there'));
}

document.addEventListener('keydown', e => {
  if (!$('game-layout').classList.contains('analysis-mode')) return;
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.key === 'Escape') { closeAnalysis(); return; }
  if (e.key === 'b' || e.key === 'B') { selectRoll(apSel, 'before'); return; }
  if (e.key === '+' || e.key === '=') { if (apCube != null) analyzeDeeperCube(apCube); else analyzeDeeper(apSel); return; }
  if (e.key === 'p' || e.key === 'P') { selectRoll(apSel, null); return; }
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  const list = visibleItems();
  if (!list.length) return;
  const cur = apCube != null ? 'c' + apCube : 'r' + apSel;
  const pos = list.findIndex(it => itemKey(it) === cur);
  const step = (e.key === 'ArrowDown' || e.key === 'ArrowRight') ? 1 : -1;
  const next = pos < 0 ? list[0] : list[Math.max(0, Math.min(list.length - 1, pos + step))];
  if (next.type === 'cube') selectCube(next.c.i); else selectRoll(next.idx);
});

// ---- Options checkboxes ----
$('opt-feedback').checked = settings.feedback;
$('opt-analysis').checked = settings.analysis;
$('opt-numbers').checked = settings.numbers;
applyBoardLook();

// ---- Board page: my colour, track and marble looks, with a live preview ----
const BALL = { blue: '#2288f0', pink: '#e8208c', orange: '#ff7800', yellow: '#f5d000', green: '#44bb44', white: '#e0e0e0' };
function setLook(key, value) {
  settings[key] = value || undefined; saveSettings(); applyBoardLook();
  if (me) { myPrefs = { ...myPrefs, [key]: settings[key] }; send({ action: 'setPrefs', prefs: myPrefs }); }
  renderBoardPage();
}
function chip(on, label, fn, ball) {
  const b = el('button', { class: 'chip' + (on ? ' on' : '') }, ...(ball ? [el('span', { class: 'ball', style: `background: radial-gradient(circle at 35% 35%, #fff8, ${ball} 45%, #0006)` })] : []), label);
  b.addEventListener('click', fn);
  return b;
}
function previewState() {
  const mk = (zone, id, extra) => ({ id, zone, space: null, slot: null, starEligible: false, ...extra });
  return { players: [
    { index: 0, color: 'blue', name: 'You', marbles: [mk('track', 0, { space: 80 }), mk('track', 1, { space: 3 }), mk('home', 2, { slot: 4 }), mk('base', 3)] },
    { index: 1, color: 'yellow', name: 'Them', marbles: [mk('track', 0, { space: 45 }), mk('track', 1, { space: 82 }), mk('base', 2), mk('base', 3)] },
  ], turnIndex: 0, phase: 'IN_TURN', dice: null, diceUsed: [false, false] };
}
function renderBoardPage() {
  const cols = ['blue', 'pink', 'orange', 'yellow', 'green', 'white'];
  $('pick-color').replaceChildren(chip(!settings.myColor, 'As dealt', () => setLook('myColor', '')),
    ...cols.map(c => chip(settings.myColor === c, c[0].toUpperCase() + c.slice(1), () => setLook('myColor', c), BALL[c])));
  $('pick-track').replaceChildren(...TRACK_LOOKS.map(([v, t]) => chip((settings.boardTrack ?? '') === v, t.replace(' track', ''), () => setLook('boardTrack', v))));
  $('pick-marbles').replaceChildren(...MARBLE_LOOKS.map(([v, t]) => chip((settings.boardMarbles ?? '') === v, t.replace(' marbles', ''), () => setLook('boardMarbles', v))));
  // Preview: I sit at the bottom as blue, shown in my colour.
  const gs = previewState();
  const fav = settings.myColor;
  setColorShift(fav ? (armOfColor(fav) - armOfColor('blue') + 6) % 6 : 0);
  setViewArm(0);
  initBoard($('preview-canvas'));
  drawBoard(gs);
}

$('btn-board-back').addEventListener('click', () => show('screen-home'));
$('opt-numbers').addEventListener('change', e => {
  settings.numbers = e.target.checked; saveSettings();
  applySquareNumbers();
  if (gameState) drawBoard(gameState);
});
// Off hides the feedback already in the log (on shows it again).
const applyFeedbackVisibility = () => $('game-log').classList.toggle('no-feedback', !settings.feedback);
applyFeedbackVisibility();
$('opt-feedback').addEventListener('change', e => { settings.feedback = e.target.checked; if (!settings.feedback) pendingFeedback = null; applyFeedbackVisibility(); saveSettings(); });
$('opt-analysis').addEventListener('change', e => {
  settings.analysis = e.target.checked; saveSettings();
  $('btn-analyze').style.display = settings.analysis ? '' : 'none';
});

on('roomCreated', () => renderLobbyInvite());
on('roomCreated', ({ roomId: rid, code, reconnectToken, color, totalPlayers, slots, cube, matchTo }) => {
  roomId = rid;
  myPlayerIndex = 0;
  setReconnectInfo({ roomId: rid, playerIndex: 0, reconnectToken });
  $('lobby-code').textContent = code;
  $('lobby-size').textContent = `${totalPlayers} players` + (matchTo ? ` · match to ${matchTo}` : '') + (cube ? ' · doubling cube' : '');
  $('host-controls').style.display = 'flex';
  $('lobby-wait-msg').style.display = 'none';
  renderLobbySlots(slots ?? [{ index: 0, name: myName, color: color ?? 'yellow', isRobot: false, filled: true }]);
  updateStartButton();
  show('screen-lobby');
});

on('joinedRoom', ({ roomId: rid, playerIndex, lobbyState, reconnectToken }) => {
  roomId = rid;
  myPlayerIndex = playerIndex;
  setReconnectInfo({ roomId: rid, playerIndex, reconnectToken });
  $('lobby-code').textContent = lobbyState.code;
  $('lobby-size').textContent = `${lobbyState.totalPlayers} players`;
  $('host-controls').style.display = 'none';
  $('lobby-wait-msg').style.display = 'block';
  renderLobbySlots(lobbyState.slots);
  show('screen-lobby');
});

on('playerJoined', ({ playerIndex, name, color, isRobot }) => {
  const iAmHost = ($('host-controls').style.display !== 'none');
  const li = $(`slot-${playerIndex}`);
  if (!li) return;
  li.querySelector('.slot-name').textContent = name + (isRobot ? ' 🤖' : '');
  if (isRobot && iAmHost && !li.querySelector('.btn-remove-robot')) {
    const del = document.createElement('button');
    del.className = 'btn-remove-robot';
    del.textContent = '×';
    del.title = 'Remove robot';
    del.addEventListener('click', () => send({ action: 'removeRobot', playerIndex }));
    li.appendChild(del);
  }
  if (iAmHost) updateStartButton();
});

on('playerLeft', ({ playerIndex }) => {
  const li = $(`slot-${playerIndex}`);
  if (!li) return;
  li.querySelector('.slot-name').textContent = '(empty)';
  const del = li.querySelector('.btn-remove-robot');
  if (del) del.remove();
  if ($('host-controls').style.display !== 'none') updateStartButton();
});

function updateStartButton() {
  const empty = document.querySelectorAll('#lobby-slots .slot-name');
  const waiting = [...empty].filter(el => el.textContent === '(empty)').length;
  const btn = $('btn-start');
  btn.disabled = waiting > 0;
  btn.title = waiting > 0 ? `Waiting for ${waiting} more player${waiting > 1 ? 's' : ''}…` : '';
}

on('gameStarted', ({ gameState: gs }) => {
  gameState = gs;
  pendingFeedback = null;
  resetAnalyzeButton();
  analysisReport = null; apSel = -1; curGame = null; waitingFor = null;
  // A match keeps its games' reports until a new match starts.
  if (!gs.match || gs.match.score.every(x => x === 0)) { reports.clear(); if (!gs.match || !matchGames.length || matchGames.at(-1)?.score?.some(x => x >= gs.match.length)) matchGames = []; }
  if ($('game-layout').classList.contains('analysis-mode')) closeAnalysis();
  show('screen-game');
  faceMyArm();
  $('win-overlay').style.display = 'none';         // a rematch starts from the game-over screen
  $('cube-offer').style.display = 'none';
  initBoard($('board-canvas'));
  setCommitVisible(false); setUndoVisible(false);
  commitPending = false;
  // Fresh game: drop everything left over from a previous game in this tab.
  $('game-log').replaceChildren();
  turnNumber    = 1;
  turnLogMoves  = [];
  turnLogDice   = null;
  turnLogPlayer = null;
  resetAnimations();
  renderSidebar();
  renderDice(null, gameState.players[gameState.turnIndex]?.color);
  drawBoard(gameState);
  if (isMyTurn()) enableRoll();
  renderCube();
});

on('rolled', ({ playerIndex, dice, moves, combos }) => {
  gameState.dice = dice;
  gameState.diceUsed = [false, false];
  gameState.phase = 'AWAITING_MOVE';
  legalMovesCache = moves ?? null;
  legalCombos = combos ?? {};
  pendingSecond = null;
  selectedMarble = null;
  selectedMarbleMoves = []; selectedComboMoves = [];
  commitPending = false;
  setCommitVisible(false); setUndoVisible(false);
  renderDice(dice, gameState.players[playerIndex]?.color);
  $('btn-roll').disabled = true;
  renderCube();                       // rolled: no more doubling this turn

  // Capture dice for backgammon notation (extra roll starts a fresh move list)
  if (turnLogPlayer !== playerIndex) {
    turnLogMoves  = [];
    turnLogPlayer = playerIndex;
  }
  turnLogDice = dice;

  const isMe = playerIndex === myPlayerIndex;
  if (isMe) {
    const totalMoves = Object.values(legalMovesCache ?? {}).reduce((s, a) => s + a.length, 0);
    setHint(totalMoves === 0 ? '' : 'Click one of your marbles to see where it can move.');
  } else {
    setHint('');
  }
  updateSkipButton();
});

// Server sends updated legal moves after the player uses one die (so remaining
// die destinations can be highlighted correctly).
on('legalMoves', ({ moves, diceUsed, combos }) => {
  legalMovesCache = moves;
  legalCombos = combos ?? {};
  // Second half of a two-dice destination the player clicked: play it now if
  // it is still legal (the server checks it again anyway).
  if (pendingSecond) {
    const want = pendingSecond;
    pendingSecond = null;
    const ok = (moves?.[want.dieIndex] ?? []).find(m => JSON.stringify(m) === JSON.stringify(want));
    if (ok && isMyTurn()) { if (diceUsed && gameState) gameState.diceUsed = diceUsed; submitMove(ok); return; }
  }
  if (diceUsed && gameState) {
    gameState.diceUsed = diceUsed;
    renderDice(gameState.dice);
    // Show Undo as soon as any die has been used
    if (isMyTurn() && (diceUsed[0] || diceUsed[1])) {
      setUndoVisible(true);
    }
  }
  selectedMarble = null;
  selectedMarbleMoves = []; selectedComboMoves = [];
  drawBoard(gameState);
  if (isMyTurn()) setHint('Click a marble to choose your next move.');
  updateSkipButton();
});

on('marbleMoved', ({ playerIndex, marbleId, from, to, path, dieIndex }) => {
  const marble = gameState.players[playerIndex].marbles[marbleId];
  // Grey out the die this move used — for everyone watching, not just the mover.
  if ((dieIndex === 0 || dieIndex === 1) && gameState.diceUsed) {
    gameState.diceUsed[dieIndex] = true;
    renderDice(gameState.dice);
  }

  // Capture from-position before updating state (for the tween start point).
  // A base has one slot per marble, so leaving base starts from this marble's
  // own slot (zoneToSpace has no single position for "base").
  const fromPos = from.zone === 'base'
    ? getBasePosition(playerIndex, marbleId)
    : getSpacePosition(zoneToSpace(from, playerIndex));

  // Update game state immediately — render is always driven by authoritative state
  Object.assign(marble, to);
  updatePips();
  const chime = to.zone === 'home' && from.zone !== 'home';
  selectedMarble = null;
  selectedMarbleMoves = []; selectedComboMoves = [];

  // Consume any bumps the server reported just before this move (this is the
  // attacker that caused them). They fly home after the attacker arrives.
  const victims = bumpHandoff;
  bumpHandoff = [];
  const bumped = victims.length > 0;

  // Accumulate move for backgammon notation; merge consecutive same-marble moves.
  // Bump spaces are marked with * inline (e.g. "28/29*/30") using the victim's
  // zone location so the asterisk lands on the right space, not the final one.
  // All in the mover's numbers (backgammon style: the countdown to their home).
  const bumpLocs = new Set(victims.map(v => locNotation(v.loc, playerIndex)));
  const fromStr = locNotation(from, playerIndex);
  const toStr   = locNotation(to, playerIndex) + (bumpLocs.has(locNotation(to, playerIndex)) ? '*' : '');
  const last    = turnLogMoves[turnLogMoves.length - 1];
  if (last && last.marbleId === marbleId) {
    // Strip any trailing * from the previous segment's last entry to compare cleanly
    const prevLast = last.path[last.path.length - 1].replace('*', '');
    if (prevLast === fromStr) {
      last.path.push(toStr);
    } else {
      turnLogMoves.push({ marbleId, path: [fromStr, toStr] });
    }
  } else {
    turnLogMoves.push({ marbleId, path: [fromStr, toStr] });
  }

  // Build canvas waypoints from server path
  const waypoints = (path ?? []).map(loc => getSpacePosition(zoneToSpace(loc, playerIndex))).filter(Boolean);
  const toPos = getSpacePosition(zoneToSpace(to, playerIndex));
  if (waypoints.length === 0 && toPos) waypoints.push(toPos);

  // The attacker's sound plays when it ARRIVES (tween end): bonk if it bumped,
  // else the home chime. (A move can't both bump and enter home.)
  const sound = bumped ? 'bonk' : (chime ? 'chime' : null);

  if (fromPos && waypoints.length > 0) {
    enqueueTween({ playerIndex, marbleId, fromPos, waypoints, sound });
  } else {
    // No animatable path (e.g. exiting base): just play the sound and render.
    if (sound === 'bonk') playBonk();
    else if (sound === 'chime') playHomeChime();
    drawBoard(gameState);
  }

  // After the attacker, send each bumped marble flying home.
  for (const v of victims) {
    const basePos = getBasePosition(v.ownerIndex, v.marbleId);
    if (v.fromPos && basePos) {
      enqueueTween({ playerIndex: v.ownerIndex, marbleId: v.marbleId,
                     fromPos: v.fromPos, waypoints: [basePos], sound: null });
    } else {
      clearMarbleOverride(v.ownerIndex, v.marbleId); // nowhere to fly from — just clear
    }
  }
  if (!animationRunning) drawBoard(gameState);
});

on('marbleBumped', ({ ownerIndex, marbleId, from }) => {
  const marble = gameState.players[ownerIndex].marbles[marbleId];

  // Capture the pre-bump position so the marble lingers there (via override)
  // until the attacker arrives and its fly-home tween takes over.
  const fromPos = getSpacePosition(zoneToSpace(from, ownerIndex));

  marble.zone = 'base';
  marble.space = null;
  marble.slot = null;
  marble.starEligible = false;

  // Cancel any queued tween for this marble — it's going home now
  const idx = animationQueue.findIndex(a => a.playerIndex === ownerIndex && a.marbleId === marbleId);
  if (idx !== -1) animationQueue.splice(idx, 1);

  if (fromPos) setMarbleOverride(ownerIndex, marbleId, fromPos);
  else         clearMarbleOverride(ownerIndex, marbleId);
  bumpHandoff.push({ ownerIndex, marbleId, fromPos, loc: from });
  updatePips();
});

on('turnChanged', ({ playerIndex }) => {
  flushTurnLog();
  turnNumber++;
  gameState.turnIndex = playerIndex;
  gameState.phase = 'IN_TURN';
  gameState.dice = null;
  gameState.diceUsed = [false, false];
  legalMovesCache = null;
  selectedDie = null;
  selectedMarble = null;
  selectedMarbleMoves = []; selectedComboMoves = [];
  commitPending = false;
  turnLogPlayer = null;
  setCommitVisible(false); setUndoVisible(false);
  updateSkipButton();
  setHint('');
  renderSidebar();
  renderDice(null, gameState.players[playerIndex]?.color);
  if (isMyTurn()) {
    enableRoll();
  } else {
    $('btn-roll').disabled = true;
  }
  renderCube();
});

on('extraRoll', ({ playerIndex }) => {
  flushTurnLog();
  gameState.phase = 'EXTRA_ROLL';
  commitPending = false;
  // Start fresh move accumulation for the extra roll
  turnLogMoves = [];
  setCommitVisible(false); setUndoVisible(false);
  if (playerIndex === myPlayerIndex) {
    enableRoll();
  }
  renderCube();
});

on('dieForfeit', ({ dieIndex }) => {
  if (gameState?.diceUsed) gameState.diceUsed[dieIndex] = true;
  renderDice(gameState?.dice);
  updateSkipButton();
});

on('turnSkipped', ({ playerIndex }) => {
  flushTurnLog();
  turnLogPlayer = null;
});

on('readyToCommit', ({ playerIndex }) => {
  if (playerIndex !== myPlayerIndex) return;
  commitPending = true;
  setCommitVisible(true);
  setUndoVisible(true);
  setHint('Both dice used. Commit your turn or Undo to try again.');
  updateSkipButton();
});

on('undone', ({ gameState: gs }) => {
  gameState = gs;
  selectedMarble = null;
  selectedMarbleMoves = []; selectedComboMoves = [];
  commitPending = false;
  // Clear any in-flight animations and overrides — server state is authoritative
  resetAnimations();
  // Undo reverts exactly one move (LIFO), so drop only that move from the log.
  popLastLoggedMove();
  setCommitVisible(false); setUndoVisible(false);
  renderDice(gameState.dice);
  drawBoard(gameState);
  if (isMyTurn()) setHint('Undone. Click a marble to make your moves.');
  updateSkipButton();
  updatePips();
});

on('gameOver', ({ winnerIndex }) => showGameOver(winnerIndex));

function showGameOver(winnerIndex) {
  if (gameState.phase === 'GAME_OVER' && $('win-overlay').style.display === 'flex') return;
  flushTurnLog();
  turnLogPlayer = null;
  gameState.phase = 'GAME_OVER';
  const name = playerName(winnerIndex);
  $('winner-msg').textContent = `${name} wins! 🎉`;
  $('score-msg').style.display = 'none';
  $('btn-analyze').style.display = settings.analysis ? '' : 'none';
  $('btn-rematch').style.display = '';
  $('btn-rematch').disabled = false;
  $('btn-rematch').textContent = 'Rematch';
  $('rematch-msg').style.display = 'none';
  $('win-overlay').style.display = 'flex';
  $('cube-offer').style.display = 'none';
  renderCube();
  // Board stays visible — no screen switch
  log(`🏆 ${name} wins the game!`);
}

// ---- Doubling cube (money play) ----
const cubeOwnerText = c => c.owner == null ? 'centred'
  : c.owner === myPlayerIndex ? 'your cube' : `${playerName(c.owner)}'s cube`;
// Dead cube (match play): its value already wins player pi the match.
function cubeDead(pi) {
  const c = gameState?.cube, m = gameState?.match;
  const away = m ? m.length - m.score[pi] : c?.away?.[pi];
  return !!c && away != null && away <= c.value;
}
function canIDouble() {
  const g = gameState, c = g?.cube;
  return !!c && !c.crawford && !cubeDead(myPlayerIndex) && isMyTurn() && g.phase === 'IN_TURN' && !g.dice && !g.cubeOffer &&
    (c.owner == null || c.owner === myPlayerIndex);
}
function renderCube() {
  const c = gameState?.cube;
  $('cube-area').style.display = c ? 'flex' : 'none';
  if (c) {
    $('cube').textContent = String(c.value);
    const dead = c.owner != null && cubeDead(c.owner);
    $('cube-owner').textContent = c.crawford ? 'Crawford game — no doubling'
      : cubeOwnerText(c) + (dead ? ' · dead' : '');
    const bd = $('btn-double');
    bd.style.display = canIDouble() ? '' : 'none';
    if ($('btn-roll').disabled) hideRollPopup();
    bd.title = `Double to ${c.value * 2} (D)`;
    // A double waiting for my answer (also after a reconnect).
    const o = gameState.cubeOffer;
    if (o && o.to === myPlayerIndex && gameState.phase === 'CUBE_OFFERED') {
      $('cube-offer-msg').replaceChildren(el('div', { class: 'cube-face' }, String(o.value)),
        el('div', {}, `${playerName(o.from)} doubles`, help(`Take: play on for ${o.value}, and own the cube. Drop: lose ${c.value} now.`)));
      $('cube-offer').style.display = 'flex';
    } else if (!o) $('cube-offer').style.display = 'none';
  }
  const line = sessionLine(true);
  $('score-line').style.display = line ? 'block' : 'none';
  $('score-line').textContent = line;
}

// "Session: You +2 · Sloane −2" (money score, cube rooms) or
// "Games won: You 1 · Sloane 2" once at least one game is finished.
function sessionLine(you) {
  const g = gameState;
  if (!g) return '';
  const who = i => (you && i === myPlayerIndex) ? 'You' : g.players[i].name;
  if (g.match) return `Match to ${g.match.length}: ` + g.players.map((_, i) => `${who(i)} ${g.match.score[i]}`).join(' · ')
    + (g.match.crawford ? ' · Crawford game' : g.match.crawfordUsed ? ' · post-Crawford' : '');
  if (g.score) return 'Session: ' + g.players.map((_, i) => `${who(i)} ${g.score[i] > 0 ? '+' : ''}${g.score[i]}`).join(' · ');
  if (g.wins && g.wins.some(w => w > 0)) return 'Games won: ' + g.players.map((_, i) => `${who(i)} ${g.wins[i]}`).join(' · ');
  return '';
}
function doDouble() {
  if (!canIDouble()) return;
  send({ action: 'double' });
  hideRollPopup();
  $('btn-double').style.display = 'none';
  $('btn-roll').disabled = true;
}
$('btn-double').addEventListener('click', doDouble);
$('btn-take').addEventListener('click', () => { send({ action: 'take' }); $('cube-offer').style.display = 'none'; });
$('btn-drop').addEventListener('click', () => { send({ action: 'drop' }); $('cube-offer').style.display = 'none'; });
$('btn-rematch').addEventListener('click', () => {
  send({ action: 'rematch' });
  $('btn-rematch').disabled = true;
  $('btn-rematch').textContent = 'Waiting…';
});
// Someone asked for a rematch: it starts once every human player agrees.
on('rematchRequested', ({ playerIndex, waitingFor }) => {
  const names = waitingFor.map(i => i === myPlayerIndex ? 'you' : playerName(i)).join(', ');
  if (waitingFor.includes(myPlayerIndex)) {
    $('rematch-msg').textContent = `${playerName(playerIndex)} wants a rematch.`;
    $('btn-rematch').textContent = 'Accept Rematch';
    $('btn-rematch').disabled = false;
  } else {
    $('rematch-msg').textContent = `Waiting for ${names} to accept the rematch…`;
    $('btn-rematch').textContent = 'Waiting…';
    $('btn-rematch').disabled = true;
  }
  $('rematch-msg').style.display = '';
  log(`${playerName(playerIndex)} wants a rematch`);
});
on('opponentLeft', ({ playerIndex }) => {
  if (playerIndex === myPlayerIndex) return;
  $('rematch-msg').textContent = `${playerName(playerIndex)} left the room — no rematch.`;
  $('rematch-msg').style.display = '';
  $('btn-rematch').disabled = true;
  $('btn-rematch').textContent = 'Rematch';
});
document.addEventListener('keydown', e => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (!$('screen-game').classList.contains('active')) return;
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName)) return;
  if ((e.key === 'd' || e.key === 'D') && canIDouble()) { e.preventDefault(); doDouble(); }
  if ((e.key === 't' || e.key === 'T') && $('cube-offer').style.display !== 'none') { e.preventDefault(); $('btn-take').click(); }
});

on('doubleOffered', ({ playerIndex, value }) => {
  gameState.cubeOffer = { from: playerIndex, to: 1 - playerIndex, value };
  gameState.phase = 'CUBE_OFFERED';
  log(`${playerName(playerIndex)} doubles to ${value}`, gameState.players[playerIndex]?.color);
  $('btn-roll').disabled = true;
  if (playerIndex !== myPlayerIndex) {
    $('cube-offer-msg').replaceChildren(el('div', { class: 'cube-face' }, String(value)),
      el('div', {}, `${playerName(playerIndex)} doubles`, help(`Take: play on for ${value}, and own the cube. Drop: lose ${gameState.cube.value} now.`)));
    $('cube-offer').style.display = 'flex';
    $('turn-banner').textContent = 'Doubled';
  } else {
    $('turn-banner').textContent = `${playerName(1 - playerIndex)} to answer`;
  }
  renderCube();
});
on('doubleTaken', ({ playerIndex, value, owner }) => {
  gameState.cube = { ...gameState.cube, value, owner };
  gameState.cubeOffer = null;
  gameState.phase = 'IN_TURN';
  $('cube-offer').style.display = 'none';
  log(`${playerName(playerIndex)} takes — cube at ${value}`, gameState.players[playerIndex]?.color);
  if (isMyTurn()) enableRoll(); else $('turn-banner').textContent = `${playerName(gameState.turnIndex)}'s turn`;
  renderCube();
});
on('doubleDropped', ({ playerIndex }) => {
  gameState.cubeOffer = null;
  $('cube-offer').style.display = 'none';
  log(`${playerName(playerIndex)} drops`, gameState.players[playerIndex]?.color);
});
on('gameResult', ({ winnerIndex, result, score, wins, match, game, ratings }) => {
  const myR = ratings?.[myPlayerIndex];
  if (myR) { myRating = { ...(myRating ?? {}), rating: myR.rating }; renderNavMe(); log(`Your rating: ${myR.rating} (${myR.change >= 0 ? '+' : ''}${myR.change})`); }
  if (game != null) {
    lastGameNo = game;
    if (!match) matchGames = [];
    matchGames.push({ n: game, winner: winnerIndex, result, score: match ? match.score.slice() : null });
    matchOver = !!match?.over;
    if (!$('btn-analyze').disabled) resetAnalyzeButton();
  }
  if (gameState) { gameState.score = score ?? null; if (wins) gameState.wins = wins; gameState.match = match ? { ...match, crawford: false } : null; }
  // Mid-match: no game-over screen — the next game starts at once.
  if (match && !match.over) {
    flushTurnLog(); turnLogPlayer = null; gameState.phase = 'GAME_OVER';
    const how = result?.dropped ? 'double dropped' : result?.baggro ? 'baggro' : result?.aggro ? 'aggro' : result?.resigned ? 'resigned' : 'single game';
    log(`${playerName(winnerIndex)} wins ${ptsTxt(result?.points ?? 1)} — ${how} · ${sessionLine(false)}`);
    renderCube();
    return;
  }
  showGameOver(winnerIndex);
  if (result) {
    const how = result.dropped ? 'double dropped' : result.resigned ? 'resigned' : result.baggro ? 'a baggro!' : result.aggro ? 'an aggro!' : 'single game';
    // Several losers: who paid what ("1 each from A, B and C · 2 from D (aggro)").
    let detail = `(${how})`;
    if ((result.losers?.length ?? 0) > 1) {
      const kind = m => m === 3 ? ' (baggro)' : m === 2 ? ' (aggro)' : '';
      const groups = new Map();
      for (const l of result.losers) { const k = `${l.points}|${l.mult}`; groups.set(k, [...(groups.get(k) ?? []), playerName(l.pi)]); }
      const list = a => a.length < 2 ? a[0] : `${a.slice(0, -1).join(', ')} and ${a.at(-1)}`;
      detail = ': ' + [...groups].map(([k, names]) => { const [pts, m] = k.split('|').map(Number);
        return `${names.length > 1 ? `${pts} each` : pts} from ${list(names)}${kind(m)}`; }).join(' · ');
    }
    const line = `${playerName(winnerIndex)} wins ${ptsTxt(result.points)}${detail.startsWith(':') ? detail : ' ' + detail}`;
    $('winner-msg').textContent = line + ' 🎉';
    log(line);
  }
  // Match: the match score (and the match result); money: the session score.
  let line = sessionLine(false);
  if (match?.over) {
    line = `${playerName(match.winner)} wins the match ${match.score[match.winner]}–${match.score[1 - match.winner]}! 🏆`;
    $('btn-rematch').textContent = 'New match';
  } else if (match) $('btn-rematch').textContent = 'Next game';
  $('score-msg').textContent = line;
  $('score-msg').style.display = line ? '' : 'none';
  renderCube();
});

on('playerDisconnected', ({ playerIndex, timeoutMs }) => {
  log(`${playerName(playerIndex)} disconnected (${timeoutMs / 1000}s to reconnect)`);
});

on('robotTookOver', ({ playerIndex }) => {
  if (gameState?.players?.[playerIndex]) gameState.players[playerIndex].isRobot = true;
  log(`${playerName(playerIndex)} is now a robot 🤖`, gameState?.players?.[playerIndex]?.color);
  if (playerIndex !== myPlayerIndex) toast(`${playerName(playerIndex)} left — a robot plays for them now 🤖`);
  renderSidebar();
});
// A short notice over the board.
function toast(msg) {
  const t = el('div', { class: 'toast' }, msg);
  $('board-area').append(t);
  setTimeout(() => t.remove(), 5000);
}

on('reconnected', ({ gameState: gs }) => {
  gameState = gs;
  show('screen-game');
  faceMyArm();
  initBoard($('board-canvas'));
  setCommitVisible(false); setUndoVisible(false);
  commitPending = false;
  legalMovesCache = null;
  selectedMarble = null;
  selectedMarbleMoves = []; selectedComboMoves = [];
  resetAnimations();
  renderSidebar();
  renderDice(gameState.dice, gameState.players[gameState.turnIndex]?.color);
  // Restore the controls for whatever point of the turn we came back to. The
  // server follows up with legalMoves (mid-roll) or readyToCommit as needed.
  const canRoll = isMyTurn() && !gameState.dice
    && (gameState.phase === 'IN_TURN' || gameState.phase === 'EXTRA_ROLL');
  if (canRoll) enableRoll(); else $('btn-roll').disabled = true;
  updateSkipButton();
  drawBoard(gameState);
  renderCube();
});

on('hostChanged', ({ playerIndex }) => {
  if (playerIndex !== myPlayerIndex) return;
  // The previous host left the lobby; this player can now add robots and start.
  $('host-controls').style.display = 'flex';
  $('lobby-wait-msg').style.display = 'none';
  // Re-render so robot slots get their remove buttons.
  const slots = [...document.querySelectorAll('#lobby-slots li')].map(li => {
    const text = li.querySelector('.slot-name').textContent;
    return {
      index: Number(li.id.replace('slot-', '')),
      name: text.replace(/ 🤖$/, ''),
      color: li.dataset.color,
      isRobot: text.endsWith('🤖'),
      filled: text !== '(empty)',
    };
  });
  renderLobbySlots(slots);
  updateStartButton();
});

// ---- Canvas interaction ----

function onCanvasClick(e) {
  if (!gameState || !isMyTurn() || gameState.phase !== 'AWAITING_MOVE') return;

  const canvas = $('board-canvas');
  const rect   = canvas.getBoundingClientRect();
  // Scale from CSS display coords → canvas pixel coords (important when CSS sizes differ)
  const scaleX = canvas.width  / rect.width;
  const scaleY = canvas.height / rect.height;
  const cx = (e.clientX - rect.left) * scaleX;
  const cy = (e.clientY - rect.top)  * scaleY;

  // Clicking a highlighted destination submits that move.
  if (selectedMarbleMoves.length) {
    const dest = hitTestDestination(cx, cy, selectedMarbleMoves);
    if (dest) {
      submitMove(dest);
      return;
    }
  }
  // A two-dice destination: play the first die now, the second when the
  // server confirms it (see the legalMoves handler).
  if (selectedComboMoves.length) {
    const combo = hitTestDestination(cx, cy, selectedComboMoves);
    if (combo) {
      const second = combo.second;
      submitMove(combo.first);
      pendingSecond = second;
      return;
    }
  }

  // Clicking a marble selects it — or deselects if clicking the already-selected marble.
  const hit = hitTestMarble(gameState, cx, cy);
  if (!hit || hit.playerIndex !== myPlayerIndex) {
    selectedMarble = null;
    selectedMarbleMoves = []; selectedComboMoves = [];
    drawBoard(gameState);
    if (isMyTurn() && gameState.phase === 'AWAITING_MOVE') {
      setHint('Click one of your marbles to see where it can move.');
    }
    return;
  }

  // Deselect if clicking the same marble again
  if (selectedMarble && selectedMarble.marbleId === hit.marbleId) {
    selectedMarble = null;
    selectedMarbleMoves = []; selectedComboMoves = [];
    drawBoard(gameState);
    setHint('Click one of your marbles to see where it can move.');
    return;
  }

  selectedMarble = hit;
  selectedMarbleMoves = computeLegalDestinations(hit);
  selectedComboMoves = computeComboDestinations(hit);
  drawBoard(gameState);
  showDestinations();

  const n1 = selectedMarbleMoves.length, n2 = selectedComboMoves.length;
  if (n1 === 0 && n2 === 0) {
    setHint('No moves for that marble.');
  } else {
    setHint(`${n1} move${n1 === 1 ? '' : 's'} with one die` +
      (n2 ? ` (green), ${n2} more with both dice (dashed blue)` : '') + ' — click a highlighted space.');
  }
}

// Highlight the selected marble and where it can go: green with one die,
// dashed blue with both dice.
function showDestinations() {
  if (!selectedMarble) return;
  const marble = gameState.players[selectedMarble.playerIndex]?.marbles[selectedMarble.marbleId];
  highlightMarbleAt(marble, selectedMarble.playerIndex);
  highlightSpaces(selectedComboMoves.map(moveToSpace).filter(Boolean), 'two');
  highlightSpaces(selectedMarbleMoves.map(moveToSpace).filter(Boolean));
}

// Two-dice destinations for a marble (both dice unused, no die picked), minus
// squares one die already reaches.
function computeComboDestinations({ marbleId }) {
  if (selectedDie !== null || gameState?.diceUsed?.[0] || gameState?.diceUsed?.[1]) return [];
  const one = new Set(computeLegalDestinations({ marbleId }).map(m => JSON.stringify(moveToSpace(m))));
  return (legalCombos[marbleId] ?? []).filter(c => !one.has(JSON.stringify(moveToSpace(c))));
}

// Returns all legal moves for the given marble across all unused dice.
function computeLegalDestinations({ marbleId }) {
  if (!legalMovesCache) return [];
  const moves = [];
  const dice = selectedDie !== null ? [selectedDie] : [0, 1];
  for (const i of dice) {
    if (gameState?.diceUsed?.[i]) continue;
    for (const m of (legalMovesCache[i] ?? [])) {
      if (m.marbleId === marbleId) moves.push(m);
    }
  }
  return moves;
}

// Converts a move to a space descriptor for board highlighting / hit-testing.
// All move types now carry toZone (set by GameEngine), so this is a direct mapping.
function moveToSpace(move) {
  if (!move.toZone) return null;
  if (move.toZone === 'center') return { zone: 'center' };
  if (move.toZone === 'track')  return { zone: 'track', space: move.toSpace };
  if (move.toZone === 'home')   return { zone: 'home', playerIndex: myPlayerIndex, slot: move.toSlot };
  return null;
}

// Converts a zone/space descriptor from a marbleMoved event to a space descriptor for board
function zoneToSpace(loc, playerIndex) {
  if (!loc) return null;
  if (loc.zone === 'center') return { zone: 'center' };
  if (loc.zone === 'track')  return { zone: 'track', space: loc.space };
  if (loc.zone === 'home')   return { zone: 'home', playerIndex, slot: loc.slot };
  return null;
}

// Returns the move that the player clicked, or null.
function hitTestDestination(cx, cy, moves) {
  const R = $('board-canvas').width * 0.028;
  for (const move of moves) {
    const pos = getSpacePosition(moveToSpace(move));
    if (!pos) continue;
    const dx = cx - pos.x, dy = cy - pos.y;
    if (dx * dx + dy * dy <= R * R) return move;
  }
  return null;
}

function submitMove(move) {
  send({ action: 'move', move });
  selectedMarble = null;
  selectedMarbleMoves = []; selectedComboMoves = [];
  legalMovesCache = null; // will be refreshed by server via 'legalMoves' event if turn continues
  selectedDie = null;
}

// ---- Marble animation ----

const animationQueue = [];
let   animationRunning = false;

// Stimulus-response animation: each tween is a self-contained
//   { playerIndex, marbleId, fromPos, waypoints, sound }
// processed serially. Invariant: a marble's override exists ONLY while its tween
// is running and is ALWAYS cleared when the tween ends — so nothing is ever left
// stranded on the board. `sound` ('bonk' | 'chime' | null) plays at the tween's
// end, so it lands exactly when the marble arrives.
function enqueueTween(tween) {
  if (!tween.waypoints || tween.waypoints.length === 0) return;
  animationQueue.push(tween);
  pinQueuedMarbles();
  if (!animationRunning) runNextAnimation();
}

// The marble whose tween is currently playing (its override is set per frame).
let runningMarble = null;

// Game state jumps to a marble's final position as soon as the server's event
// arrives, but its tween may be waiting behind others (e.g. a robot's extra-
// roll chain sends moves faster than they animate). Pin every marble that has
// a queued tween at the start of its FIRST queued tween, so it waits visibly
// where it is instead of appearing at the end, then snapping back when its
// tween starts. Covers a marble whose second move is still queued after its
// first finished.
function pinQueuedMarbles() {
  const seen = new Set();
  for (const tw of animationQueue) {
    const key = `${tw.playerIndex}:${tw.marbleId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (runningMarble && runningMarble.playerIndex === tw.playerIndex
        && runningMarble.marbleId === tw.marbleId) continue;
    setMarbleOverride(tw.playerIndex, tw.marbleId, tw.fromPos);
  }
}

// Bumped by resetAnimations(). A running tween checks it on every frame and
// stops if it changed, so an undo / reconnect / new game mid-animation can't
// leave an old tween drawing a marble in a stale place or running a second
// queue-drain loop alongside a new one.
let animationGen = 0;

function resetAnimations() {
  animationGen++;
  animationQueue.length = 0;
  animationRunning = false;
  runningMarble = null;
  bumpHandoff = [];
  lastAnimEnd = null;
  clearAnimatingMarble();
  clearAllMarbleOverrides();
}

function runNextAnimation() {
  if (animationQueue.length === 0) {
    animationRunning = false;
    runningMarble = null;
    lastAnimEnd = null;
    return;
  }
  animationRunning = true;
  const gen = animationGen;
  const stale = () => gen !== animationGen;
  const { playerIndex, marbleId, fromPos, waypoints, sound } = animationQueue.shift();
  runningMarble = { playerIndex, marbleId };

  // Normal pace, or faster when moves are piling up behind this one, so the
  // board doesn't fall far behind the server (and the log) on long turns.
  const behind   = animationQueue.length >= 2;
  const STEP_MS  = behind ? 110 : 200; // per-waypoint duration
  const PAUSE_MS = behind ? 180 : 350; // beat between two consecutive moves of the same marble

  // Pause a beat when the same marble moves again (both dice on one marble) so a
  // bonk/landing on the prior move is legible before it sets off again.
  const samePrev = lastAnimEnd
    && lastAnimEnd.playerIndex === playerIndex
    && lastAnimEnd.marbleId === marbleId;

  let step = 0;
  let prevPos = fromPos;

  setAnimatingMarble(playerIndex, marbleId);
  // Pin at the start position so the marble doesn't flash at its (already-updated)
  // destination during the pause or before the first frame.
  setMarbleOverride(playerIndex, marbleId, fromPos);
  if (samePrev) drawBoard(gameState);

  function finish() {
    clearMarbleOverride(playerIndex, marbleId);
    clearAnimatingMarble();
    runningMarble = null;
    lastAnimEnd = { playerIndex, marbleId };
    if (sound === 'bonk') playBonk();
    else if (sound === 'chime') playHomeChime();
    // Re-pin anything still waiting — including this marble, if it has another
    // move queued — before drawing, so nothing shows at its final position early.
    pinQueuedMarbles();
    drawBoard(gameState);
    runNextAnimation();
  }

  function animateToNext() {
    if (stale()) return;
    if (step >= waypoints.length) { finish(); return; }
    const targetPos = waypoints[step++];
    const startPos  = prevPos;
    const start     = performance.now();

    function frame(now) {
      if (stale()) return;
      const t    = Math.min((now - start) / STEP_MS, 1);
      const ease = t * t * (3 - 2 * t); // smoothstep
      setMarbleOverride(playerIndex, marbleId, {
        x: startPos.x + (targetPos.x - startPos.x) * ease,
        y: startPos.y + (targetPos.y - startPos.y) * ease,
      });
      drawBoard(gameState);
      if (t < 1) {
        requestAnimationFrame(frame);
      } else {
        prevPos = targetPos;
        animateToNext();
      }
    }
    requestAnimationFrame(frame);
  }

  if (samePrev) setTimeout(animateToNext, PAUSE_MS);
  else animateToNext();
}

// ---- Backgammon-style notation helpers ----

// Convert a zone-descriptor { zone, space?, slot? } to a notation string.
// A location in player pi's numbers (their countdown to home): "30", "h2", "hub".
function locNotation(loc, pi) {
  if (!loc) return '?';
  if (loc.zone === 'base')   return 'base';
  if (loc.zone === 'center') return 'hub';
  if (loc.zone === 'home')   return `h${loc.slot}`;
  if (loc.zone === 'track')  return String(countdown(playerArm(pi), loc.space));
  return '?';
}
function playerArm(pi) {
  const a = armOf(gameState?.players?.[pi]?.color ?? '');
  return a >= 0 ? a : 0;
}

// Remove the most recent move from this turn's notation (used by undo).
// Consecutive moves of one marble share an entry ("4/9/12"), so dropping the
// last move either shortens that path or removes the entry.
function popLastLoggedMove() {
  const last = turnLogMoves[turnLogMoves.length - 1];
  if (!last) return;
  if (last.path.length > 2) last.path.pop();
  else turnLogMoves.pop();
}

// Emit accumulated moves for the current turn as a single numbered log line.
function flushTurnLog() {
  if (!turnLogDice) return;
  const pi      = turnLogPlayer ?? gameState?.turnIndex;
  const name    = playerName(pi);
  const color   = gameState?.players[pi]?.color ?? null;
  const diceStr = `${turnLogDice[0]}-${turnLogDice[1]}`;
  const movesStr = turnLogMoves.length
    ? turnLogMoves.map(m => m.path.join('/')).join(' ')
    : '--';
  log(`${turnNumber}. ${name}: ${diceStr}: ${movesStr}`, color);
  // Feedback lines start with "↳", so tools/replay.mjs ignores them in a copied log.
  // A roll with no legal move ("--") is never committed, so the server sends
  // no feedback for it; it was played the only way it could be.
  if (!pendingFeedback && pi === myPlayerIndex && settings.feedback && !turnLogMoves.length) {
    pendingFeedback = { text: '✓ Robot agrees', cls: 'agree' };
  }
  if (pendingFeedback && pi === myPlayerIndex && settings.feedback) log(`↳ ${pendingFeedback.text}`, null, `log-feedback ${pendingFeedback.cls}`);
  pendingFeedback = null;
  turnLogMoves = [];
  turnLogDice  = null;
}

// ---- Render helpers ----

function renderLobbySlots(slots) {
  const ul = $('lobby-slots');
  const iAmHost = ($('host-controls').style.display !== 'none');
  ul.innerHTML = '';
  for (const slot of slots) {
    const li = document.createElement('li');
    li.id = `slot-${slot.index}`;
    li.dataset.color = slot.color;
    const dot = document.createElement('span');
    dot.className = 'slot-dot';
    dot.style.background = COLOR_MAP[dc(slot.color)] ?? '#888';
    const name = document.createElement('span');
    name.className = 'slot-name';
    name.textContent = slot.filled ? slot.name + (slot.isRobot ? ' 🤖' : '') : '(empty)';
    li.appendChild(dot);
    li.appendChild(name);
    if (slot.isRobot && iAmHost) {
      const del = document.createElement('button');
      del.className = 'btn-remove-robot';
      del.textContent = '×';
      del.title = 'Remove robot';
      del.addEventListener('click', () => send({ action: 'removeRobot', playerIndex: slot.index }));
      li.appendChild(del);
    }
    ul.appendChild(li);
  }
}

function renderSidebar() {
  if (!gameState) return;
  const list = $('player-list');
  list.innerHTML = '';
  for (const p of gameState.players) {
    const row = document.createElement('div');
    row.className = 'player-row' + (p.index === gameState.turnIndex ? ' active-turn' : '');
    const dot = document.createElement('span');
    dot.className = 'player-dot';
    dot.style.background = COLOR_MAP[dc(p.color)] ?? '#888';
    const label = document.createElement('span');
    label.textContent = p.name + (p.isRobot ? ' 🤖' : '');
    const pips = document.createElement('span');
    pips.className = 'pips';
    pips.dataset.player = p.index;
    pips.title = 'Pip count: squares still to travel by the shortest route (stars and hub included), plus the empty home slots';
    row.appendChild(dot);
    row.appendChild(label);
    row.appendChild(pips);
    list.appendChild(row);
  }
  updatePips();
  const banner = $('turn-banner');
  banner.textContent = isMyTurn() ? 'Your turn' : `${playerName(gameState.turnIndex)}'s turn`;
  banner.style.color = isMyTurn() ? '#f0c040' : '#aaa';
}

// Refresh the pip counts in the player list (after every move or bump).
function updatePips() {
  if (!gameState) return;
  for (const el of document.querySelectorAll('#player-list .pips')) {
    const p = gameState.players[Number(el.dataset.player)];
    const arm = PLAYER_CONFIG.findIndex(c => c.color === p?.color);
    el.textContent = arm >= 0 ? `${pipCount(arm, p.marbles)} pips` : '';
  }
}

function renderDice(dice, color) {
  for (let i = 0; i < 2; i++) {
    const el = $(`die-${i}`);
    el.textContent = dice ? dice[i] : '–';
    el.classList.toggle('used', !!(gameState?.diceUsed?.[i]));
    el.classList.toggle('selected-die', selectedDie === i);
    if (color !== undefined) el.style.setProperty('--die-color', color ? COLOR_MAP[dc(color)] ?? '' : '');
  }
}

// Roll and Double side by side when doubling is possible; otherwise (no cube,
// cube not mine, dead, Crawford, extra roll) roll automatically.
let autoRollTimer = null;
function enableRoll() {
  $('btn-roll').disabled = false;
  renderCube();
  const choose = canIDouble();
  $('turn-banner').textContent = 'Your turn';
  $('turn-banner').style.color = '#f0c040';
  clearTimeout(autoRollTimer);
  if (choose) showRollPopup();
  else autoRollTimer = setTimeout(() => {
    if (!isMyTurn() || $('btn-roll').disabled) return;
    doRoll();
    // Safety net: if the roll didn't go through, offer the button.
    autoRollTimer = setTimeout(() => { if (isMyTurn() && !$('btn-roll').disabled) showRollPopup(); }, 2500);
  }, 600);
}
function showRollPopup() { renderCube(); $('roll-popup').style.display = 'flex'; }
function hideRollPopup() { $('roll-popup').style.display = 'none'; }
$('pop-roll').addEventListener('click', doRoll);

const KEEP_HINTS = new Set(['No moves for that marble.']);
function setHint(msg) {
  if (msg && !KEEP_HINTS.has(msg)) msg = '';
  const el = $('move-hint');
  el.textContent = msg;
  el.style.display = msg ? 'block' : 'none';
}

function isMyTurn() {
  return gameState && gameState.turnIndex === myPlayerIndex;
}

// Rotate the board so my own arm is at the bottom of the screen.
function faceMyArm() {
  applyColorSwap();
  const color = gameState?.players?.[myPlayerIndex]?.color;
  const arm = PLAYER_CONFIG.findIndex(c => c.color === color);
  setViewArm(arm >= 0 ? arm : 0);
  applySquareNumbers();
}
// My countdown numbers on the board (if the option is on).
function applySquareNumbers() {
  const arm = playerArm(myPlayerIndex ?? 0);
  setSquareLabels(settings.numbers ? s => countdown(arm, s) : null);
}

function playerName(index) {
  return gameState?.players?.[index]?.name ?? `Player ${index + 1}`;
}

// Keep the entire game history visible. The ceiling is just a safety guard
// against pathological unbounded DOM growth, not a normal-game limit.
const LOG_MAX = 5000;
function log(msg, color, cls) {
  const el = $('game-log');
  const entry = document.createElement('div');
  entry.className = 'log-entry' + (cls ? ' ' + cls : '');
  if (color) {
    const dot = document.createElement('span');
    dot.className = 'log-dot';
    dot.style.background = COLOR_MAP[dc(color)] ?? '#888';
    entry.appendChild(dot);
  }
  entry.appendChild(document.createTextNode(msg));
  el.appendChild(entry);
  // Prevent unbounded growth on long games
  while (el.children.length > LOG_MAX) el.removeChild(el.firstChild);
  el.scrollTop = el.scrollHeight;
}

// ---- Canvas resize ----
// iPad/iPhone: the visible area changes as the browser toolbars show/hide.
// The height the browser really shows (iPad Safari's 100vh/100dvh can include
// space under its toolbars): the page and the board are sized from this.
function setAppHeight() {
  const h = Math.round(window.visualViewport?.height ?? window.innerHeight);
  document.documentElement.style.setProperty('--app-h', `${h}px`);
}
setAppHeight();
window.addEventListener('resize', setAppHeight);
window.addEventListener('orientationchange', () => setTimeout(() => { setAppHeight(); window.dispatchEvent(new Event('resize')); }, 300));
window.visualViewport?.addEventListener('resize', () => { setAppHeight(); window.dispatchEvent(new Event('resize')); });
window.addEventListener('orientationchange', () => setTimeout(() => window.dispatchEvent(new Event('resize')), 300));
window.addEventListener('resize', () => {
  resizeBoard();
  if ($('game-layout').classList.contains('analysis-mode') && apSel >= 0) selectRoll(apSel, apOpt);
  else if (gameState) drawBoard(gameState);
});

// ---- Initial connect on load ----
// Connection is deferred until user takes action (create/join)
