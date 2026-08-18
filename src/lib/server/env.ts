import { z } from 'zod';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { resolveDataDir } from './paths';

// ── Auto-generate secrets ────────────────────────────────────────────────────
// ENCRYPTION_KEY is auto-generated on first boot and persisted in
// <data-dir>/.secrets.json so it survives container restarts.  An explicit env
// var always takes priority.
//
// Losing this key makes every stored secret permanently undecryptable, so the
// failure modes below are loud rather than silent.

function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface PersistedSecrets {
  encryptionKey: string;
}

const isProduction = process.env.NODE_ENV === 'production';

function loadOrCreateSecrets(): PersistedSecrets {
  // Follows DATABASE_URL so the key lives on the same volume as the data it
  // protects.
  const dataDir = resolveDataDir();
  const secretsFile = join(dataDir, '.secrets.json');

  try {
    mkdirSync(dataDir, { recursive: true });

    if (existsSync(secretsFile)) {
      const stored = JSON.parse(readFileSync(secretsFile, 'utf8')) as Partial<PersistedSecrets>;
      if (stored.encryptionKey) {
        return { encryptionKey: stored.encryptionKey };
      }
    }

    const generated: PersistedSecrets = { encryptionKey: randomHex(32) };
    writeFileSync(secretsFile, JSON.stringify(generated, null, 2), { mode: 0o600 });
    console.log('[env] Auto-generated ENCRYPTION_KEY → saved to', secretsFile);
    return generated;
  } catch (e) {
    // An ephemeral key silently orphans every secret written during this run,
    // so in production this is fatal rather than a warning.
    const message =
      `[env] Could not persist ENCRYPTION_KEY to ${secretsFile}: ${(e as Error).message}. ` +
      `Stored secrets would become unreadable after a restart.`;
    if (isProduction) {
      console.error(message);
      throw new Error(
        'Refusing to start: ENCRYPTION_KEY cannot be persisted. Make the data directory ' +
          'writable, or set ENCRYPTION_KEY explicitly.',
      );
    }
    console.warn(`${message} Continuing with an ephemeral key (development only).`);
    return { encryptionKey: randomHex(32) };
  }
}

const auto = loadOrCreateSecrets();

/**
 * Use the provided env var if it meets the length requirement.  A too-short
 * value is rejected outright — silently falling back to the generated key made
 * a misconfigured ENCRYPTION_KEY look like it had been applied.
 */
function resolveSecret(name: string, envVar: string | undefined, fallback: string): string {
  if (envVar === undefined || envVar === '') return fallback;
  if (envVar.length < 32) {
    throw new Error(
      `${name} must be at least 32 characters (got ${envVar.length}). ` +
        `Unset it to use the auto-generated value instead.`,
    );
  }
  return envVar;
}

// ── Schema ───────────────────────────────────────────────────────────────────

const envSchema = z.object({
  DATABASE_URL: z.string().default('./data/rudder.db'),
  SESSION_MAX_AGE: z.coerce.number().default(604800),
  ENCRYPTION_KEY: z.string().min(32),
  PUBLIC_URL: z.string().default('http://localhost:5173'),
  /**
   * Comma-separated absolute host directories that applications may bind-mount.
   * Empty (the default) disables host path mounts entirely; named volumes are
   * unaffected.  See src/lib/server/mounts.ts for the full policy.
   */
  ALLOWED_HOST_MOUNT_PREFIXES: z.string().default(''),
  /**
   * Allow talking to a worker's Podman API without mTLS, *and* stop verifying the
   * certificate the worker presents.  The API is root-equivalent on the worker
   * and an unverified server certificate means anything on the network path can
   * answer for it, so this is for local development only.
   */
  ALLOW_INSECURE_PODMAN: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  OIDC_PROVIDER_URL: z.string().url().optional(),
  OIDC_CLIENT_ID: z.string().optional(),
  OIDC_CLIENT_SECRET: z.string().optional(),
});

function loadEnv() {
  const parsed = envSchema.safeParse({
    ...process.env,
    // Inject the auto-generated value so the schema always has a valid key even
    // when the user hasn't set the env var explicitly.
    ENCRYPTION_KEY: resolveSecret('ENCRYPTION_KEY', process.env.ENCRYPTION_KEY, auto.encryptionKey),
  });

  if (!parsed.success) {
    console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
    throw new Error('Invalid environment configuration');
  }

  return parsed.data;
}

export const env = loadEnv();
