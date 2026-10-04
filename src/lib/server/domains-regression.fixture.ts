import { expect } from 'bun:test';
import { applications, containers, teams, workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import {
  assertDomainAvailable, assertDomainsAvailable, findAppIdByDomain,
  withApplicationDeploymentDomains, withApplicationDomainWrite,
} from './domains';

// The standard test preload always allocates its own database. Point this
// child at the parent-owned disposable directory before loading the singleton.
process.env.DATABASE_URL = process.env.DOMAIN_TEST_DATABASE_URL;
const { db } = await import('$lib/db');
const { executeApplicationDeploy } = await import('./deploy');

const now = new Date();
let workerRequests = 0;
const server = Bun.serve({ port: 0, fetch: () => { workerRequests++; return new Response('{}'); } });
db.insert(teams).values([
  { id: 'alpha', name: 'Alpha', slug: 'alpha', createdAt: now, updatedAt: now },
  { id: 'beta', name: 'Beta', slug: 'beta', createdAt: now, updatedAt: now },
]).run();
for (const id of ['one', 'two']) db.insert(workers).values({
  id, name: id, hostname: 'example.test', baseDomain: 'example.test', sshUser: 'test',
  podmanApiUrl: server.url.toString(), createdAt: now, status: 'online',
}).run();
const compose = `services:
  web:
    image: nginx
    ports: ["8080:80"]
  api:
    image: nginx
    ports: ["8081:81"]
`;
const app = { id: 'shop', name: 'shop', domain: 'shop.example.test', workerId: 'one', teamId: 'alpha',
  type: 'compose' as const, manifest: compose, createdAt: now, updatedAt: now };
db.insert(applications).values(app).run();
expect(await findAppIdByDomain('SHOP-API.EXAMPLE.TEST')).toBe('shop');
expect(await assertDomainAvailable('shop-api.example.test')).toContain('already in use');
expect(await assertDomainAvailable('shop-api.example.test', 'shop')).toBeNull();
expect(await assertDomainsAvailable(['SHOP.EXAMPLE.TEST', 'SHOP-API.EXAMPLE.TEST'], 'shop')).toBeNull();

const thief = { id: 'thief', name: 'thief', domain: 'SHOP-API.EXAMPLE.TEST', workerId: 'two', teamId: 'beta',
  manifest: JSON.stringify({ image: 'nginx', ports: [{ containerPort: '80', hostPort: '', protocol: 'tcp' }] }),
  createdAt: now, updatedAt: now };
let wrote = false;
expect(await withApplicationDomainWrite(thief, async () => { wrote = true; })).toContain('already in use');
expect(wrote).toBe(false);
const secondaryThief = { ...app, id: 'second', name: 'shop', domain: 'other.example.test', workerId: 'two', teamId: 'beta' };
expect(await withApplicationDomainWrite(secondaryThief, async () => { wrote = true; })).toContain('shop-api.example.test');

// Even an old row written without the guards is refused before any worker request.
db.insert(applications).values(thief).run();
const denied = await executeApplicationDeploy(thief.id);
expect(denied.success).toBe(false);
expect(denied.statusCode).toBe(409);
expect(workerRequests).toBe(0);
db.delete(applications).where(eq(applications.id, thief.id)).run();

// Edited/malformed manifests do not release still-recorded secondary routes.
db.insert(containers).values({ id: 'old', applicationId: 'shop', workerId: 'one', containerId: 'old',
  name: 'old', image: 'nginx', status: 'running', domain: 'legacy.example.test',
  routes: JSON.stringify([{ domain: 'OLD-API.EXAMPLE.TEST' }]), createdAt: now, updatedAt: now }).run();
db.update(applications).set({ manifest: 'services: [' }).where(eq(applications.id, 'shop')).run();
expect(await findAppIdByDomain('old-api.example.test')).toBe('shop');
expect(await findAppIdByDomain('legacy.example.test')).toBe('shop');
expect(await findAppIdByDomain('shop.example.test')).toBe('shop');
expect(await withApplicationDomainWrite({ ...app, id: 'bad', manifest: 'services: [' }, async () => { wrote = true; })).not.toBeNull();
db.update(containers).set({ routes: 'malformed' }).where(eq(containers.id, 'old')).run();
expect(await findAppIdByDomain('legacy.example.test')).toBe('shop');
db.update(applications).set({ manifest: compose }).where(eq(applications.id, 'shop')).run();

// A deploy owns its domains until completion, including after a direct legacy edit.
await withApplicationDeploymentDomains('shop', async () => {
  expect(await withApplicationDomainWrite({ ...app, domain: 'changed.example.test' }, async () => {})).toContain('deployment is running');
  db.update(applications).set({ manifest: 'services: [', domain: 'changed.example.test' }).where(eq(applications.id, 'shop')).run();
  expect(await assertDomainAvailable('shop-api.example.test')).toContain('already in use');
});
expect(await assertDomainAvailable('shop-api.example.test')).toBeNull();

// Writes claiming the same hostname cannot both pass the asynchronous check.
const racing = { ...thief, id: 'race-one', name: 'race-one', domain: 'race.example.test' };
const attempts = await Promise.all([
  withApplicationDomainWrite(racing, async () => { db.insert(applications).values(racing).run(); }),
  withApplicationDomainWrite({ ...racing, id: 'race-two', name: 'race-two' }, async () => {
    db.insert(applications).values({ ...racing, id: 'race-two', name: 'race-two' }).run();
  }),
]);
expect(attempts.filter((result) => result === null)).toHaveLength(1);
expect(await assertDomainAvailable('race.example.test')).toContain('already in use');
server.stop(true);
console.log('Domain database and deployment regressions passed');
