import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { applications, workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { authErrorResponse, requireTeamMember } from '$lib/server/auth';
import { buildAppDomain, assertDomainAvailable } from '$lib/server/domains';

export async function POST({ request, cookies }: { request: Request; cookies: any }) {
  const body = await request.json();
  const { config, name, teamId, workerId } = body;

  if (!config || !name || !teamId || !workerId) {
    return json({ error: 'Missing required fields: config, name, teamId, workerId' }, { status: 400 });
  }

  // Import writes an application into a team — verify the caller belongs to
  // it, otherwise any user could plant an app in someone else's team.
  let ctx;
  try {
    ({ ...ctx } = await requireTeamMember(cookies, teamId));
  } catch (error) {
    return authErrorResponse(error);
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

  const domain = buildAppDomain(name, worker.baseDomain);
  const domainConflict = await assertDomainAvailable(domain);
  if (domainConflict) {
    return json({ error: domainConflict }, { status: 400 });
  }

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

  const appId = crypto.randomUUID();

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
    // Default to the worker's global auth rather than 'none': an imported
    // config should never silently end up less protected than a new app.
    authType: config.authType === 'none' || config.authType === 'oidc' ? config.authType : 'global',
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
