import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { applicationTemplates, applications } from '$lib/db/schema';
import { eq } from 'drizzle-orm';

export const POST = async ({ request, cookies }: { request: Request; cookies: any }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId || !(await validateSession(sessionId))) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const userId = await validateSession(sessionId);
  const formData = await request.formData();

  const appId = formData.get('appId')?.toString();
  const name = formData.get('name')?.toString()?.trim();
  const description = formData.get('description')?.toString()?.trim() || null;

  if (!appId || !name) {
    return json({ error: 'Application and template name are required' }, { status: 400 });
  }

  const app = await db.select().from(applications).where(eq(applications.id, appId)).get();
  if (!app) {
    return json({ error: 'Application not found' }, { status: 404 });
  }

  if (!app.teamId) {
    return json({ error: 'Application must belong to a team' }, { status: 400 });
  }

  // Check for duplicate template name within the team
  const existing = await db
    .select()
    .from(applicationTemplates)
    .where(eq(applicationTemplates.name, name))
    .all();
  if (existing.some((t) => t.teamId === app.teamId)) {
    return json({ error: `Template "${name}" already exists for your team` }, { status: 400 });
  }

  try {
    await db.insert(applicationTemplates).values({
      id: crypto.randomUUID(),
      name,
      description,
      sourceAppId: app.id,
      teamId: app.teamId,
      shared: false,
      type: app.type,
      deploymentFormat: app.deploymentFormat,
      manifest: app.manifest,
      environment: app.environment,
      volumes: app.volumes,
      restartPolicy: app.restartPolicy,
      createdBy: userId || undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  } catch (e: any) {
    console.error('Failed to save template:', e);
    return json({ error: `Failed to save template: ${e.message}` }, { status: 500 });
  }

  return json({ success: true, message: `Template "${name}" created` });
};
