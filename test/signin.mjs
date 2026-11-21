// Sign-in without a password: the Google ID-token check (with a key of our own
// standing in for Google's) and the passkey store. (Passkey ceremonies run in a
// browser; see the end-to-end check in the notes.)
import { generateKeyPairSync, sign } from 'crypto';
import { verifyGoogleToken } from '../src/SignIn.js';
import * as store from '../src/Store.js';

let passed = 0, failed = 0;
const assert = (c, l) => { if (c) { console.log(`  ✓ ${l}`); passed++; } else { console.error(`  ✗ ${l}`); failed++; } };

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256' };
const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
const token = (claims, { kid = 'k1', key = privateKey } = {}) => {
  const head = b64({ alg: 'RS256', kid }), body = b64(claims);
  return `${head}.${body}.${sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key).toString('base64url')}`;
};
const good = { iss: 'https://accounts.google.com', aud: 'cid', sub: '123', email: 'a@b.co', email_verified: true, given_name: 'Ada', exp: Date.now() / 1000 + 600 };
const opts = { keys: [jwk], clientId: 'cid' };

console.log('Google ID tokens');
assert((await verifyGoogleToken(token(good), opts))?.sub === '123', 'a genuine token for us is accepted');
assert(!(await verifyGoogleToken(token({ ...good, aud: 'other' }), opts)), 'a token for another app is refused');
assert(!(await verifyGoogleToken(token({ ...good, iss: 'evil.example' }), opts)), 'a token from another issuer is refused');
assert(!(await verifyGoogleToken(token({ ...good, exp: Date.now() / 1000 - 3600 }), opts)), 'an expired token is refused');
const other = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
assert(!(await verifyGoogleToken(token(good, { key: other }), opts)), 'a token signed with another key is refused');
const t = token(good), [h, , s] = t.split('.');
assert(!(await verifyGoogleToken(`${h}.${b64({ ...good, sub: '999' })}.${s}`, opts)), 'a tampered token is refused');
assert(!(await verifyGoogleToken('nonsense', opts)), 'garbage is refused');

console.log('\nAccounts from Google, passkeys');
store.openStore(':memory:', ':memory:');
const r = store.registerFromIdentity('Ada', 'google', '123', 'a@b.co');
assert(r.player?.name === 'Ada' && store.identityPlayer('google', '123')?.id === r.player.id, 'a new account named after them, linked');
const r2 = store.registerFromIdentity('Ada', 'google', '456', null);
assert(r2.player?.name === 'Ada 2', 'the name is made unique');
assert(store.signInIdentity('google', '123')?.key, 'signing in through the link opens a session');
assert(!store.hasPassword(r.player.id), 'no password needed');
store.addPasskey(r.player.id, { id: 'cred1', publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: ['internal'], label: 'Mac' });
assert(store.passkeysOf(r.player.id).length === 1 && store.passkeyById('cred1').publicKey.length === 3, 'a passkey is kept');
assert(store.signInPasskey('cred1', 5)?.player.id === r.player.id && store.passkeyById('cred1').counter === 5, 'passkey sign-in opens a session and bumps its counter');
store.removePasskey(r.player.id, 'cred1');
assert(!store.passkeyById('cred1'), 'a passkey can be removed');

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed ? 1 : 0);
