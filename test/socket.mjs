// Unit tests for public/js/socket.js — WebSocket queueing, dedup connect, dispatch.
// Runs in Node.js by mocking WebSocket and location globals before import.
// Run with: node test-socket.mjs

// ---- Mock WebSocket (mimics browser API) ------------------------------------

class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.CONNECTING;
    this.sent = [];
    this._listeners = {};
    MockWebSocket.last = this;
    MockWebSocket.instances.push(this);
  }
  addEventListener(event, fn, opts = {}) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push({ fn, once: !!opts.once });
  }
  send(data) { this.sent.push(data); }
  _emit(event, arg) {
    const list = this._listeners[event] || [];
    const keep = [];
    for (const entry of list) {
      entry.fn(arg);
      if (!entry.once) keep.push(entry);
    }
    this._listeners[event] = keep;
  }
  open() {
    this.readyState = MockWebSocket.OPEN;
    this._emit('open');
  }
  close(code = 1000) {
    this.readyState = MockWebSocket.CLOSED;
    this._emit('close', { code });
  }
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static last = null;
  static instances = [];
  static reset() { MockWebSocket.last = null; MockWebSocket.instances = []; }
}

global.WebSocket = MockWebSocket;
global.location = { protocol: 'http:', host: 'localhost:3000' };

import { connect, send, on, off, setReconnectInfo, _reset } from '../public/js/socket.js';

// ---- Harness ----------------------------------------------------------------

let passed = 0, failed = 0;
function assert(cond, label) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else       { console.error(`  ✗ ${label}`); failed++; }
}
function describe(label, fn) { console.log(`\n${label}`); fn(); }
function setup() { _reset(); MockWebSocket.reset(); }

// ---- Tests ------------------------------------------------------------------

describe('connect() — creates WebSocket with correct URL', () => {
  setup();
  connect();
  assert(MockWebSocket.instances.length === 1, 'one socket created');
  assert(MockWebSocket.last.url === 'ws://localhost:3000', 'ws:// for http: page');
});

describe('connect() — wss:// when page is https:', () => {
  setup();
  global.location = { protocol: 'https:', host: 'example.com' };
  connect();
  assert(MockWebSocket.last.url === 'wss://example.com', 'wss:// for https: page');
  global.location = { protocol: 'http:', host: 'localhost:3000' }; // restore
});

describe('connect() — no-op if already CONNECTING (bug fix: was creating two sockets)', () => {
  setup();
  connect();
  const first = MockWebSocket.last;
  connect(); // second call while still CONNECTING
  assert(MockWebSocket.instances.length === 1, 'no second socket while CONNECTING');
  assert(MockWebSocket.last === first, 'same socket instance returned');
});

describe('connect() — no-op if already OPEN', () => {
  setup();
  connect();
  MockWebSocket.last.open();
  const first = MockWebSocket.last;
  connect();
  assert(MockWebSocket.instances.length === 1, 'no second socket when OPEN');
  assert(MockWebSocket.last === first, 'same instance');
});

describe('send() — queues message while CONNECTING (race condition fix)', () => {
  setup();
  connect();
  assert(MockWebSocket.last.readyState === MockWebSocket.CONNECTING, 'starts CONNECTING');
  send({ action: 'createRoom', name: 'Alice', totalPlayers: 2 });
  assert(MockWebSocket.last.sent.length === 0, 'not sent yet while CONNECTING');
  MockWebSocket.last.open();
  assert(MockWebSocket.last.sent.length === 1, 'flushed exactly one message on open');
  assert(JSON.parse(MockWebSocket.last.sent[0]).action === 'createRoom', 'correct message content');
});

describe('send() — multiple queued messages flushed in order', () => {
  setup();
  connect();
  send({ action: 'createRoom', name: 'Alice', totalPlayers: 3 });
  send({ action: 'addRobot' });
  send({ action: 'startGame' });
  assert(MockWebSocket.last.sent.length === 0, 'nothing sent before open');
  MockWebSocket.last.open();
  assert(MockWebSocket.last.sent.length === 3, 'all 3 flushed');
  assert(JSON.parse(MockWebSocket.last.sent[0]).action === 'createRoom', 'first in order');
  assert(JSON.parse(MockWebSocket.last.sent[1]).action === 'addRobot',   'second in order');
  assert(JSON.parse(MockWebSocket.last.sent[2]).action === 'startGame',  'third in order');
});

describe('send() — sends immediately when already OPEN', () => {
  setup();
  connect();
  MockWebSocket.last.open();
  send({ action: 'roll' });
  assert(MockWebSocket.last.sent.length === 1, 'sent immediately');
  assert(JSON.parse(MockWebSocket.last.sent[0]).action === 'roll', 'correct action');
});

describe('send() — silently drops when socket is null (no throw)', () => {
  setup();
  let threw = false;
  try { send({ action: 'roll' }); } catch { threw = true; }
  assert(!threw, 'no exception before connect()');
});

describe('send() — silently drops when CLOSING/CLOSED', () => {
  setup();
  connect();
  MockWebSocket.last.open();
  MockWebSocket.last.close();
  send({ action: 'roll' });
  assert(MockWebSocket.last.sent.length === 0, 'nothing sent after close');
});

describe('on() — dispatches server event to registered handler', () => {
  setup();
  connect();
  MockWebSocket.last.open();
  let received = null;
  on('roomCreated', (msg) => { received = msg; });
  MockWebSocket.last._emit('message', { data: JSON.stringify({ event: 'roomCreated', code: 'ABCD' }) });
  assert(received !== null, 'handler called');
  assert(received.code === 'ABCD', 'payload passed through');
});

describe('on() — multiple handlers for same event all fire', () => {
  setup();
  connect();
  MockWebSocket.last.open();
  let a = 0, b = 0;
  on('rolled', () => a++);
  on('rolled', () => b++);
  MockWebSocket.last._emit('message', { data: JSON.stringify({ event: 'rolled', dice: [3, 5] }) });
  assert(a === 1 && b === 1, 'both handlers called');
});

describe('off() — removes specific handler', () => {
  setup();
  connect();
  MockWebSocket.last.open();
  let count = 0;
  const fn = () => count++;
  on('marbleMoved', fn);
  MockWebSocket.last._emit('message', { data: JSON.stringify({ event: 'marbleMoved' }) });
  off('marbleMoved', fn);
  MockWebSocket.last._emit('message', { data: JSON.stringify({ event: 'marbleMoved' }) });
  assert(count === 1, 'handler fires once then removed');
});

describe('on() — ignores malformed JSON from server', () => {
  setup();
  connect();
  MockWebSocket.last.open();
  let threw = false;
  on('error', () => {});
  try {
    MockWebSocket.last._emit('message', { data: 'not-json{{{' });
  } catch { threw = true; }
  assert(!threw, 'malformed JSON does not throw');
});

describe('reconnect — new socket created after close with reconnectInfo', () => {
  setup();
  setReconnectInfo({ roomId: 'r1', playerIndex: 0, reconnectToken: 'tok' });
  connect();
  MockWebSocket.last.open();

  // Intercept setTimeout so we can fire it immediately
  const origSetTimeout = global.setTimeout;
  let timerFn = null;
  global.setTimeout = (fn) => { timerFn = fn; return 42; };
  MockWebSocket.last.close();
  global.setTimeout = origSetTimeout;

  assert(timerFn !== null, 'setTimeout scheduled on close');
  timerFn(); // fire the reconnect timer

  assert(MockWebSocket.instances.length === 2, 'new socket created for reconnect');
  MockWebSocket.last.open(); // complete the new handshake

  const msgs = MockWebSocket.last.sent.map(s => JSON.parse(s));
  assert(msgs.some(m => m.action === 'reconnect'), 'reconnect action sent');
  assert(msgs.find(m => m.action === 'reconnect')?.reconnectToken === 'tok', 'token included');
});

describe('reconnect — no retry when reconnectInfo is null', () => {
  setup();
  connect();
  MockWebSocket.last.open();

  let timerCalled = false;
  const origSetTimeout = global.setTimeout;
  global.setTimeout = () => { timerCalled = true; return 0; };
  MockWebSocket.last.close();
  global.setTimeout = origSetTimeout;

  assert(!timerCalled, 'no setTimeout when reconnectInfo is null');
});

// ---- Summary ----------------------------------------------------------------

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
