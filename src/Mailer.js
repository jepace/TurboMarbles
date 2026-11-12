// Mailer.js — send a plain-text email: through Resend (resend.com) when
// RESEND_API_KEY is set, else through the system's sendmail. Settings (environment):
//   RESEND_API_KEY  Resend API key (re_…), or RESEND_API_KEY_FILE: a file holding it;
//                   MAIL_FROM must be on a domain verified in Resend
//   MAIL_FROM   sender address (default noreply@<host of PUBLIC_URL>)
//   SENDMAIL    path to sendmail (default /usr/sbin/sendmail)
//   PUBLIC_URL  the site's address for links (else ORIGIN, else http://localhost:8080)
// Without a working sendmail the message is written to the server log, so an
// admin can still pass the link on.
import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';

export const publicUrl = () => (process.env.PUBLIC_URL || process.env.ORIGIN || 'http://localhost:8080').replace(/\/+$/, '');
const clean = s => String(s).replace(/[\r\n]+/g, ' ');

function resendKey() {
  if (process.env.RESEND_API_KEY) return process.env.RESEND_API_KEY.trim();
  const f = process.env.RESEND_API_KEY_FILE;
  try { return f && existsSync(f) ? readFileSync(f, 'utf8').trim() : ''; } catch { return ''; }
}
async function sendResend(key, from, to, subject, text) {
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: `TurboMarbles <${clean(from)}>`, to: [clean(to)], subject: clean(subject), text }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) { console.error('[mail] resend failed', res.status, (await res.text()).slice(0, 300)); return false; }
    return true;
  } catch (e) { console.error('[mail] resend failed', e.message); return false; }
}

export function sendMail(to, subject, text) {
  const bin = process.env.SENDMAIL || '/usr/sbin/sendmail';
  const from = process.env.MAIL_FROM || `noreply@${new URL(publicUrl()).hostname}`;
  const key = resendKey();
  if (key && process.env.NODE_ENV !== 'test') return sendResend(key, from, to, subject, text);
  if (process.env.NODE_ENV === 'test' || !existsSync(bin)) {
    console.log(`[mail] (not sent: no Resend key or sendmail) to=${clean(to)} subject=${clean(subject)}\n${text}`);
    return Promise.resolve(false);
  }
  return new Promise(resolve => {
    const p = spawn(bin, ['-t', '-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { console.error('[mail] failed', e.message); resolve(false); });
    p.on('close', code => { if (code) console.error('[mail] sendmail exited', code, err.trim()); resolve(code === 0); });
    p.stdin.end(`From: TurboMarbles <${clean(from)}>\nTo: ${clean(to)}\nSubject: ${clean(subject)}\nContent-Type: text/plain; charset=utf-8\n\n${text}\n`);
  });
}
