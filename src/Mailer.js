// Mailer.js — send a plain-text email through the system's sendmail (FreeBSD
// and most Unix servers have one). Settings (environment):
//   MAIL_FROM   sender address (default noreply@<host of PUBLIC_URL>)
//   SENDMAIL    path to sendmail (default /usr/sbin/sendmail)
//   PUBLIC_URL  the site's address for links (else ORIGIN, else http://localhost:8080)
// Without a working sendmail the message is written to the server log, so an
// admin can still pass the link on.
import { spawn } from 'child_process';
import { existsSync } from 'fs';

export const publicUrl = () => (process.env.PUBLIC_URL || process.env.ORIGIN || 'http://localhost:8080').replace(/\/+$/, '');
const clean = s => String(s).replace(/[\r\n]+/g, ' ');

export function sendMail(to, subject, text) {
  const bin = process.env.SENDMAIL || '/usr/sbin/sendmail';
  const from = process.env.MAIL_FROM || `noreply@${new URL(publicUrl()).hostname}`;
  if (process.env.NODE_ENV === 'test' || !existsSync(bin)) {
    console.log(`[mail] (not sent: no sendmail) to=${clean(to)} subject=${clean(subject)}\n${text}`);
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
