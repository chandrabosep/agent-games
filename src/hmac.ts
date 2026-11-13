import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-agent-games-signature';

/**
 * The platform shows the secret once as plaintext; it is undocumented whether
 * the HMAC key is that text's UTF-8 bytes or its hex-decoded 32 bytes. We
 * accept whichever one the inbound signature proves, and sign the response
 * with the same key.
 */
export function candidateKeys(secret: string): Buffer[] {
  const keys = [Buffer.from(secret, 'utf8')];
  if (/^[0-9a-fA-F]{64}$/.test(secret)) keys.push(Buffer.from(secret, 'hex'));
  return keys;
}

export function sign(key: Buffer, body: Buffer | string): string {
  return createHmac('sha256', key).update(body).digest('hex');
}

/** Returns the key that produced `header` over the raw body, or null if none did. */
export function verify(keys: Buffer[], rawBody: Buffer, header: string | undefined): Buffer | null {
  if (!header) return null;
  const given = header.trim().replace(/^sha256=/i, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(given)) return null;
  const givenBytes = Buffer.from(given, 'hex');
  for (const key of keys) {
    const expected = Buffer.from(sign(key, rawBody), 'hex');
    if (timingSafeEqual(expected, givenBytes)) return key;
  }
  return null;
}
