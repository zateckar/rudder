import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { applications, workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';
import { requireAuth } from '$lib/server/auth';

export async function POST({ request, cookies }: { request: Request; cookies: any }) {
  const ctx = await requireAuth(cookies);

  const body = await request.json();
  const { config, name, teamId, workerId } = body;

  if (!config || !name || !teamId || !workerId) {
    return json({ error: 'Missing required fields: config, name, teamId, workerId' }, { status: 400 });
  }

  // Validate name format
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    return json({ error: 'Name must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens' }, { status: 400 });
  }

  // Check for unique name
  const existingApp = await db.select().from(applications).where(eq(applications.name, name)).get();
  if (existingApp) {
    return json({ error: `Application name "${name}" is already taken` }, { status: 400 });
  }

  // Validate worker exists
  const worker = await db.select().from(workers).where(eq(workers.id, workerId)).get();
  if (!worker) {
    return json({ error: 'Worker not found' }, { status: 404 });
  }

  const domain = worker.baseDomain ? `${name}.${worker.baseDomain}` : null;

  // If the imported config has an image-based manifest, update image name for git apps
  let manifest = config.manifest || '';
  if (config.gitRepo && config.type === 'single') {
    try {
      const cfg = JSON.parse(manifest);
      cfg.image = `rudder/${name}:latest`;
      manifest = JSON.stringify(cfg);
    } catch {
      manifest = JSON.stringify({ image: `rudder/${name}:latest` });
    }
  }

  const appId = uuidv4();

  await db.insert(applications).values({
    id: appId,
    name,
    description: config.description || null,
    workerId,
    teamId,
    domain,
    type: config.type || 'single',
    deploymentFormat: config.deploymentFormat || 'compose',
    manifest,
    environment: config.environment || null,
    volumes: config.volumes || null,
    restartPolicy: config.restartPolicy || 'always',
    rateLimitAvg: config.rateLimitAvg || null,
    rateLimitBurst: config.rateLimitBurst || null,
    authType: config.authType || 'none',
    healthcheck: config.healthcheck || null,
    replicas: config.replicas || 1,
    gitRepo: config.gitRepo || null,
    gitBranch: config.gitBranch || null,
    gitDockerfile: config.gitDockerfile || null,
    createdBy: ctx.user.id,
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  return json({ success: true, applicationId: appId, message: `Application "${name}" imported successfully` });
}
