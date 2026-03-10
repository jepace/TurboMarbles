// socket.js — WebSocket client wrapper with event dispatch

const handlers = {};

let ws = null;
let reconnectInfo = null; // { roomId, playerIndex, reconnectToken }
let sendQueue = [];       // messages buffered while connecting

export function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);

  ws.addEventListener('open', () => {
    // Flush any messages that were queued before the connection opened
    const queued = sendQueue.splice(0);
    queued.forEach(msg => ws.send(JSON.stringify(msg)));
  });

  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    const fns = handlers[msg.event] || [];
    fns.forEach(fn => fn(msg));
  });

  ws.addEventListener('close', () => {
    // Attempt reconnect after brief delay if we have context
    if (reconnectInfo) {
      setTimeout(() => {
        ws = null;
        connect();
        ws.addEventListener('open', () => {
          send({ action: 'reconnect', ...reconnectInfo });
        }, { once: true });
      }, 2000);
    }
  });
}

export function on(event, fn) {
  if (!handlers[event]) handlers[event] = [];
  handlers[event].push(fn);
}

export function off(event, fn) {
  if (!handlers[event]) return;
  handlers[event] = handlers[event].filter(f => f !== fn);
}

export function send(msg) {
  if (!ws) return;
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else if (ws.readyState === WebSocket.CONNECTING) {
    sendQueue.push(msg);
  }
}

export function setReconnectInfo(info) {
  reconnectInfo = info;
}
