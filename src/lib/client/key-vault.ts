/**
 * Browser-side encrypted SSH key vault.
 *
 * SSH private keys are encrypted using Web Crypto API (PBKDF2 + AES-256-GCM)
 * and stored in localStorage. The encryption envelope is derived from a
 * server-provided secret (tied to the user session), so keys are only
 * accessible to the authenticated user who stored them.
 *
 * Keys are NEVER sent to the server for storage — they're decrypted in the
 * browser and sent over the wire only when needed (e.g., provisioning, terminal).
 */

const STORAGE_PREFIX = 'rudder:ssh-key:';
const PBKDF2_ITERATIONS = 100_000;
const SALT_LENGTH = 16;
const IV_LENGTH = 12;

/** Derive an AES-256-GCM key from the envelope secret using PBKDF2. */
async function deriveKey(secret: string, salt: Uint8Array): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt.buffer as ArrayBuffer, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Encrypt an SSH private key for localStorage storage. */
export async function encryptKey(sshKey: string, envelopeSecret: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const key = await deriveKey(envelopeSecret, salt);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    encoder.encode(sshKey)
  );
  // Format: base64(salt) + ':' + base64(iv) + ':' + base64(ciphertext)
  const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  return `${b64(salt.buffer as ArrayBuffer)}:${b64(iv.buffer as ArrayBuffer)}:${b64(ciphertext)}`;
}

/** Decrypt an SSH private key from localStorage. */
export async function decryptKey(encrypted: string, envelopeSecret: string): Promise<string> {
  const parts = encrypted.split(':');
  if (parts.length !== 3) throw new Error('Invalid encrypted key format');

  const fromB64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const salt = fromB64(parts[0]);
  const iv = fromB64(parts[1]);
  const ciphertext = fromB64(parts[2]);

  const key = await deriveKey(envelopeSecret, salt);
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv },
    key,
    ciphertext
  );
  return new TextDecoder().decode(plaintext);
}

/** Store an encrypted SSH key in localStorage for a specific worker. */
export function storeEncryptedKey(workerId: string, encryptedKey: string): void {
  try {
    localStorage.setItem(`${STORAGE_PREFIX}${workerId}`, encryptedKey);
  } catch {
    // localStorage may be full or disabled — fail silently
  }
}

/** Retrieve an encrypted SSH key from localStorage. */
export function getEncryptedKey(workerId: string): string | null {
  try {
    return localStorage.getItem(`${STORAGE_PREFIX}${workerId}`);
  } catch {
    return null;
  }
}

/** Check if a key exists in the vault for a worker. */
export function hasStoredKey(workerId: string): boolean {
  return getEncryptedKey(workerId) !== null;
}

/** Remove a stored key for a worker. */
export function clearKey(workerId: string): void {
  try {
    localStorage.removeItem(`${STORAGE_PREFIX}${workerId}`);
  } catch {
    // ignore
  }
}

/** Remove all stored SSH keys. */
export function clearAllKeys(): void {
  try {
    const keys = Object.keys(localStorage).filter(k => k.startsWith(STORAGE_PREFIX));
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    // ignore
  }
}

/**
 * Fetch the envelope secret from the server.
 * This is a deterministic secret derived from the user's session,
 * used to encrypt/decrypt SSH keys in localStorage.
 */
export async function fetchEnvelopeSecret(): Promise<string> {
  const res = await fetch('/api/key-envelope');
  if (!res.ok) throw new Error('Failed to fetch envelope secret');
  const body = await res.json();
  return body.envelope;
}

/**
 * High-level: store an SSH key encrypted in the browser vault.
 */
export async function saveKeyToVault(workerId: string, sshKey: string): Promise<void> {
  const envelope = await fetchEnvelopeSecret();
  const encrypted = await encryptKey(sshKey, envelope);
  storeEncryptedKey(workerId, encrypted);
}

/**
 * High-level: retrieve and decrypt an SSH key from the browser vault.
 * Returns null if no key is stored or decryption fails.
 */
export async function loadKeyFromVault(workerId: string): Promise<string | null> {
  const encrypted = getEncryptedKey(workerId);
  if (!encrypted) return null;
  try {
    const envelope = await fetchEnvelopeSecret();
    return await decryptKey(encrypted, envelope);
  } catch {
    // Key may have been stored with a different session — clear it
    clearKey(workerId);
    return null;
  }
}
