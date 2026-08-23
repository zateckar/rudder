import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { executeSSHCommand, testSSHConnection } from '$lib/server/ssh';
import { generateProvisioningScript, type ProvisioningOptions } from '$lib/server/provisioning';
import { routeGroupsForWorker, tokenForwardingApps } from '$lib/server/traefik-config';
import { env } from '$lib/server/env';
import { randomBytes } from 'crypto';
import { withLock, LockError } from '$lib/server/locks';
import type { RequestHandler } from './$types';
import { parseJsonBody, schemas } from '$lib/server/validation';
import { requireAdminUser, route } from '$lib/server/auth';
import { encryptField, decryptField } from '$lib/server/encryption';
import { normalizeOidcSecret } from '$lib/server/oidc';
import { redactProvisioningOutput } from '$lib/server/redaction';
import {
  checkPublicUrlReachable,
  configEndpointUrl,
  generateConfigToken,
} from '$lib/server/worker-config-endpoint';

/** Parse mTLS certificates and bouncer key from provisioning script stdout */
function parseCertsFromOutput(stdout: string): {
  caCert: string | null;
  clientCert: string | null;
  clientKey: string | null;
  bouncerKey: string | null;
} {
  const result = { caCert: null as string | null, clientCert: null as string | null, clientKey: null as string | null, bouncerKey: null as string | null };

  try {
    const caMatch = stdout.match(/^CA_CERT_B64=(.+)$/m);
    const clientCertMatch = stdout.match(/^CLIENT_CERT_B64=(.+)$/m);
    const clientKeyMatch = stdout.match(/^CLIENT_KEY_B64=(.+)$/m);
    const bouncerKeyMatch = stdout.match(/^BOUNCER_KEY=(.+)$/m);

    if (caMatch?.[1]) {
      result.caCert = Buffer.from(caMatch[1].trim(), 'base64').toString('utf-8');
    }
    if (clientCertMatch?.[1]) {
      result.clientCert = Buffer.from(clientCertMatch[1].trim(), 'base64').toString('utf-8');
    }
    if (clientKeyMatch?.[1]) {
      result.clientKey = Buffer.from(clientKeyMatch[1].trim(), 'base64').toString('utf-8');
    }
    if (bouncerKeyMatch?.[1]) {
      result.bouncerKey = bouncerKeyMatch[1].trim();
    }
  } catch (e) {
    console.error('Failed to parse certs from provisioning output:', e);
  }

  return result;
}

/** Outcome of the synchronous routing fetch provisioning performs, if it ran. */
interface RoutingFetchState {
  code: number;
  ok: boolean;
  detail: string;
}

/**
 * Read the `ROUTING_FETCH_STATE=` marker the provisioning script emits in http
 * routing mode. Absent for labels-mode workers and for workers provisioned by
 * an older script, both of which are "nothing to report" rather than a failure.
 */
function parseRoutingFetchState(stdout: string): RoutingFetchState | null {
  const match = stdout.match(/^ROUTING_FETCH_STATE=(.+)$/m);
  if (!match?.[1]) return null;
  try {
    const parsed = JSON.parse(match[1].trim());
    return {
      code: Number(parsed.routing_fetch_code) || 0,
      ok: Number(parsed.routing_fetch_ok) === 1,
      detail: typeof parsed.routing_fetch_detail === 'string' ? parsed.routing_fetch_detail : 'unknown',
    };
  } catch {
    return null;
  }
}

/**
 * Say what a failed routing fetch means and what to do about it.
 *
 * Each of these needs a different fix and they are indistinguishable from the
 * control plane, which is the whole reason the worker reports the status.
 */
function describeRoutingFetchFailure(state: RoutingFetchState, endpoint: string): string {
  const prefix = 'Provisioned, but the worker could not fetch its routing configuration';

  if (state.detail === 'transport' || state.code === 0) {
    return (
      `${prefix}: it could not reach ${endpoint} at all. Check DNS, egress from the worker, and that the ` +
      `control plane's TLS certificate is trusted there. Applications stay on their existing routes until ` +
      `the fetch succeeds — do not redeploy them yet.`
    );
  }
  // Checked before the plain 401 branch: both are 401, and this one is not a
  // Rudder problem at all — the request never reached it.
  if (state.detail === 'proxy-auth') {
    return (
      `${prefix}: ${endpoint} is behind something that demands its own credentials, which answered ` +
      `${state.code} before the request reached Rudder. Either exempt the routing endpoint at that proxy — it ` +
      `carries a per-worker bearer token of its own and needs no other authentication — or set the proxy's ` +
      `Basic credentials under Control-plane Basic authentication in the worker's Settings tab and provision ` +
      `again.`
    );
  }
  if (state.code === 401) {
    return (
      `${prefix}: the control plane answered 401. The worker's token does not match the stored one. ` +
      `Re-provision to reissue it, and do not switch the routing mode afterwards — that used to rotate the ` +
      `token without delivering it. Applications stay on their existing routes until the fetch succeeds.`
    );
  }
  if (state.code === 409) {
    return (
      `${prefix}: the control plane answered 409, meaning it has this worker in labels routing mode. ` +
      `Switch it to control-plane routing and provision again.`
    );
  }
  if (state.detail === 'not-a-document') {
    return (
      `${prefix}: ${endpoint} answered ${state.code} with something that is not a routing document — ` +
      `usually a login redirect or a proxy error page in front of the control plane. The endpoint must be ` +
      `reachable without authentication other than the bearer token.`
    );
  }
  return (
    `${prefix}: the control plane answered ${state.code} (${state.detail}). Applications stay on their ` +
    `existing routes until the fetch succeeds.`
  );
}

export const POST: RequestHandler = route(async (event) => {
  const userId = requireAdminUser(event).user.id;

  const { workerId, sshPrivateKey: adHocKey, applyUpdates } = await parseJsonBody(
    event.request,
    schemas.provisionWorker,
  );

  try {
    return await withLock(
      `worker:${workerId}:provision`,
      { operation: 'worker-provisioning', holder: userId },
      async () => {
        const worker = await db.select().from(workers).where(eq(workers.id, workerId)).get();
        
        if (!worker) {
          return json({ error: 'Worker not found' }, { status: 404 });
        }

        if (!adHocKey) {
          return json({ error: 'No SSH key provided. Paste the SSH private key in the provisioning dialog.' }, { status: 400 });
        }

        if (worker.status === 'provisioning') {
          return json({ error: 'Worker is already being provisioned' }, { status: 409 });
        }

        // A worker with no base domain cannot be given an mTLS-protected route
        // to its Podman API: Traefik binds tls.options to a router's SNI, so
        // there is no hostname to require a client certificate for. Provisioning
        // one used to install a catch-all route instead, publishing the
        // root-equivalent Podman API on 443 with no client-certificate check —
        // and then reporting "secured with mTLS". Refuse instead: the control
        // plane would have no way to reach the API afterwards either.
        if (!worker.baseDomain) {
          return json(
            {
              error:
                `Worker "${worker.name}" has no base domain. Set one on the worker before ` +
                `provisioning — it is what gives the Podman API an mTLS-protected hostname ` +
                `(podman-api.<baseDomain>). Without it the API can only be reached from the ` +
                `worker itself, and Rudder could not manage the worker at all.`,
            },
            { status: 400 },
          );
        }

        const privateKey = adHocKey;

        // No temp key file is written here. `testSSHConnection` and
        // `executeSSHCommand` each create and delete their own, scoped to the
        // one invocation; the copy this used to make was never passed to
        // anything and simply left the worker's SSH private key in tmpdir for
        // the whole run — which, with the 900 s stdin timeout on the
        // provisioning command, is up to fifteen minutes.
        try {
          const canConnect = await testSSHConnection({
            host: worker.hostname,
            port: worker.sshPort,
            username: worker.sshUser,
            privateKey,
          });

          console.log('SSH connection test result:', canConnect);

          if (!canConnect) {
            await db.update(workers).set({ status: 'error' }).where(eq(workers.id, workerId));
            return json({ error: 'SSH connection failed' }, { status: 500 });
          }

          const bouncerKey =
            decryptField(worker.crowdsecBouncerKey) || randomBytes(20).toString('hex');

          // Only ship an OIDC middleware when it can actually be built: the
          // plugin needs a base domain for the shared callback host and a
          // 32-character secret, and a middleware that fails to build makes
          // Traefik discard the whole dynamic file.
          const oidcComplete = !!(
            worker.oidcEnabled &&
            worker.oidcProviderUrl &&
            worker.oidcClientId &&
            worker.oidcClientSecret &&
            worker.baseDomain
          );
          const oidcClientSecret = oidcComplete ? decryptField(worker.oidcClientSecret) : null;
          const oidcSecret = oidcComplete
            ? normalizeOidcSecret(decryptField(worker.oidcEncryptionKey))
            : null;

          if (oidcSecret?.rotated) {
            await db.update(workers)
              .set({ oidcEncryptionKey: encryptField(oidcSecret.secret) })
              .where(eq(workers.id, worker.id));
          }

          const workerOidcConfig = (oidcComplete && oidcClientSecret && oidcSecret)
            ? {
                providerURL: worker.oidcProviderUrl!,
                clientID: worker.oidcClientId!,
                clientSecret: oidcClientSecret,
                secret: oidcSecret.secret,
                callbackPath: worker.oidcCallbackPath,
              }
            : undefined;

          // Workers in http routing mode fetch their routes from the control
          // plane, so provisioning has to plant an endpoint and a credential.
          // Refuse rather than provision a worker that will quietly serve
          // nothing because it cannot reach us.
          let routingConfig: ProvisioningOptions['routingConfig'];
          if (worker.routingMode === 'http') {
            const unreachable = checkPublicUrlReachable();
            if (unreachable) {
              await db.update(workers).set({ status: 'error' }).where(eq(workers.id, workerId));
              return json({ error: unreachable }, { status: 400 });
            }
          }

          // Minted for every worker, not only http-mode ones.
          //
          // It started life as the bearer credential for the routing-config
          // endpoint, which only http-mode workers fetch. But it is now also what
          // /api/workers/register uses to tell which worker is calling, and that
          // endpoint serves both modes — issuing it conditionally left every
          // worker in the default `labels` mode unable to self-register, with
          // re-provisioning no help because it would not mint one either.
          //
          // Re-provisioning rotates it: the old one may be on a host that is
          // being rebuilt, and nothing else depends on its value.
          const workerToken = generateConfigToken();
          await db.update(workers)
            .set({ configToken: encryptField(workerToken) })
            .where(eq(workers.id, workerId));

          if (worker.routingMode === 'http') {
            routingConfig = {
              endpoint: configEndpointUrl(worker.id, env.PUBLIC_URL),
              token: workerToken,
              // Credentials for a proxy in front of the control plane, if the
              // deployment has one. Read fresh from the database on every run,
              // so changing them in the UI and re-provisioning is all it takes.
              basicUser: worker.configBasicUser,
              basicPassword: decryptField(worker.configBasicPassword),
            };
          }

          // The file this script writes is what `oidcAppliedAt` below claims is
          // in place, so it has to carry the per-application token middlewares
          // too — a re-provision that dropped them would leave those routers
          // naming a middleware Traefik does not have.
          const oidcTokenApps = workerOidcConfig
            ? tokenForwardingApps(await routeGroupsForWorker(worker.id), true)
            : [];

          const script = generateProvisioningScript(worker.name, {
            baseDomain: worker.baseDomain || undefined,
            bouncerKey,
            oidcConfig: workerOidcConfig,
            oidcTokenApps,
            sshPort: worker.sshPort,
            routingConfig,
            workerToken,
            applyUpdates,
          });
          
          const result = await executeSSHCommand(
            {
              host: worker.hostname,
              port: worker.sshPort,
              username: worker.sshUser,
              privateKey,
            },
            `sudo bash -s`,
            script
          );

          // The script echoes the mTLS client key and the bouncer key on stdout;
          // logging that tail verbatim wrote a worker's root-equivalent private
          // key into the application log on every provisioning run.
          console.log(
            'SSH exec result - exitCode:', result.exitCode,
            'stdout (last 2000):',
            redactProvisioningOutput(result.stdout.substring(Math.max(0, result.stdout.length - 2000))),
            'stderr:', redactProvisioningOutput(result.stderr.substring(0, 500)),
          );

          if (result.exitCode !== 0) {
            // stderr is redacted for the same reason as stdout, and again on the
            // way out: this string is rendered in the provisioning dialog.
            const failure = redactProvisioningOutput(result.stderr);
            console.error('Provisioning failed:', failure);
            await db.update(workers).set({ status: 'error' }).where(eq(workers.id, workerId));
            return json({ error: 'Provisioning failed: ' + failure }, { status: 500 });
          }

          const certs = parseCertsFromOutput(result.stdout);
          const hasCerts = !!(certs.caCert && certs.clientCert && certs.clientKey);
          const storedBouncerKey = certs.bouncerKey || bouncerKey;

          if (hasCerts) {
            console.log('mTLS certificates obtained from provisioning output');
          } else {
            console.warn('No mTLS certificates found in provisioning output - Podman API may not be secured');
          }

          if (storedBouncerKey) {
            console.log('CrowdSec bouncer key obtained');
          }

          const newPodmanApiUrl = worker.baseDomain
            ? `https://podman-api.${worker.baseDomain}`
            : `https://${worker.hostname}`;

          await db.update(workers).set({ 
            status: 'online',
            podmanApiUrl: newPodmanApiUrl,
            ...(hasCerts ? {
              podmanCaCert: certs.caCert,
              podmanClientCert: certs.clientCert,
              // Private key material is encrypted at rest; the CA and client
              // certificates are public halves and stay readable.
              podmanClientKey: encryptField(certs.clientKey),
            } : {}),
            crowdsecBouncerKey: encryptField(storedBouncerKey),
            // Provisioning writes global-oidc.yml itself when the config is
            // complete, so deploys may attach the middleware from now on.
            ...(workerOidcConfig ? { oidcAppliedAt: new Date() } : {}),
            provisionedAt: new Date(),
            lastSeenAt: new Date(),
          }).where(eq(workers.id, workerId));

          // A failed routing fetch is reported, not buried in the log tail.
          //
          // The script warns and carries on by design — the worker keeps serving
          // whatever it already had, which is the right behaviour — but the
          // response used to say "Worker provisioned successfully" regardless.
          // An operator who then redeploys, which is the documented next step,
          // drops the container labels that were the only thing still routing.
          const routingFetch = parseRoutingFetchState(result.stdout);
          if (routingFetch && !routingFetch.ok) {
            const endpoint = configEndpointUrl(worker.id, env.PUBLIC_URL);
            await db
              .update(workers)
              .set({
                configFetchStatus: routingFetch.code,
                configFetchDetail: routingFetch.detail,
                configFetchAttemptAt: new Date(),
              })
              .where(eq(workers.id, workerId));

            return json({
              success: true,
              routingFetchFailed: true,
              message: describeRoutingFetchFailure(routingFetch, endpoint),
              mtlsEnabled: hasCerts,
            });
          }

          // Provisioning no longer imports anything. Containers already on the
          // machine are offered for adoption on the worker's page, where a person
          // chooses which of them Rudder should manage. The counts this used to
          // return were always zero anyway — discovery was deferred to the metrics
          // cycle, so the response reported an import that had not happened yet.
          return json({
            success: true,
            message: 'Worker provisioned successfully',
            mtlsEnabled: hasCerts,
          });
        } catch (error: any) {
          console.error('Provisioning error:', error);
          await db.update(workers).set({ status: 'error' }).where(eq(workers.id, workerId));
          return json({ error: error.message }, { status: 500 });
        }
      }
    );
  } catch (error) {
    if (error instanceof LockError) {
      return json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
});
