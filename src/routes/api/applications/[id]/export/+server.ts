import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { applications } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { canAccessApplication } from '$lib/server/auth';

export async function GET({ params, cookies }: { params: { id: string }; cookies: any }) {
  const access = await canAccessApplication(cookies, params.id);
  if (!access) {
    return json({ error: 'Not found or unauthorized' }, { status: 404 });
  }

  const { application: app } = access;

  // Redact secret values in environment
  let environment = null;
  if (app.environment) {
    try {
      const envVars: Array<{ key: string; value: string; secret: boolean }> = JSON.parse(app.environment);
      environment = JSON.stringify(
        envVars.map(e => ({
          key: e.key,
          value: e.secret ? '***REDACTED***' : e.value,
          secret: e.secret,
        }))
      );
    } catch {
      // An environment block that does not parse cannot be redacted per
      // variable, and falling back to the raw column — as this did — exported
      // every value in cleartext, secrets included. One malformed edit was
      // enough to defeat the redaction above entirely. The export is a
      // configuration template, so dropping the block costs the operator the
      // one field they must fill in by hand anyway.
      environment = null;
      console.warn(
        `[export] Environment block of application ${app.id} is not valid JSON; ` +
          `omitting it from the export rather than exporting it unredacted.`,
      );
    }
  }

  const config = {
    name: app.name,
    description: app.description,
    type: app.type,
    deploymentFormat: app.deploymentFormat,
    manifest: app.manifest,
    environment,
    volumes: app.volumes,
    restartPolicy: app.restartPolicy,
    exposedPorts: app.exposedPorts,
    rateLimitAvg: app.rateLimitAvg,
    rateLimitBurst: app.rateLimitBurst,
    authType: app.authType,
    oidcIdTokenHeader: app.oidcIdTokenHeader,
    oidcAccessTokenHeader: app.oidcAccessTokenHeader,
    healthcheck: app.healthcheck,
    replicas: app.replicas,
    gitRepo: app.gitRepo,
    gitBranch: app.gitBranch,
    gitDockerfile: app.gitDockerfile,
  };

  const body = JSON.stringify(config, null, 2);

  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${app.name}-config.json"`,
    },
  });
}
