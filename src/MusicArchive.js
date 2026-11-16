// MusicArchive.js — recordings of each game's music, uploaded by the stream
// page (?record=<RECORD_KEY>), kept as MP3 (ffmpeg converts; without ffmpeg the
// upload is kept as it came). The newest two per song are kept.
// Files: <DATA_DIR>/music/<song>/<YYYY-MM-DD_HH-MM-SS>_game<N>.mp3
import { spawn } from 'child_process';
import { mkdirSync, writeFileSync, readdirSync, unlinkSync, existsSync } from 'fs';
import { join } from 'path';

const KEEP = 2;
export const musicDir = () => join(process.env.DATA_DIR || new URL('../data/', import.meta.url).pathname, 'music');
const slug = s => String(s ?? 'song').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'song';
const FFMPEG = () => process.env.FFMPEG || ['/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find(p => existsSync(p));

export function recordKeyOk(key) {
  const k = process.env.RECORD_KEY;
  return !!k && typeof key === 'string' && key === k;
}

// Save one upload (a WebM/Ogg audio Buffer). Resolves to the saved path.
export function saveRecording(buf, { song, game, mime = 'audio/webm' } = {}) {
  const dir = join(musicDir(), slug(song));
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
  const base = `${stamp}_game${Number(game) || 0}`;
  const ext = mime.includes('mp4') || mime.includes('aac') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
  const raw = join(dir, `${base}.${ext}`);
  writeFileSync(raw, buf);
  const ff = FFMPEG();
  const done = path => { prune(dir); return path; };
  if (!ff || ext === 'm4a') return Promise.resolve(done(raw));   // M4A is fine for podcasts as it is
  const mp3 = join(dir, `${base}.mp3`);
  return new Promise(resolve => {
    const p = spawn(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw, '-codec:a', 'libmp3lame', '-q:a', '3', mp3], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', d => { err += d; });
    p.on('error', () => resolve(done(raw)));
    p.on('close', code => {
      if (code === 0) { try { unlinkSync(raw); } catch {} resolve(done(mp3)); }
      else { console.error('[music] ffmpeg failed', err.trim().slice(0, 200)); resolve(done(raw)); }
    });
  });
}

// Keep the newest KEEP recordings in a song's folder.
function prune(dir) {
  const files = readdirSync(dir).filter(f => /\.(mp3|m4a|webm|ogg)$/.test(f)).sort().reverse();
  for (const f of files.slice(KEEP)) { try { unlinkSync(join(dir, f)); } catch {} }
}

// Every kept recording, newest first: [{ song, file, size, at }] (for the podcast feed).
import { statSync } from 'fs';
const SONG_TITLE = slugName => slugName.split('-').map(w => w[0]?.toUpperCase() + w.slice(1)).join(' ');
export function listRecordings() {
  const root = musicDir(); const out = [];
  if (!existsSync(root)) return out;
  for (const song of readdirSync(root)) {
    let files; try { files = readdirSync(join(root, song)); } catch { continue; }
    for (const file of files) if (/\.(mp3|m4a)$/.test(file)) {
      const st = statSync(join(root, song, file));
      out.push({ song, title: SONG_TITLE(song), file, size: st.size, at: st.mtimeMs });
    }
  }
  return out.sort((a, b) => b.at - a.at);
}
export const recordingPath = (song, file) => {
  if (!/^[a-z0-9-]{1,40}$/.test(song) || !/^[\w-]+\.(mp3|m4a)$/.test(file)) return null;   // no path tricks
  const p = join(musicDir(), song, file);
  return existsSync(p) ? p : null;
};
