// loadConfig.js — read the server's settings file before anything else starts
// (imported first by server.js). The file is CONFIG_FILE, else
// /usr/local/etc/turbomarbles.conf if it exists; a missing file is fine.
//
// Format: one KEY=value per line, # comments, optional quotes around the value.
// The keys are the environment variables the server reads (PORT, HOST, ORIGIN,
// TRUST_PROXY, DATA_DIR, PUBLIC_URL, MAIL_FROM, RESEND_API_KEY, STREAM_URL, …).
// A variable already set in the environment wins over the file.
import { existsSync, readFileSync } from 'fs';

export function parseConfig(text) {
  const out = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]] = v;
  }
  return out;
}

const file = process.env.CONFIG_FILE || '/usr/local/etc/turbomarbles.conf';
if (existsSync(file)) {
  try {
    const vals = parseConfig(readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(vals)) if (process.env[k] === undefined) process.env[k] = v;
    console.log(`[config] ${file}: ${Object.keys(vals).length} settings`);
  } catch (e) { console.error(`[config] could not read ${file}:`, e.message); }
}
