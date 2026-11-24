/**
 * Enrollment and capture on a worker. The standalone pilot also uses this
 * listener as its relay. Rudder manages grants over Podman exec.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, request } from 'node:http';
import { lifetime, openLearningState, uuid } from './crowdsec-learning-state';
import { readLearningAlerts } from './crowdsec-learning-alerts';

const cookieName = '__Host-rudder-learning';
const transactionHeader = 'x-crowdsec-appsec-transaction-id';
const enrollmentPath = '/learn';
const statePath = process.env.LEARNING_STATE_PATH ?? '/state/learning.sqlite';
const alertDb = process.env.LEARNING_ALERTS_DB ?? '/alerts/crowdsec.db';
const captureKey = process.env.LEARNING_INGRESS_KEY;

if (process.argv[2] === 'manage') {
  const [, , , action, id, grantHash, codeHash] = process.argv;
  const state = openLearningState(statePath);
  if (action === 'latest') {
    console.log(JSON.stringify(state.latest()));
    process.exit(0);
  }
  if (!id || !uuid.test(id)) throw new Error('Invalid session ID');
  switch (action) {
    case 'create':
      console.log(JSON.stringify(state.create(id, grantHash ?? '', codeHash ?? '')));
      break;
    case 'read':
      console.log(JSON.stringify(state.read(id)));
      break;
    case 'report': {
      const session = state.read(id);
      const alerts = session ? readLearningAlerts(alertDb, session.requests.map((row) => row.id),
        new URL(process.env.LEARNING_ORIGIN!).hostname) : [];
      console.log(JSON.stringify(session && { session, alerts }));
      break;
    }
    case 'revoke':
      console.log(JSON.stringify(state.revoke(id)));
      break;
    default:
      throw new Error('Invalid session operation');
  }
  process.exit(0);
}

const key = process.env.LEARNING_KEY;
const origin = process.env.LEARNING_ORIGIN;
if (!key || key.length < 32 || !origin) {
  throw new Error('Configure the pilot origin and signing key.');
}
const expectedOrigin = new URL(origin);
if (expectedOrigin.protocol !== 'https:' || expectedOrigin.origin !== origin) {
  throw new Error('The lab origin must be an exact HTTPS origin.');
}

const signingKey = key;
const state = openLearningState(statePath);
const traefikPort = Number(process.env.LEARNING_TRAEFIK_PORT ?? '8080');
const listenPort = Number(process.env.LEARNING_PORT ?? '8079');
const listenHost = process.env.LEARNING_LISTEN_HOST ?? '127.0.0.1';
const enrollPage = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CrowdSec learning session</title>
<h1>CrowdSec learning session</h1>
<form>
  <label>One-time code <input maxlength="6" autocapitalize="characters" spellcheck="false" required></label>
  <button>Enroll this browser</button>
</form>
<p role="status"></p>
<script>
const code = location.hash.slice(1);
if (code) history.replaceState(null, '', location.pathname);
const form = document.querySelector('form');
const input = document.querySelector('input');
const button = document.querySelector('button');
const status = document.querySelector('[role=status]');
input.disabled = Boolean(code);
input.closest('label').hidden = Boolean(code);
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  button.disabled = true;
  try {
    const enrolled = await fetch(location.pathname, {
      method: 'POST', headers: { 'X-Rudder-Lab-Grant': code || input.value.trim().toUpperCase() }
    });
    if (!enrolled.ok) {
      status.textContent = 'The enrollment code was rejected.';
      button.disabled = false;
      return;
    }
    location.replace(${JSON.stringify(captureKey ? '/' : '/crowdsec-test-NtktlJHV4TfBSK3wvlhiOBnl')});
  } catch {
    status.textContent = 'Enrollment could not be completed.';
  }
});
</script>`;

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function signature(payload: string): string {
  return createHmac('sha256', signingKey)
    .update(expectedOrigin.origin)
    .update('\0')
    .update(payload)
    .digest('base64url');
}

function signedRequestId(id: string, secret: string): string {
  return `${id}.${createHmac('sha256', secret).update(id).digest('hex')}`;
}

function sessionId(value: string | undefined): string | undefined {
  if (!value) return;
  const [id, expiry, mac, extra] = value.split('.');
  if (!id || !uuid.test(id) || !expiry || !mac || extra !== undefined) return;
  if (!equal(mac, signature(`${id}.${expiry}`))) return;
  if (!/^\d+$/.test(expiry) || Number(expiry) <= Math.floor(Date.now() / 1000)) return;
  return id;
}

function splitCookies(cookie: string | undefined) {
  const credentials: string[] = [];
  const applicationCookies: string[] = [];
  for (const part of cookie?.split(';') ?? []) {
    const match = /^\s*__Host-rudder-learning\s*=\s*(.*)$/.exec(part);
    if (match) credentials.push(match[1].trimEnd());
    else applicationCookies.push(part);
  }
  return {
    credential: credentials.length === 1 ? credentials[0] : undefined,
    forwarded: credentials.length ? applicationCookies.join(';').trimStart() : cookie,
  };
}

const server = createServer((incoming, response) => {
  if (incoming.headers.host !== expectedOrigin.host) {
    response.writeHead(421).end();
    return;
  }

  if (captureKey && incoming.url === '/_capture') {
    const key = incoming.headers['x-rudder-ingress-key'];
    if (incoming.method !== 'POST' || typeof key !== 'string' || !equal(key, captureKey)) {
      response.writeHead(403).end();
      return;
    }
    const credential = incoming.headers['x-rudder-learning-cookie'];
    const session = typeof credential === 'string' ? sessionId(credential) : undefined;
    if (!session) {
      response.writeHead(204).end();
      return;
    }
    try {
      const id = `rudder-${randomUUID()}`;
      if (state.record(id, session, Date.now(), 0).changes) {
        response.setHeader(transactionHeader, signedRequestId(id, captureKey));
      }
      response.writeHead(204).end();
    } catch {
      response.writeHead(503).end();
    }
    return;
  }

  if (incoming.url === enrollmentPath) {
    if (incoming.method === 'GET') {
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Type': 'text/html; charset=utf-8',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'",
      }).end(enrollPage);
      return;
    }
    const supplied = incoming.headers['x-rudder-lab-grant'];
    if (
      incoming.method !== 'POST' || incoming.headers.origin !== origin ||
      typeof supplied !== 'string' || !/^(?:[\w-]{43}|[0-9A-V]{6})$/.test(supplied)
    ) {
      response.writeHead(403, { 'Cache-Control': 'no-store' }).end();
      return;
    }
    let enrollment: ReturnType<typeof state.redeem>;
    try {
      enrollment = state.redeem(supplied);
    } catch {
      response.writeHead(503, { 'Cache-Control': 'no-store' }).end();
      return;
    }
    if (!enrollment) {
      response.writeHead(403, { 'Cache-Control': 'no-store' }).end();
      return;
    }
    const payload = `${enrollment.id}.${Math.floor(enrollment.expiresAt / 1000)}`;
    response.writeHead(204, {
      'Cache-Control': 'no-store',
      'Set-Cookie': `${cookieName}=${payload}.${signature(payload)}; Path=/; Max-Age=${lifetime}; Secure; HttpOnly; SameSite=Strict`,
    }).end();
    return;
  }

  if (captureKey) {
    response.writeHead(404).end();
    return;
  }

  const headers = { ...incoming.headers };
  const { credential, forwarded } = splitCookies(headers.cookie);
  if (forwarded) headers.cookie = forwarded;
  else delete headers.cookie;
  delete headers['x-rudder-lab-grant'];

  // This is an AppSec transport header, stripped by CrowdSec before CRS.
  // Replace any client-supplied value. Traefik also removes it after the
  // bouncer middleware and before forwarding the request upstream.
  delete headers[transactionHeader];
  const at = Date.now();
  const session = sessionId(credential);
  let transactionId: string | undefined;
  if (session) {
    try {
      if (state.isActive(session, at)) {
        transactionId = `rudder-${randomUUID()}`;
        headers[transactionHeader] = signedRequestId(transactionId, signingKey);
      }
    } catch {
      // A capture outage must leave ordinary enforcement in the request path.
    }
  }

  const upstream = request({
    hostname: '127.0.0.1',
    port: traefikPort,
    path: incoming.url,
    method: incoming.method,
    headers,
  }, (result) => {
    response.writeHead(result.statusCode ?? 502, result.headers);
    result.pipe(response);
    if (session && transactionId && result.statusCode) {
      try {
        state.record(transactionId, session, at, result.statusCode);
      } catch {
        // The response and its enforcement outcome are independent of capture.
        console.error('Could not record a learning request');
      }
    }
  });
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502);
    response.end();
  });
  response.on('close', () => upstream.destroy());
  incoming.pipe(upstream);
});

server.listen(listenPort, listenHost);
