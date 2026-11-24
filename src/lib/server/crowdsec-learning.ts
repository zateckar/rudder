import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PodmanClient } from './podman';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
export const sessionIdPattern = new RegExp(`^${uuid}$`);
const requestIdPattern = new RegExp(`^rudder-${uuid}$`);
const roleLabel = 'io.rudder.crowdsec-learning';
const originLabel = 'io.rudder.crowdsec-learning.origin';
const applicationLabel = 'io.rudder.crowdsec-learning.application';
const alertKey = 'rudder_request_id';

export interface LearningSession {
  id: string;
  enrolledAt: number | null;
  expiresAt: number;
  revokedAt: number | null;
  requests: { id: string; at: number; status: number | null }[];
}

export interface LearningAlert {
  id: number;
  scenario: string;
  rules?: string[];
}

export interface LearningEnrollment {
  id: string;
  link: string;
  enrollmentPage: string;
  code: string;
  expiresAt: number;
}

export async function openLearningPilot(client: PodmanClient, applicationId: string, hosts: string[]) {
  const origins = new Set(hosts.filter((host) => /^[a-z0-9.-]+$/i.test(host))
    .map((host) => `https://${host.toLowerCase()}`));
  const containers = await client.listContainers(false);
  const gateway = containers.filter((container) =>
    container.Labels?.[roleLabel] === 'gateway' && container.Labels[applicationLabel] === applicationId &&
    origins.has(container.Labels[originLabel]) &&
    container.Names?.some((name) => {
      const normalized = name.replace(/^\//, '');
      return normalized === 'rudder-learning-pilot-gateway' ||
        normalized === `rudder-learning-ingress-${applicationId}`;
    })
  );
  if (gateway.length !== 1) return null;
  const origin = gateway[0].Labels[originLabel];

  async function manage<T>(action: string, ...args: string[]): Promise<T> {
    const result = await client.execContainerHttp(gateway[0].Id,
      ['bun', '/lab/gateway.ts', 'manage', action, ...args]);
    if (result.exitCodeKnown === false || result.exitCode !== 0) throw new Error('Learning gateway command failed');
    return JSON.parse(result.stdout) as T;
  }

  return {
    latest: () => manage<string | null>('latest'),
    async create(): Promise<LearningEnrollment | null> {
      const id = randomUUID();
      const token = randomBytes(32).toString('base64url');
      const code = (randomBytes(4).readUInt32BE() >>> 2).toString(32).padStart(6, '0').toUpperCase();
      const digest = (value: string) => createHash('sha256').update(value).digest('hex');
      const created = await manage<{ expiresAt: number } | null>('create', id, digest(token), digest(code));
      if (!created) return null;
      const enrollmentPage = `${origin}/learn`;
      return { id, link: `${enrollmentPage}#${token}`, enrollmentPage, code, expiresAt: created.expiresAt };
    },
    revoke: (id: string) => manage<boolean>('revoke', id),
    async read(id: string) {
      const report = await manage<{ session: LearningSession; alerts: unknown[] } | null>('report', id);
      return report && joinLearningAlerts(report.session, report.alerts);
    },
  };
}

function contextId(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  if (requestIdPattern.test(value)) return value;
  try {
    const values: unknown = JSON.parse(value);
    if (Array.isArray(values) && values.length === 1 &&
      typeof values[0] === 'string' && requestIdPattern.test(values[0])) return values[0];
  } catch {
    // Unrecognized metadata is never a correlation key.
  }
}

export function joinLearningAlerts(session: LearningSession, stored: unknown[]) {
  const requests = new Map(session.requests.map((request) => [request.id, { ...request, alerts: [] as LearningAlert[] }]));
  for (const raw of stored) {
    if (typeof raw !== 'object' || raw === null) continue;
    const alert = raw as { id?: unknown; scenario?: unknown; created_at?: unknown; meta?: unknown; events?: unknown };
    if (typeof alert.id !== 'number' || !Number.isSafeInteger(alert.id) || typeof alert.scenario !== 'string' ||
      typeof alert.created_at !== 'string' || !Array.isArray(alert.meta)) continue;
    const keys = alert.meta.filter((item) => item?.key === alertKey);
    if (keys.length !== 1) continue;
    const id = contextId(keys[0].value);
    const request = id ? requests.get(id) : undefined;
    const at = Date.parse(alert.created_at);
    if (!request || session.enrolledAt === null || !Number.isFinite(at) ||
      at < session.enrolledAt - 1000 || at < request.at - 1000 || at > session.expiresAt + 60_000) continue;
    const rules = new Set<string>();
    for (const event of Array.isArray(alert.events) ? alert.events : []) {
      for (const item of Array.isArray(event?.meta) ? event.meta : []) {
        if (item?.key === 'rule_name' && typeof item.value === 'string' &&
          /^(?:native_rule:[0-9]+|[a-z0-9-]+\/[a-z0-9-]+)$/.test(item.value)) rules.add(item.value);
      }
    }
    request.alerts.push({ id: alert.id, scenario: alert.scenario, ...(rules.size ? { rules: [...rules] } : {}) });
  }
  return { ...session, requests: [...requests.values()] };
}
