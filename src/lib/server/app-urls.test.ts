/**
 * What the application page tells someone their application answers on.
 *
 * The page is where the 443-only authentication rule stops being an
 * implementation detail: an operator who switched authentication on has to be
 * able to see that it covers the browser URL and not the S3 endpoint, without
 * reading the routing code.
 */
import { describe, expect, test } from 'bun:test';
import { routeUrls, unroutedPorts } from './app-urls';
import { serializeExposedPorts } from './deploy/plan';

type Row = Parameters<typeof routeUrls>[0];

function row(over: Partial<Row> = {}): Row {
  return {
    domain: 'shop.example.com',
    routes: null,
    state: 'active',
    exposedPort: 31000,
    ...over,
  } as Row;
}

const TWO_ROUTES = JSON.stringify([
  { entryPoint: 'websecure', hostPort: 31000, containerPort: 7070 },
  { entryPoint: 'websecure-1', hostPort: 31001, containerPort: 8080 },
]);

describe('routeUrls', () => {
  test('a container from before this feature shows the one URL it always had', () => {
    expect(routeUrls(row(), false)).toEqual([
      { containerPort: 0, publicPort: 443, url: 'https://shop.example.com', authenticated: false },
    ]);
  });

  test('443 is written without a port; the rest carry theirs', () => {
    // A port suffix on the common case would make every ordinary application
    // look unusual; its absence on 1443 would make the URL unusable.
    const urls = routeUrls(row({ routes: TWO_ROUTES }), false);
    expect(urls.map((u) => u.url)).toEqual([
      'https://shop.example.com',
      'https://shop.example.com:1443',
    ]);
    expect(urls.map((u) => u.containerPort)).toEqual([7070, 8080]);
  });

  test('with authentication on, 443 is marked protected and the others are not', () => {
    const urls = routeUrls(row({ routes: TWO_ROUTES }), true);
    expect(urls.map((u) => u.authenticated)).toEqual([true, false]);
  });

  test('with authentication off, nothing claims to be protected', () => {
    const urls = routeUrls(row({ routes: TWO_ROUTES }), false);
    expect(urls.every((u) => !u.authenticated)).toBe(true);
  });

  test('a container with no hostname has no URL to show', () => {
    expect(routeUrls(row({ domain: null }), true)).toEqual([]);
  });

  test('an unreadable routes column falls back rather than rendering nothing', () => {
    expect(routeUrls(row({ routes: 'not json' }), false)).toHaveLength(1);
  });

  test('a route on an entryPoint with no known port is dropped, not guessed at', () => {
    const routes = JSON.stringify([
      { entryPoint: 'websecure', hostPort: 31000, containerPort: 80 },
      { entryPoint: 'websecure-9', hostPort: 31001, containerPort: 90 },
    ]);
    expect(routeUrls(row({ routes }), false).map((u) => u.url)).toEqual([
      'https://shop.example.com',
    ]);
  });
});

describe('unroutedPorts', () => {
  const app = (ports: number[] | null) => ({ exposedPorts: serializeExposedPorts(ports) });

  test('says nothing when the application declared nothing', () => {
    expect(unroutedPorts(app(null), [row()])).toEqual([]);
  });

  test('names a declared port that produced no route', () => {
    // Otherwise the page lists two URLs for three declared ports and never says
    // what happened to the third.
    const found = unroutedPorts(app([7070, 8080, 9999]), [row({ routes: TWO_ROUTES })]);
    expect(found.map((f) => f.port)).toEqual([9999]);
    expect(found[0].reason).toContain('not published');
  });

  test('says nothing when every declared port is routed', () => {
    expect(unroutedPorts(app([7070, 8080]), [row({ routes: TWO_ROUTES })])).toEqual([]);
  });

  test('gives the ceiling as the reason past the fifth port', () => {
    const found = unroutedPorts(app([7070, 8080, 1, 2, 3, 4]), [row({ routes: TWO_ROUTES })]);
    expect(found.find((f) => f.port === 4)!.reason).toContain('entryPoints');
  });

  test('ignores a draining generation, whose ports are about to stop working', () => {
    const draining = row({ routes: TWO_ROUTES, state: 'draining' });
    // Nothing active routes anything, so both declared ports are unrouted.
    expect(unroutedPorts(app([7070, 8080]), [draining]).map((f) => f.port)).toEqual([7070, 8080]);
  });

  test('claims nothing from a row it cannot read', () => {
    // "Not routed" derived from an unparseable row is a guess presented as a
    // finding, and the fix it suggests — edit the ports — is the wrong one.
    expect(unroutedPorts(app([7070]), [row({ routes: '{{' })])).toEqual([]);
  });
});
