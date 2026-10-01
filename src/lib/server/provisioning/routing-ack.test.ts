import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { routingHash } from '../routing-convergence';
import { generateProvisioningScript } from './index';

const python = Bun.which(process.platform === 'win32' ? 'python' : 'python3');
const bash = process.platform === 'win32'
  ? ['D:/UTL/Scoop/apps/git/current/bin/bash.exe', 'C:/Program Files/Git/bin/bash.exe'].find(existsSync)
  : Bun.which('bash');
const shellTest = bash && python ? test : test.skip;
const temp = mkdtempSync(join(tmpdir(), 'rudder-routing-ack-'));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const fixture = { http: { routers: { shop: { rule: 'Host(`shop.example.com`)', entryPoints: ['websecure'], service: 'shop' } },
  services: { shop: { loadBalancer: { servers: [{ url: 'http://127.0.0.1:31002' }] } } } } };

function loaded(body: any, hash: string): any {
  body = structuredClone(body);
  return { routers: { [`rudder-applied-${hash}@file`]: { status: 'enabled' },
    ...Object.fromEntries(Object.entries(body.http.routers ?? {}).map(([k, v]: any) => [k + '@file', { ...v, status: 'enabled' }])) },
    services: Object.fromEntries(Object.entries(body.http.services ?? {}).map(([k, v]: any) => [k + '@file', { ...v, status: 'enabled' }])) };
}

async function runFetch(body: any, active: any, options: { same?: boolean; previous?: any; badHash?: boolean; installFails?: boolean; ackFails?: boolean } = {}) {
  const directory = mkdtempSync(join(temp, 'run-'));
  const path = (name: string) => join(directory, name).replaceAll('\\', '/');
  const shellPath = (name: string) => path(name).replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
  const bodyText = JSON.stringify(body), hash = routingHash(bodyText);
  let posts = 0;
  const server = Bun.serve({ port: 0, fetch() { return Response.json(active); } });
  try {
    for (const name of ['etc', 'dynamic', 'state', 'bin']) mkdirSync(path(name));
    writeFileSync(path('body.json'), bodyText);
    writeFileSync(path('etc/traefik-config.env'), 'CONFIG_ENDPOINT=https://control.test/config\nCONFIG_TOKEN=token\n');
    let verifier = readFileSync(resolve('src/lib/server/provisioning/shell/scripts/rudder-routing-verify.py'), 'utf8')
      .replace('http://127.0.0.1:8083/api/rawdata', `http://127.0.0.1:${server.port}/api/rawdata`);
    writeFileSync(path('verify.py'), verifier);
    writeFileSync(path('verify'), `#!/bin/bash\n"${python!.replaceAll('\\', '/')}" "${path('verify.py')}" "$@"\n`);
    writeFileSync(path('bin/flock'), '#!/bin/bash\nexit 0\n');
    writeFileSync(path('bin/sleep'), '#!/bin/bash\nexit 0\n');
    if (options.installFails) writeFileSync(path('bin/mv'), '#!/bin/bash\nexit 1\n');
    writeFileSync(path('bin/curl'), `#!/bin/bash
post=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -X) shift; [ "$1" = POST ] && post=1 ;;
    -o) shift; output="$1" ;;
    -D) shift; headers="$1" ;;
  esac
  shift
done
if [ "$post" = 1 ]; then
  echo posted >> "${path('posts')}"
  exit ${options.ackFails ? 22 : 0}
fi
cp "${path('body.json')}" "$output"
printf 'HTTP/1.1 200 OK\\r\\nX-Rudder-Config-Hash: ${options.badHash ? 'a'.repeat(64) : hash}\\r\\n' > "$headers"
printf 200
`);
    for (const name of ['verify', 'bin/curl', 'bin/flock', 'bin/sleep', ...(options.installFails ? ['bin/mv'] : [])]) chmodSync(path(name), 0o755);
    if (options.previous) writeFileSync(path('state/routing-applied.json'), JSON.stringify(options.previous));
    if (options.same) {
      const copy = structuredClone(body);
      copy.http.routers ??= {};
      copy.http.routers[`rudder-applied-${hash}`] = { rule: `Path(\`/__rudder_applied/${hash}\`)`, entryPoints: ['routing-admin'], service: 'api@internal' };
      // Python writes the exact same compact UTF-8 JSON body.
      writeFileSync(path('dynamic/routes.yml'), JSON.stringify(copy));
    }
    const source = readFileSync(resolve('src/lib/server/provisioning/shell/scripts/rudder-traefik-config.sh'), 'utf8')
      .replaceAll('\r\n', '\n').replaceAll('/etc/rudder', shellPath('etc')).replaceAll('/etc/traefik/dynamic', shellPath('dynamic'))
      .replaceAll('/var/lib/rudder', shellPath('state')).replaceAll('/usr/local/bin/rudder-routing-verify.py', shellPath('verify'));
    writeFileSync(path('fetch.sh'), source);
    const binPath = path('bin').replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`);
    const process = Bun.spawn([bash!, '-lc', `export PATH='${binPath}':"$PATH"; bash '${path('fetch.sh')}'`], { stdout: 'pipe', stderr: 'pipe' });
    const [exitCode, stdout, stderr] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
    posts = existsSync(path('posts')) ? readFileSync(path('posts'), 'utf8').trim().split('\n').length : 0;
    return { exitCode, posts, stdout, stderr, target: existsSync(path('dynamic/routes.yml')), state: JSON.parse(readFileSync(path('state/routing-fetch.json'), 'utf8')) };
  } finally { server.stop(true); }
}

describe('worker routing installation acknowledgement', () => {
  test('provisioning binds its API only to loopback and installs the verifier', () => {
    const script = generateProvisioningScript('worker', { baseDomain: 'example.com' });
    const encoded = script.match(/echo "([^"]*)" \| base64 -d > \/etc\/traefik\/traefik\.yml/)![1];
    const config = Bun.YAML.parse(Buffer.from(encoded, 'base64').toString()) as any;
    expect(config.entryPoints['routing-admin'].address).toBe('127.0.0.1:8083');
    expect(config.api.insecure).toBeUndefined();
    expect(script).toContain('/usr/local/bin/rudder-routing-verify.py');
    expect(script).toContain('/etc/traefik/dynamic/routing-admin.yml');
  });
  shellTest('acknowledges loaded backends, including an unchanged installed body', async () => {
    const hash = routingHash(JSON.stringify(fixture));
    for (const same of [false, true]) {
      const result = await runFetch(fixture, loaded(fixture, hash), { same });
      expect(result, result.stderr).toMatchObject({ exitCode: 0, posts: 1 });
      expect(result.posts).toBe(1);
      expect(result.state.routing_fetch_ok).toBe(1);
    }
  });
  shellTest('never acknowledges old backend URLs even when router and service names match', async () => {
    const hash = routingHash(JSON.stringify(fixture));
    const stale = loaded(fixture, hash);
    stale.services['shop@file'].loadBalancer.servers[0].url = 'http://127.0.0.1:31001';
    const result = await runFetch(fixture, stale);
    expect(result.exitCode).toBe(1);
    expect(result.posts).toBe(0);
    expect(result.state.routing_fetch_detail).toBe('reload-failed');
  });
  shellTest('requires loaded empty content and removed old routes before acknowledging', async () => {
    const empty = { http: {} }, hash = routingHash(JSON.stringify(empty));
    const current = loaded(empty, hash);
    const good = await runFetch(empty, current, { previous: fixture });
    expect(good.exitCode).toBe(0);
    expect(good.posts).toBe(1);
    current.routers['shop@file'] = { status: 'enabled' };
    const bad = await runFetch(empty, current, { previous: fixture });
    expect(bad.exitCode).toBe(1);
    expect(bad.posts).toBe(0);
  });
  shellTest('failed validation/install/acknowledgement is reported as failed', async () => {
    const hash = routingHash(JSON.stringify(fixture));
    for (const options of [{ badHash: true }, { installFails: true }, { ackFails: true }]) {
      const result = await runFetch(fixture, loaded(fixture, hash), options);
      expect(result.exitCode).toBe(1);
      expect(result.state.routing_fetch_ok).toBe(0);
      if (!('ackFails' in options)) expect(result.posts).toBe(0);
    }
  });
});
