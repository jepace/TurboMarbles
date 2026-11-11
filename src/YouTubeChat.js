// YouTubeChat.js — reads the live chat of the YouTube stream (Data API v3,
// with an API key set on the Admin page) and hands new messages to the
// listener (the robot watch rooms: their AI commentator and the template
// commentary's greetings).
//
// Finding the chat: youtubeSource (or else the stream link) may name a video
// (watch?v=…, youtu.be/…, /live/<id>) — then videos.list gives its live chat
// (1 quota unit) — or a channel (@handle or a channel URL), whose current live
// video is looked up with search.list (100 units, at most every 30 minutes
// while nothing is live). Reading: liveChatMessages.list (5 units) every
// chatEverySec seconds (default 60 ≈ 7,200 units a day, inside the default
// 10,000/day), never faster than YouTube's own pollingIntervalMillis.
import { setting, settingNum, onSettingsChange } from './SiteSettings.js';

const API = 'https://www.googleapis.com/youtube/v3';

export function parseSource(src) {
  const s = String(src ?? '').trim();
  if (!s) return null;
  let m = s.match(/(?:v=|youtu\.be\/|\/live\/|\/shorts\/)([\w-]{11})/);
  if (m) return { video: m[1] };
  if (/^[\w-]{11}$/.test(s)) return { video: s };
  m = s.match(/\/channel\/(UC[\w-]{22})/) ?? s.match(/^(UC[\w-]{22})$/);
  if (m) return { channel: m[1] };
  m = s.match(/@([\w.-]{3,100})/);
  if (m) return { handle: m[1] };
  return null;
}

export class YouTubeChat {
  constructor({ onMessages, isWanted, fetchImpl = fetch, now = () => Date.now() } = {}) {
    this.onMessages = onMessages;      // (messages: [{ author, text, at }]) => void
    this.isWanted = isWanted ?? (() => true);   // only poll while someone watches a stream room
    this.fetch = fetchImpl;
    this.now = now;
    this.reset();
    this.timer = null;
    onSettingsChange(() => this.reset());
  }
  reset() {
    this.chatId = null; this.videoId = null; this.pageToken = null; this.nextAt = 0; this.lookupAt = 0;
    this.seen = new Set(); this.primed = false;
    this.status = { state: 'idle', lastPoll: null, messages: 0, quota: this.status?.quota ?? { day: null, units: 0 }, lastError: null, video: null };
  }
  start(everyMs = 5000) { if (!this.timer) { this.timer = setInterval(() => this.tick().catch(() => {}), everyMs); this.timer.unref?.(); } }
  stop() { clearInterval(this.timer); this.timer = null; }

  spend(units) {
    const d = new Date(this.now()).toISOString().slice(0, 10);
    if (this.status.quota.day !== d) this.status.quota = { day: d, units: 0 };
    this.status.quota.units += units;
  }
  async get(path, params, units) {
    const q = new URLSearchParams({ ...params, key: setting('youtubeKey') });
    this.spend(units);
    const res = await this.fetch(`${API}/${path}?${q}`, { signal: AbortSignal.timeout(20_000) });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(j?.error?.message ?? `HTTP ${res.status}`); e.status = res.status; e.reason = j?.error?.errors?.[0]?.reason; throw e; }
    return j;
  }

  // Find the live chat for the configured source.
  async findChat() {
    const src = parseSource(setting('youtubeSource') || setting('streamUrl'));
    if (!src) { this.status.state = 'no source'; return; }
    let video = src.video;
    if (!video) {
      if (this.now() < this.lookupAt) return;
      this.lookupAt = this.now() + 30 * 60_000;        // a channel search costs 100 units
      let channel = src.channel;
      if (!channel) {
        const c = await this.get('channels', { part: 'id', forHandle: '@' + src.handle }, 1);
        channel = c.items?.[0]?.id;
        if (!channel) { this.status.state = 'channel not found'; return; }
      }
      const s = await this.get('search', { part: 'id', channelId: channel, eventType: 'live', type: 'video', maxResults: '1' }, 100);
      video = s.items?.[0]?.id?.videoId;
      if (!video) { this.status.state = 'not live'; return; }
    }
    const v = await this.get('videos', { part: 'liveStreamingDetails', id: video }, 1);
    const chat = v.items?.[0]?.liveStreamingDetails?.activeLiveChatId;
    if (!chat) { this.status.state = 'no live chat'; this.lookupAt = this.now() + 5 * 60_000; return; }
    this.chatId = chat; this.videoId = video; this.status.video = video; this.status.state = 'connected';
  }

  async tick() {
    if (!setting('youtubeKey') || !this.isWanted()) { if (this.status.state !== 'off') this.status.state = setting('youtubeKey') ? 'waiting for a stream room' : 'off'; return; }
    if (this.now() < this.nextAt || this.busy) return;
    this.busy = true;
    try {
      if (!this.chatId) { await this.findChat(); if (!this.chatId) { this.nextAt = this.now() + 60_000; return; } }
      const j = await this.get('liveChat/messages', { liveChatId: this.chatId, part: 'snippet,authorDetails', maxResults: '200', ...(this.pageToken ? { pageToken: this.pageToken } : {}) }, 5);
      this.pageToken = j.nextPageToken ?? this.pageToken;
      const fresh = [];
      for (const it of j.items ?? []) {
        if (this.seen.has(it.id)) continue;
        this.seen.add(it.id);
        const text = it.snippet?.displayMessage ?? it.snippet?.textMessageDetails?.messageText;
        if (text && it.snippet?.type === 'textMessageEvent') fresh.push({ author: it.authorDetails?.displayName ?? 'viewer', text, at: it.snippet?.publishedAt });
      }
      if (this.seen.size > 5000) this.seen = new Set([...this.seen].slice(-2000));
      // The first read returns the backlog: skip it, only react to what's new.
      if (this.primed && fresh.length) { this.status.messages += fresh.length; this.onMessages?.(fresh); }
      this.primed = true;
      this.status.lastPoll = this.now(); this.status.lastError = null; this.status.state = 'connected';
      this.nextAt = this.now() + Math.max(j.pollingIntervalMillis ?? 0, settingNum('chatEverySec', 20, 3600) * 1000);
    } catch (err) {
      this.status.lastError = { at: this.now(), message: String(err.message).slice(0, 200), status: err.status ?? null };
      console.error('[youtube] chat read failed:', this.status.lastError.message);
      // The chat ended or went away: look it up again; quota trouble: wait an hour.
      if (err.status === 403 && /quota/i.test(err.reason ?? err.message)) this.nextAt = this.now() + 60 * 60_000;
      else { this.chatId = null; this.pageToken = null; this.primed = false; this.nextAt = this.now() + 2 * 60_000; }
      this.status.state = 'error';
    } finally { this.busy = false; }
  }
}
