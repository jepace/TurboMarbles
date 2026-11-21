// SignIn.js — signing in without a password: Google (an ID token from Google
// Identity Services, checked here against Google's public keys) and passkeys
// (WebAuthn, through @simplewebauthn/server).
//
// Settings (environment / turbomarbles.conf):
//   GOOGLE_CLIENT_ID  the OAuth client id (console.cloud.google.com → Credentials);
//                     without it the Google button isn't shown.
//   PUBLIC_URL / ORIGIN  the site's address: passkeys are bound to its host name.
import { createPublicKey, verify as cryptoVerify } from 'crypto';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';

export const googleClientId = () => process.env.GOOGLE_CLIENT_ID || null;

// ---- Google ------------------------------------------------------------------------
let jwks = { keys: [], at: 0 };
async function googleKeys(force = false) {
  if (!force && Date.now() - jwks.at < 3600e3 && jwks.keys.length) return jwks.keys;
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs', { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Google keys: ${res.status}`);
  jwks = { keys: (await res.json()).keys ?? [], at: Date.now() };
  return jwks.keys;
}
const b64 = s => Buffer.from(s, 'base64url');
// The ID token's claims if it is genuine, for us, and current; else null.
export async function verifyGoogleToken(token, { keys = null, clientId = googleClientId(), now = Date.now() } = {}) {
  if (!clientId || typeof token !== 'string' || token.length > 4096) return null;
  const [h, p, sig] = token.split('.');
  if (!h || !p || !sig) return null;
  let header, claims;
  try { header = JSON.parse(b64(h)); claims = JSON.parse(b64(p)); } catch { return null; }
  if (header.alg !== 'RS256') return null;
  let list = keys ?? await googleKeys();
  let jwk = list.find(k => k.kid === header.kid);
  if (!jwk && !keys) { list = await googleKeys(true); jwk = list.find(k => k.kid === header.kid); }   // Google rotated its keys
  if (!jwk) return null;
  const ok = cryptoVerify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: 'jwk' }), b64(sig));
  if (!ok) return null;
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss)) return null;
  if (claims.aud !== clientId) return null;
  if (!(claims.exp * 1000 > now - 60e3)) return null;
  return claims;   // sub, email, email_verified, name, given_name…
}

// ---- Passkeys ------------------------------------------------------------------------
// The site the passkeys belong to: its origin and host name.
function rp(reqOrigin) {
  const site = process.env.PUBLIC_URL || process.env.ORIGIN || reqOrigin || 'http://localhost:8080';
  const u = new URL(site);
  return { origin: u.origin, id: u.hostname, name: 'TurboMarbles' };
}
export async function passkeyRegisterOptions(player, existing, reqOrigin) {
  const r = rp(reqOrigin);
  return generateRegistrationOptions({
    rpName: r.name, rpID: r.id, userName: player.name, userID: new TextEncoder().encode(player.id),
    attestationType: 'none', excludeCredentials: existing.map(c => ({ id: c.id, transports: c.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
}
export async function passkeyRegisterVerify(response, challenge, reqOrigin) {
  const r = rp(reqOrigin);
  const v = await verifyRegistrationResponse({ response, expectedChallenge: challenge, expectedOrigin: r.origin, expectedRPID: r.id, requireUserVerification: false });
  if (!v.verified || !v.registrationInfo) return null;
  const c = v.registrationInfo.credential;
  return { id: c.id, publicKey: c.publicKey, counter: c.counter, transports: c.transports ?? response.response?.transports ?? [] };
}
export async function passkeyLoginOptions(reqOrigin) {
  return generateAuthenticationOptions({ rpID: rp(reqOrigin).id, userVerification: 'preferred', allowCredentials: [] });
}
export async function passkeyLoginVerify(response, challenge, stored, reqOrigin) {
  const r = rp(reqOrigin);
  const v = await verifyAuthenticationResponse({ response, expectedChallenge: challenge, expectedOrigin: r.origin, expectedRPID: r.id,
    credential: { id: stored.id, publicKey: stored.publicKey, counter: stored.counter, transports: stored.transports }, requireUserVerification: false });
  return v.verified ? v.authenticationInfo.newCounter : null;
}
