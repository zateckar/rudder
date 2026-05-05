import { z } from 'zod';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// ── Auto-generate secrets ────────────────────────────────────────────────────
// SESSION_SECRET and ENCRYPTION_KEY are auto-generated on first boot and
// persisted in <data-dir>/.secrets.json so they survive container restarts.
// Explicit env vars always take priority when they are ≥ 32 characters.

function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

interface PersistedSecrets {
  sessionSecret: string;
  encryptionKey: string;
}

function loadOrCreateSecrets(): PersistedSecrets {
  // Resolve data dir the same way db/index.ts does: <cwd>/data
  const dataDir = join(process.cwd(), 'data');
  const secretsFile = join(dataDir, '.secrets.json');

  try {
    mkdirSync(dataDir, { recursive: true });

    if (existsSync(secretsFile)) {
      const stored = JSON.parse(readFileSync(secretsFile, 'utf8')) as Partial<PersistedSecrets>;
      if (stored.sessionSecret && stored.encryptionKey) {
        return stored as PersistedSecrets;
      }
    }

    const generated: PersistedSecrets = {
      sessionSecret: randomHex(32), // 64-char hex — well above the 32-char minimum
      encryptionKey: randomHex(32),
    };
    writeFileSync(secretsFile, JSON.stringify(generated, null, 2), { mode: 0o600 });
    console.log('[env] Auto-generated SESSION_SECRET and ENCRYPTION_KEY → saved to', secretsFile);
    return generated;
  } catch {
    // Filesystem not writable — use ephemeral secrets (sessions reset on restart)
    console.warn('[env] Could not persist secrets. Sessions will be reset on each restart.');
    return { sessionSecret: randomHex(32), encryptionKey: randomHex(32) };
  }
}

const auto = loadOrCreateSecrets();

/** Use provided env var if long enough; fall back to the auto-generated value. */
function resolveSecret(envVar: string | undefined, fallback: string): string {
  return envVar && envVar.length >= 32 ? envVar : fallback;
}

// ── Schema ───────────────────────────────────────────────────────────────────

const envSchema = z.object({
  DATABASE_URL: z.string().default('./data/rudder.db'),
  SESSION_SECRET: z.string().min(32),
  SESSION_MAX_AGE: z.coerce.number().default(604800),
  ENCRYPTION_KEY: z.string().min(32),
  PUBLIC_URL: z.string().default('http://localhost:5173'),
});

function loadEnv() {
  const parsed = envSchema.safeParse({
    ...process.env,
    // Inject auto-generated values so the schema always has valid secrets even
    // when the user hasn't set the env vars explicitly.
    SESSION_SECRET: resolveSecret(process.env.SESSION_SECRET, auto.sessionSecret),
    ENCRYPTION_KEY: resolveSecret(process.env.ENCRYPTION_KEY, auto.encryptionKey),
  });

  if (!parsed.success) {
    console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
    throw new Error('Invalid environment configuration');
  }

  return parsed.data;
}

export const env = loadEnv();
