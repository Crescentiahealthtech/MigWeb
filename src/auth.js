// ============================================================================
// Firebase (Google) sign-in, checked by the Worker.
// ----------------------------------------------------------------------------
// The page signs in with Google through the clinic's Firebase project (the
// same one the Apps Script app uses, cresrxdemo) and sends the ID token it
// gets. Here the token is verified against Google's published keys: RS256
// signature, issuer and audience = this project, not expired, issued with a
// Google account whose email Google has verified. The browser's word is never
// taken for who it is.
// ============================================================================

const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
let JWKS = { keys: null, until: 0 };

const b64urlBytes = (s) => {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const b64urlJson = (s) => JSON.parse(new TextDecoder().decode(b64urlBytes(s)));

async function googleKeys() {
  if (JWKS.keys && Date.now() < JWKS.until) return JWKS.keys;
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error('Google keys unavailable (' + res.status + ')');
  const body = await res.json();
  const m = /max-age=(\d+)/.exec(res.headers.get('cache-control') || '');
  JWKS = { keys: body.keys || [], until: Date.now() + (m ? +m[1] : 3600) * 1000 };
  return JWKS.keys;
}

/**
 * @return {Promise<{ok:true, email:string, uid:string} | {ok:false, message:string}>}
 */
export async function verifyFirebaseToken(token, projectId) {
  const fail = (message) => ({ ok: false, message });
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return fail('Not signed in.');
    const header = b64urlJson(parts[0]);
    const claims = b64urlJson(parts[1]);
    if (header.alg !== 'RS256' || !header.kid) return fail('Unexpected sign-in token.');
    const jwk = (await googleKeys()).find((k) => k.kid === header.kid);
    if (!jwk) { JWKS.until = 0; return fail('Sign-in token key not recognised; sign in again.'); }
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const good = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlBytes(parts[2]),
                                            new TextEncoder().encode(parts[0] + '.' + parts[1]));
    if (!good) return fail('Sign-in token signature is not valid.');
    const now = Math.floor(Date.now() / 1000);
    if (claims.iss !== 'https://securetoken.google.com/' + projectId || claims.aud !== projectId) return fail('Sign-in token is for another project.');
    if (!(claims.exp > now)) return fail('Your sign-in has expired; sign in again.');
    if (!(claims.iat <= now + 300) || !(claims.auth_time <= now + 300)) return fail('Sign-in token is not yet valid.');
    if (!claims.sub) return fail('Sign-in token has no user.');
    if (claims.email_verified !== true || !claims.email) return fail('Google has not verified this email address.');
    if (!claims.firebase || claims.firebase.sign_in_provider !== 'google.com') return fail('Sign in with Google.');
    return { ok: true, email: String(claims.email).trim().toLowerCase(), uid: claims.sub };
  } catch (e) {
    return fail('Sign-in could not be checked: ' + e.message);
  }
}
