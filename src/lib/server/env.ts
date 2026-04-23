import { z } from 'zod';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { existsSync } from 'fs';

// Load environment variables for local development/build
const __dirname = dirname(fileURLToPath(import.meta.url));
const possibleEnvPaths = [
  join(__dirname, '../../../.env'),
  join(process.cwd(), '.env'),
  resolve('.env')
];

for (const envPath of possibleEnvPaths) {
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath });
    break;
  }
}

const envSchema = z.object({
  DATABASE_URL: z.string().default('./data/rudder.db'),
  SESSION_SECRET: z.string().min(32).default('development-session-secret-must-be-long-enough'),
  SESSION_MAX_AGE: z.coerce.number().default(604800),
  OIDC_GOOGLE_CLIENT_ID: z.string().optional(),
  OIDC_GOOGLE_CLIENT_SECRET: z.string().optional(),
  OIDC_GITHUB_CLIENT_ID: z.string().optional(),
  OIDC_GITHUB_CLIENT_SECRET: z.string().optional(),
  OIDC_OKTA_CLIENT_ID: z.string().optional(),
  OIDC_OKTA_CLIENT_SECRET: z.string().optional(),
  OIDC_OKTA_DOMAIN: z.string().optional(),
  OIDC_AUTH0_CLIENT_ID: z.string().optional(),
  OIDC_AUTH0_CLIENT_SECRET: z.string().optional(),
  OIDC_AUTH0_DOMAIN: z.string().optional(),
  ENCRYPTION_KEY: z.string().min(32).default('development-encryption-key-must-be-long-enough'),
  PUBLIC_URL: z.string().default('http://localhost:5173'),
});

function loadEnv() {
  const parsed = envSchema.safeParse(process.env);
  
  if (!parsed.success) {
    console.error('Invalid environment variables:', parsed.error.flatten().fieldErrors);
    throw new Error('Invalid environment configuration');
  }
  
  if (parsed.data.ENCRYPTION_KEY === 'development-encryption-key-must-be-long-enough') {
    console.warn('⚠️  Using default ENCRYPTION_KEY — set a unique key in production!');
  }
  if (parsed.data.SESSION_SECRET === 'development-session-secret-must-be-long-enough') {
    console.warn('⚠️  Using default SESSION_SECRET — set a unique key in production!');
  }

  return parsed.data;
}

export const env = loadEnv();
