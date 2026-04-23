import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuid } from 'uuid';
import { hash } from 'bcrypt';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbDir = join(__dirname, '../data');
const dbPath = join(dbDir, 'rudder.db');

if (!existsSync(dbDir)) {
  mkdirSync(dbDir, { recursive: true });
}

const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
const db = drizzle(sqlite);

console.log('Running migrations...');
migrate(db, { migrationsFolder: './drizzle' });
console.log('Migrations complete.');

console.log('Seeding admin user...');

if (!process.env.ADMIN_PASSWORD) {
  if (process.env.NODE_ENV === 'production') {
    console.error(
      'ERROR: ADMIN_PASSWORD environment variable is not set. ' +
      'Refusing to create admin account with default password in production. ' +
      'Set ADMIN_PASSWORD and re-run.'
    );
    process.exit(1);
  } else {
    console.warn(
      'WARNING: ADMIN_PASSWORD is not set. ' +
      'Using insecure default password "admin123". ' +
      'Do NOT use this in production.'
    );
  }
}

const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';
const hashedPassword = await hash(adminPassword, 12);

const adminId = uuid();
sqlite.prepare(`
  INSERT OR IGNORE INTO users (id, username, email, password_hash, full_name, role, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  adminId,
  'admin',
  'admin@localhost',
  hashedPassword,
  'Administrator',
  'admin',
  Date.now(),
  Date.now()
);

if (process.env.ADMIN_PASSWORD) {
  console.log('Admin user created. Username: admin (password set via ADMIN_PASSWORD env var).');
} else {
  console.log('Admin user created. Username: admin, Password: admin123 (INSECURE DEFAULT).');
}
console.log('Database initialized successfully.');
