import { test, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('domain reservations protect planned, live, malformed, and concurrent applications', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rudder-domains-'));
  try {
    const child = Bun.spawn([process.execPath, '--preload', './test/preload.ts', join(import.meta.dir, 'domains-regression.fixture.ts')], {
      cwd: process.cwd(), env: { ...process.env, DOMAIN_TEST_DATABASE_URL: join(directory, 'rudder.db'), TRAEFIK_BASE_DOMAIN: '' },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout).toContain('Domain database and deployment regressions passed');
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 30_000);
