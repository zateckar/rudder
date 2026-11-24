import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, openLearningState } from '../../../scripts/crowdsec-learning-state';
import { joinLearningAlerts, openLearningPilot } from './crowdsec-learning';
import type { PodmanClient } from './podman';

test('a worker grant is redeemed once, expires or can be revoked, and records only enrolled traffic', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rudder-learning-'));
  const state = openLearningState(join(directory, 'test.sqlite'));
  try {
    const id = randomUUID();
    const grant = 'x'.repeat(43);
    const code = 'ABCDEF';
    expect(state.create(id, digest(grant), digest(code))).not.toBeNull();
    expect(state.create(randomUUID(), digest(grant), digest(code))).toBeNull();
    expect(state.isActive(id, Date.now())).toBe(false);
    for (let attempt = 0; attempt < 10; attempt++) expect(state.redeem('000000')).toBeUndefined();
    expect(state.redeem(code)).toBeUndefined();
    const redeemed = state.redeem(grant)!;
    expect(redeemed.id).toBe(id);
    expect(state.redeem(grant)).toBeUndefined();
    expect(state.isActive(id, redeemed.expiresAt)).toBe(false);
    const request = `rudder-${randomUUID()}`;
    state.record(request, id, Date.now(), 403);
    expect(state.read(id)?.requests.map((row) => [row.id, row.status])).toEqual([[request, 403]]);
    expect(state.revoke(id)).toBe(true);
    expect(state.isActive(id, Date.now())).toBe(false);
    state.record(`rudder-${randomUUID()}`, id, Date.now(), 200);
    expect(state.read(id)?.requests).toHaveLength(1);
  } finally {
    state.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('only valid, exact and unambiguous stored alert IDs join to the active request window', () => {
  const at = Date.now();
  const id = `rudder-${randomUUID()}`;
  const other = `rudder-${randomUUID()}`;
  const session = {
    id: randomUUID(), enrolledAt: at - 100, expiresAt: at + 10_000, revokedAt: null,
    requests: [{ id, at, status: 403 }],
  };
  const field = (value: string) => ({ key: 'rudder_request_id', value });
  const alert = (number: number, meta: unknown[], timestamp = at) => ({
    id: number, scenario: 'appsec-probe', created_at: new Date(timestamp).toISOString(),
    source: { ip: '192.0.2.1' }, meta,
  });
  const result = joinLearningAlerts(session, [
    {
      ...alert(1, [field(id)]),
      events: [
        { meta: [
          { key: 'rule_name', value: 'crowdsecurity/appsec-generic-test' },
          { key: 'rule_name', value: 'native_rule:901340' },
          { key: 'rule_name', value: 'native_rule:901340' },
          { key: 'rule_name', value: 'request data' },
          { key: 'uri', value: '/unredacted' },
        ] },
      ],
    },
    alert(2, [field(JSON.stringify([id]))]),
    alert(3, [field(other)]),
    alert(4, [field(id), field(other)]),
    alert(5, [field(JSON.stringify([id, other]))]),
    alert(6, [field(id)], at - 5000),
    alert(7, [field('malformed')]),
  ]);
  expect(result.requests[0].alerts).toEqual([
    { id: 1, scenario: 'appsec-probe', rules: ['crowdsecurity/appsec-generic-test', 'native_rule:901340'] },
    { id: 2, scenario: 'appsec-probe' },
  ]);
});

test('a learning pilot is scoped to the installed application and a shared registered origin', async () => {
  const origin = 'https://app.example.test';
  const client = {
    listContainers: async () => ['gateway', 'engine'].map((role) => ({
      Id: role,
      Names: [`/rudder-learning-pilot-${role}`],
      Labels: {
        'io.rudder.crowdsec-learning': role,
        'io.rudder.crowdsec-learning.origin': origin,
        'io.rudder.crowdsec-learning.application': 'installed-app',
      },
    })),
  } as unknown as PodmanClient;
  expect(await openLearningPilot(client, 'unsigned-app', ['app.example.test'])).toBeNull();
  expect(await openLearningPilot(client, 'installed-app', ['separate.example.test'])).toBeNull();
  expect(await openLearningPilot(client, 'installed-app', ['APP.example.test'])).not.toBeNull();
});
