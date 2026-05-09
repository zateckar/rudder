import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { executeSSHCommand } from '$lib/server/ssh';

/** POST /api/workers/[id]/oidc/apply — push global-oidc.yml to the worker via SSH.
 *  Traefik watches /etc/traefik/dynamic/ and hot-reloads within seconds. */
export const POST: RequestHandler = async ({ params, request, cookies, locals }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });
  if (locals.userRole !== 'admin') return json({ error: 'Admin access required' }, { status: 403 });

  const worker = await db.select().from(workers).where(eq(workers.id, params.id)).get();
  if (!worker) return json({ error: 'Worker not found' }, { status: 404 });

  if (!worker.oidcEnabled || !worker.oidcProviderUrl || !worker.oidcClientId || !worker.oidcClientSecret) {
    return json({ error: 'OIDC is not fully configured on this worker. Save a complete configuration first.' }, { status: 400 });
  }

  if (!worker.baseDomain) {
    return json({ error: 'Worker has no base domain — required for the OIDC callback URL.' }, { status: 400 });
  }

  const body = await request.json();
  const { sshPrivateKey } = body;
  if (!sshPrivateKey) {
    return json({ error: 'SSH private key is required' }, { status: 400 });
  }

  const baseDomain = worker.baseDomain;
  const encKey = worker.oidcEncryptionKey || '';

  // Build the global-oidc.yml content (matches the provisioning template)
  const oidcYml = `http:
  middlewares:
    global-oidc:
      plugin:
        traefikoidc:
          providerURL: "${worker.oidcProviderUrl}"
          clientID: "${worker.oidcClientId}"
          clientSecret: "${worker.oidcClientSecret}"
          sessionEncryptionKey: "${encKey}"
          callbackURL: "https://auth.${baseDomain}/oauth2/callback"
          cookieDomain: ".${baseDomain}"
          forceHTTPS: "true"
          enablePKCE: "true"
          logLevel: "info"
  routers:
    global-oidc-callback:
      rule: "Host(\`auth.${baseDomain}\`) && Path(\`/oauth2/callback\`)"
      entrypoints:
        - websecure
      tls:
        certResolver: letsencrypt
      service: noop@internal
      middlewares:
        - global-oidc
`;

  // Write via stdin → sudo tee (avoids shell quoting issues with YAML content)
  const writeCmd = 'sudo tee /etc/traefik/dynamic/global-oidc.yml > /dev/null && echo "OIDC_APPLIED"';

  try {
    const result = await executeSSHCommand(
      { host: worker.hostname, port: worker.sshPort, username: worker.sshUser, privateKey: sshPrivateKey },
      writeCmd,
      oidcYml
    );

    if (result.exitCode !== 0 || !result.stdout.includes('OIDC_APPLIED')) {
      console.error('[oidc/apply] SSH command failed:', result.stderr);
      return json({ error: 'Failed to write config on worker: ' + (result.stderr || 'unknown error') }, { status: 500 });
    }

    return json({
      success: true,
      message: 'OIDC configuration applied to Traefik. Changes take effect within seconds.',
    });
  } catch (e: any) {
    console.error('[oidc/apply] Error:', e);
    return json({ error: e.message }, { status: 500 });
  }
};
