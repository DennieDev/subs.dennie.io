import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

// A user token is the only thing in the addon URL. The database stores sha256(token) as
// the row id, and the row is encrypted with a key derived from SECRET_KEY *and* the token.
// A leaked database alone (or with SECRET_KEY) cannot be decrypted without the tokens.

const TOKEN_BYTES = 24;
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

export function newToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function isToken(value: string): boolean {
  return TOKEN_RE.test(value);
}

export function tokenId(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function deriveKey(secretKeyHex: string, token: string): Buffer {
  return Buffer.from(
    hkdfSync('sha256', Buffer.from(secretKeyHex, 'hex'), Buffer.from(token), 'subs-config-v1', 32),
  );
}

export function encrypt(secretKeyHex: string, token: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secretKeyHex, token), iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), body.toString('base64url')].join('.');
}

export function decrypt(secretKeyHex: string, token: string, payload: string): string {
  const [version, iv, tag, body] = payload.split('.');
  if (version !== 'v1' || !iv || !tag || body === undefined) throw new Error('Unsupported payload');
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(secretKeyHex, token), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(body, 'base64url')), decipher.final()]).toString('utf8');
}

export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}
