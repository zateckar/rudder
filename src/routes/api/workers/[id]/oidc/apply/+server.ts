import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { executeSSHCommand } from '$lib/server/ssh';
import { decryptField, encryptField } from '$lib/server/encryption';
import { renderGlobalOidcConfig } from '$lib/server/provisioning';
import { normalizeOidcSecret, oidcCallbackHost, oidcCallbackUrl } from '$lib/server/oidc';
import { requireWorker, route } from '$lib/server/auth';

/** POST /api/workers/[id]/oidc/apply — push global-oidc.yml to the worker via SSH.
 *  Traefik watches /etc/traefik/dynamic/ and hot-reloads within seconds. */
export const POST: RequestHandler = route(async (event) => {
  const { worker } = await requireWorker(event, event.params.id!);

  if (!worker.oidcEnabled || !worker.oidcProviderUrl || !worker.oidcClientId || !worker.oidcClientSecret) {
    return json({ error: 'OIDC is not fully configured on this worker. Save a complete configuration first.' }, { status: 400 });
  }

  if (!worker.baseDomain) {
    return json({ error: 'Worker has no base domain — required for the OIDC callback URL.' }, { status: 400 });
  }

  const body = await event.request.json();
  const { sshPrivateKey } = body;
  if (!sshPrivateKey) {
    return json({ error: 'SSH private key is required' }, { status: 400 });
  }

  const clientSecret = decryptField(worker.oidcClientSecret);
  if (!clientSecret) {
    return json({ error: 'Stored client secret could not be decrypted. Re-enter it and save.' }, { status: 400 });
  }

  // Keys minted before the plugin switch were 64 hex characters, which the
  // plugin rejects. Rotate to a valid 32-character secret and persist it —
  // regenerating on every apply would invalidate every session each time.
  const { secret, rotated } = normalizeOidcSecret(decryptField(worker.oidcEncryptionKey));
  if (rotated) {
    await db.update(workers)
      .set({ oidcEncryptionKey: encryptField(secret) })
      .where(eq(workers.id, worker.id));
  }

  const oidcYml = renderGlobalOidcConfig(worker.baseDomain, {
    providerURL: worker.oidcProviderUrl,
    clientID: worker.oidcClientId,
    clientSecret,
    secret,
    callbackPath: worker.oidcCallbackPath,
  });

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

    // Deploys check this before attaching global-oidc@file to a router.
    await db.update(workers)
      .set({ oidcAppliedAt: new Date() })
      .where(eq(workers.id, worker.id));

    const callbackUrl = oidcCallbackUrl(worker.baseDomain, worker.oidcCallbackPath);

    return json({
      success: true,
      rotatedSecret: rotated,
      callbackUrl,
      callbackHost: oidcCallbackHost(worker.baseDomain),
      message:
        `OIDC configuration applied to Traefik; it takes effect within seconds. ` +
        `Make sure ${oidcCallbackHost(worker.baseDomain)} has a DNS A record pointing at this worker, ` +
        `and that ${callbackUrl} is registered as a redirect URI with your identity provider.` +
        (rotated
          ? ' The session encryption key was rotated to the 32-character format the Traefik plugin requires — existing sessions were signed out.'
          : ''),
    });
  } catch (e: any) {
    console.error('[oidc/apply] Error:', e);
    return json({ error: e.message }, { status: 500 });
  }
});
