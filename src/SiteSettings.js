// SiteSettings.js — settings an admin changes on the Admin page (no config files):
// the live stream link, the AI commentator and the YouTube chat reader.
// Kept in the database (Store meta table); secrets (API keys) never leave the
// server: the admin view shows only whether a key is set and its last 4 characters.
import { getSettings, setSetting, storeEnabled } from './Store.js';

import { PROVIDERS, KNOWN_PRICES } from './ai/providers.js';

const DEFAULTS = {
  streamUrl: process.env.STREAM_URL ?? '',
  aiEnabled: '0',
  aiProvider: 'anthropic',  // anthropic | google | openai (OpenAI-compatible)
  aiModel: 'claude-opus-5-5',
  aiBaseUrl: '',            // OpenAI-compatible endpoint (default https://api.openai.com/v1)
  aiPriceIn: '',            // $ per million input tokens, for the cost estimate ('' = known price, if any)
  aiPriceOut: '',
  aiEverySec: '15',        // at most one AI line per this many seconds
  aiDailyCalls: '3000',    // hard cap on API calls per day
  aiKey: '',
  youtubeKey: '',
  youtubeSource: '',       // channel (@handle or URL) or a stream URL; default: the stream link
  chatEverySec: '60',      // how often to read the chat (YouTube's daily quota: ~60 s around the clock)
};
const SECRET = new Set(['aiKey', 'youtubeKey']);
let cache = null;
const load = () => (cache ??= { ...DEFAULTS, ...(storeEnabled() ? getSettings() : {}) });

export function setting(key) { return load()[key] ?? DEFAULTS[key]; }
export const settingOn = key => setting(key) === '1';
export const settingNum = (key, min, max) => Math.min(max, Math.max(min, Number(setting(key)) || Number(DEFAULTS[key])));

const listeners = new Set();
export function onSettingsChange(fn) { listeners.add(fn); }

// What the Admin page sees.
export function adminView() {
  const s = load(), out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = SECRET.has(k) ? (s[k] ? '…' + s[k].slice(-4) : '') : s[k];
  return { settings: out, providers: PROVIDERS, knownPrices: KNOWN_PRICES, persisted: storeEnabled() };
}

// Save from the Admin page. Secrets: '' clears, a value starting with '…' (the masked view) keeps it.
export function saveSettings(input) {
  const s = load();
  const clean = {
    streamUrl: v => (v === '' || /^https:\/\/[^\s"'<>]{4,300}$/.test(v) ? v : null),
    aiEnabled: v => (v === '1' || v === '0' ? v : null),
    aiProvider: v => (PROVIDERS[v] ? v : null),
    aiModel: v => (/^[\w.:\/@-]{1,120}$/.test(v) ? v : null),
    aiBaseUrl: v => (v === '' || /^https?:\/\/[^\s"'<>]{3,300}$/.test(v) ? v : null),
    aiPriceIn: v => (v === '' || /^\d{1,4}(\.\d{1,4})?$/.test(v) ? v : null),
    aiPriceOut: v => (v === '' || /^\d{1,4}(\.\d{1,4})?$/.test(v) ? v : null),
    aiEverySec: v => (/^\d{1,4}$/.test(v) ? String(Math.min(600, Math.max(6, +v))) : null),
    aiDailyCalls: v => (/^\d{1,6}$/.test(v) ? v : null),
    aiKey: v => (v.startsWith('…') ? undefined : v === '' || /^[\w.\-:]{8,300}$/.test(v) ? v : null),
    youtubeKey: v => (v.startsWith('…') ? undefined : v === '' || /^[\w-]{20,200}$/.test(v) ? v : null),
    youtubeSource: v => (v === '' || /^[@\w:/.?=&%-]{3,300}$/.test(v) ? v : null),
    chatEverySec: v => (/^\d{1,4}$/.test(v) ? String(Math.min(3600, Math.max(20, +v))) : null),
  };
  const bad = [];
  for (const [k, fn] of Object.entries(clean)) {
    if (!(k in input)) continue;
    const v = fn(String(input[k] ?? '').trim());
    if (v === undefined) continue;
    if (v === null) { bad.push(k); continue; }
    s[k] = v; setSetting(k, v === DEFAULTS[k] && !SECRET.has(k) ? '' : v);
  }
  for (const fn of listeners) { try { fn(); } catch (err) { console.error('[settings]', err); } }
  return { ok: !bad.length, bad };
}

// Price per million tokens [input, output] for the configured model (entered, else known).
export function aiPrices() {
  const known = KNOWN_PRICES[setting('aiModel')] ?? [0, 0];
  return [setting('aiPriceIn') !== '' ? +setting('aiPriceIn') : known[0], setting('aiPriceOut') !== '' ? +setting('aiPriceOut') : known[1]];
}
