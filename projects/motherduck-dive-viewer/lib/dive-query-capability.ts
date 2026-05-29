import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto';

/**
 * Short-lived, encrypted capability that lets the sandboxed (opaque-origin)
 * Dive iframe call the query proxy WITHOUT the user's session cookie.
 *
 * The viewer page (which has the session) mints a capability wrapping the
 * user's OAuth access token + dive id + expiry, AES-256-GCM encrypted with a
 * key derived from DIVE_QUERY_SECRET. The proxy decrypts it server-side to
 * recover the access token and mint the real MotherDuck SLT there — so the
 * MotherDuck token never reaches the browser. Because it's encrypted, Dive
 * code that reads the capability off the page can't extract the token; because
 * it's short-lived and only the read-only proxy honors it, a leaked capability
 * grants at most brief read-only proxy access.
 */

const TTL_MS = 10 * 60 * 1000; // 10 minutes

function key(): Buffer {
  const secret = process.env.DIVE_QUERY_SECRET;
  if (!secret) {
    throw new Error('DIVE_QUERY_SECRET is not set');
  }
  return createHash('sha256').update(secret).digest(); // fixed 32 bytes
}

export interface RequiredDatabase {
  path: string;
  alias: string;
}

export interface CapabilityClaims {
  accessToken: string;
  diveId: string;
  /** The dive's REQUIRED_DATABASES, parsed server-side — NOT iframe-supplied. */
  requiredDatabases: RequiredDatabase[];
}

interface CapabilityPayload extends CapabilityClaims {
  exp: number;
}

/**
 * Encrypt the user's token + dive id + the dive's server-parsed required
 * databases into a base64url capability. Binding requiredDatabases here (rather
 * than trusting the iframe) means a capability holder can't ATTACH arbitrary
 * shares.
 */
export function mintCapability(
  accessToken: string,
  diveId: string,
  requiredDatabases: RequiredDatabase[],
): string {
  const payload: CapabilityPayload = {
    accessToken,
    diveId,
    requiredDatabases,
    exp: Date.now() + TTL_MS,
  };
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), 'utf8')),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  // token = base64url( iv(12) | tag(16) | ciphertext )
  return Buffer.concat([iv, tag, ciphertext]).toString('base64url');
}

/** Decrypt + validate a capability. Returns null if invalid/tampered/expired. */
export function verifyCapability(token: string): CapabilityClaims | null {
  try {
    const buf = Buffer.from(token, 'base64url');
    if (buf.length < 12 + 16 + 1) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ciphertext = buf.subarray(28);
    const decipher = createDecipheriv('aes-256-gcm', key(), iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    const payload = JSON.parse(plaintext.toString('utf8')) as CapabilityPayload;
    if (
      !payload ||
      typeof payload.accessToken !== 'string' || !payload.accessToken ||
      typeof payload.diveId !== 'string' || !payload.diveId ||
      typeof payload.exp !== 'number'
    ) {
      return null;
    }
    if (Date.now() > payload.exp) return null;
    const requiredDatabases = Array.isArray(payload.requiredDatabases)
      ? payload.requiredDatabases.filter(
          (d): d is RequiredDatabase =>
            !!d && typeof d.path === 'string' && typeof d.alias === 'string',
        )
      : [];
    return { accessToken: payload.accessToken, diveId: payload.diveId, requiredDatabases };
  } catch {
    return null;
  }
}
