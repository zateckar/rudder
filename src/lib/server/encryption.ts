import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';
import { env } from './env';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer {
  const hash = createHash('sha256').update(env.ENCRYPTION_KEY).digest();
  return hash;
}

export function encrypt(text: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  
  const authTag = cipher.getAuthTag();
  
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
}

export function decrypt(encryptedText: string): string {
  const parts = encryptedText.split(':');
  
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted text format');
  }
  
  const iv = Buffer.from(parts[0], 'hex');
  const authTag = Buffer.from(parts[1], 'hex');
  const encrypted = parts[2];
  
  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(authTag);
  
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  
  return decrypted;
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/** Shape produced by `encrypt`: hex IV : hex auth tag : hex ciphertext. */
const ENCRYPTED_PATTERN = /^[0-9a-f]{32}:[0-9a-f]{32}:[0-9a-f]*$/i;

/** True when `value` looks like output of `encrypt`. */
export function isEncrypted(value: string): boolean {
  return ENCRYPTED_PATTERN.test(value);
}

/**
 * Encrypt a value that may already be encrypted (idempotent).
 * Use for credential columns so repeated writes don't double-encrypt.
 */
export function encryptField(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return isEncrypted(value) ? value : encrypt(value);
}

/**
 * Decrypt a credential column, tolerating rows written before the column was
 * encrypted.  Legacy plaintext is returned as-is so existing workers keep
 * functioning; it is re-encrypted the next time the record is written.
 */
export function decryptField(value: string): string;
export function decryptField(value: string | null | undefined): string | null;
export function decryptField(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (!isEncrypted(value)) return value;
  try {
    return decrypt(value);
  } catch {
    // Wrong ENCRYPTION_KEY, or corrupted data. Surfacing null lets callers
    // fail with a clear "no credentials" error rather than a crypto stack trace.
    console.error('[encryption] Failed to decrypt a stored credential field.');
    return null;
  }
}
