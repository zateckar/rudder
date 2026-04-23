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
      environment = app.environment;
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
    rateLimitAvg: app.rateLimitAvg,
    rateLimitBurst: app.rateLimitBurst,
    authType: app.authType,
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
