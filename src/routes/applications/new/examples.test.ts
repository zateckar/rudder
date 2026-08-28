/**
 * The manifests the "load example" button puts in the editor.
 *
 * They are the first thing most people deploy, and they are copied from far more
 * often than they are read — an example that no longer parses, or whose comments
 * describe routing it does not produce, is worse than no example at all. So they
 * are extracted from the component source and run through the same parsers a
 * deploy uses.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCompose, validateCompose } from '$lib/server/compose';
import { parseK8sManifest, validateK8sManifest } from '$lib/server/kubernetes';
import type { PlanContext } from '$lib/server/deploy/plan';

const SOURCE = readFileSync(join(import.meta.dir, '+page.svelte'), 'utf-8');

/** The contents of a `const <name> = \`…\`` template literal in the component. */
function example(name: string): string {
  const start = SOURCE.indexOf(`const ${name} = \``);
  if (start < 0) throw new Error(`${name} not found — was it renamed?`);
  const from = start + `const ${name} = \``.length;
  const end = SOURCE.indexOf('`;', from);
  if (end < 0) throw new Error(`${name} is not a closed template literal`);
  // `\${VAR}` in the source is a literal `${VAR}` in the YAML.
  return SOURCE.slice(from, end).replace(/\\\$\{/g, '${');
}

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  let next = 31000;
  return {
    appId: 'abcdef1234567890',
    appName: 'shop',
    baseDomain: 'apps.example.com',
    allocatePort: () => next++,
    ...over,
  };
}

describe('the compose example', () => {
  const manifest = example('composeExample');

  test('passes the validation a deploy runs', () => {
    expect(validateCompose(manifest).valid).toBe(true);
  });

  test('routes the two ports its comment says it does', () => {
    const plan = parseCompose(manifest, ctx());
    const web = plan.containers.find((c) => c.key === 'web')!;

    expect(web.routes.map((r) => [r.containerPort, r.entryPoint])).toEqual([
      [8080, 'websecure'],
      [9090, 'websecure-1'],
    ]);
    // Same hostname — the point of the feature, and what the comment claims.
    expect(new Set(web.routes.map((r) => r.domain)).size).toBe(1);
  });

  test('the second service takes its own hostname instead of an extra port', () => {
    // The example makes a point of this: a separate service does not need
    // rudder.expose, and the comment would be wrong if it did.
    const plan = parseCompose(manifest, ctx());
    const api = plan.containers.find((c) => c.key === 'api')!;
    expect(api.routes).toHaveLength(1);
    expect(api.routes[0].domain).toBe('shop-api.apps.example.com');
  });

  test('rudder.expose does not survive onto the container', () => {
    const plan = parseCompose(manifest, ctx());
    for (const container of plan.containers) {
      expect(container.labels['rudder.expose']).toBeUndefined();
    }
  });
});

describe('the kubernetes example', () => {
  const manifest = example('k8sExample');

  test('passes the validation a deploy runs', () => {
    expect(validateK8sManifest(manifest).valid).toBe(true);
  });

  test('routes the two ports its annotation names', () => {
    // The annotation is read by the kubectl path, which stores it on the
    // application; the manifest parser is handed the result. Passing it here is
    // what a `kubectl apply` of this document would produce.
    const containers = parseK8sManifest(manifest, ctx({ exposedPorts: [8080, 9090] })).containers;
    const app = containers[0];
    expect(app.routes.map((r) => [r.containerPort, r.entryPoint])).toEqual([
      [8080, 'websecure'],
      [9090, 'websecure-1'],
    ]);
  });

  test('the annotation names ports the pod actually publishes', () => {
    // A typo here would show up for every user as an application unreachable on
    // a port the example told them to expect.
    const declared = manifest.match(/rudder\.dev\/expose-ports:\s*"([^"]+)"/)![1];
    const ports = declared.split(',').map((p) => Number(p.trim()));
    const published = [...manifest.matchAll(/containerPort:\s*(\d+)/g)].map((m) => Number(m[1]));
    for (const port of ports) expect(published).toContain(port);
  });

  test('the probes target a port the container declares', () => {
    const probed = [...manifest.matchAll(/httpGet:\s*\n\s*path:[^\n]*\n\s*port:\s*(\d+)/g)].map(
      (m) => Number(m[1]),
    );
    const published = [...manifest.matchAll(/containerPort:\s*(\d+)/g)].map((m) => Number(m[1]));
    expect(probed.length).toBeGreaterThan(0);
    for (const port of probed) expect(published).toContain(port);
  });
});
