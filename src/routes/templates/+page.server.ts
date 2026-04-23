import { redirect, fail } from '@sveltejs/kit';
import { db } from '$lib/db';
import { applicationTemplates, applications, users, teams, teamMembers, workers } from '$lib/db/schema';
import { eq, inArray, or } from 'drizzle-orm';

export const load = async ({ cookies }: { cookies: any }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId) throw redirect(303, '/login');

  const userId = await validateSession(sessionId);
  if (!userId) throw redirect(303, '/login');

  const currentUser = await db.select().from(users).where(eq(users.id, userId)).get();

  // Get user's team memberships
  const memberships = await db
    .select()
    .from(teamMembers)
    .where(eq(teamMembers.userId, userId))
    .all();
  const teamIds = memberships.map((m) => m.teamId);

  // Visible templates: own team's templates + shared templates from other teams
  const visibleTemplates =
    teamIds.length > 0
      ? await db
          .select()
          .from(applicationTemplates)
          .where(
            or(
              inArray(applicationTemplates.teamId, teamIds),
              eq(applicationTemplates.shared, true)
            )
          )
          .all()
      : await db
          .select()
          .from(applicationTemplates)
          .where(eq(applicationTemplates.shared, true))
          .all();

  const allTeams = await db.select().from(teams).all();
  const allWorkers = await db.select().from(workers).all();
  const allApps = await db.select().from(applications).all();

  return {
    user: currentUser,
    templates: visibleTemplates,
    teams: allTeams,
    workers: allWorkers,
    applications: allApps,
    userTeamIds: teamIds,
  };
};

export const actions = {
  save: async ({ request, cookies }: { request: Request; cookies: any }) => {
    const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

    const sessionId = getSessionIdFromCookies(cookies);
    if (!sessionId || !(await validateSession(sessionId))) {
      return fail(401, { error: 'Unauthorized' });
    }

    const userId = await validateSession(sessionId);
    const formData = await request.formData();

    const appId = formData.get('appId')?.toString();
    const name = formData.get('name')?.toString()?.trim();
    const description = formData.get('description')?.toString()?.trim() || null;

    if (!appId || !name) {
      return fail(400, { error: 'Application and template name are required' });
    }

    const app = await db.select().from(applications).where(eq(applications.id, appId)).get();
    if (!app) {
      return fail(404, { error: 'Application not found' });
    }

    if (!app.teamId) {
      return fail(400, { error: 'Application must belong to a team' });
    }

    // Check for duplicate template name within the team
    const existing = await db
      .select()
      .from(applicationTemplates)
      .where(eq(applicationTemplates.name, name))
      .all();
    if (existing.some((t) => t.teamId === app.teamId)) {
      return fail(400, { error: `Template "${name}" already exists for your team` });
    }

    const { v4: uuidv4 } = await import('uuid');

    await db.insert(applicationTemplates).values({
      id: uuidv4(),
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

    return { success: true, message: `Template "${name}" created` };
  },

  share: async ({ request, cookies }: { request: Request; cookies: any }) => {
    const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

    const sessionId = getSessionIdFromCookies(cookies);
    if (!sessionId || !(await validateSession(sessionId))) {
      return fail(401, { error: 'Unauthorized' });
    }

    const userId = await validateSession(sessionId);
    const formData = await request.formData();
    const templateId = formData.get('templateId')?.toString();

    if (!templateId) return fail(400, { error: 'Template ID required' });

    const template = await db
      .select()
      .from(applicationTemplates)
      .where(eq(applicationTemplates.id, templateId))
      .get();
    if (!template) return fail(404, { error: 'Template not found' });

    // Verify user is a member of the owning team
    const membership = await db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.userId, userId!))
      .all();
    if (!membership.some((m) => m.teamId === template.teamId)) {
      return fail(403, { error: 'Not authorized to modify this template' });
    }

    await db
      .update(applicationTemplates)
      .set({ shared: true, updatedAt: new Date() })
      .where(eq(applicationTemplates.id, templateId));

    return { success: true };
  },

  unshare: async ({ request, cookies }: { request: Request; cookies: any }) => {
    const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

    const sessionId = getSessionIdFromCookies(cookies);
    if (!sessionId || !(await validateSession(sessionId))) {
      return fail(401, { error: 'Unauthorized' });
    }

    const userId = await validateSession(sessionId);
    const formData = await request.formData();
    const templateId = formData.get('templateId')?.toString();

    if (!templateId) return fail(400, { error: 'Template ID required' });

    const template = await db
      .select()
      .from(applicationTemplates)
      .where(eq(applicationTemplates.id, templateId))
      .get();
    if (!template) return fail(404, { error: 'Template not found' });

    const membership = await db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.userId, userId!))
      .all();
    if (!membership.some((m) => m.teamId === template.teamId)) {
      return fail(403, { error: 'Not authorized to modify this template' });
    }

    await db
      .update(applicationTemplates)
      .set({ shared: false, updatedAt: new Date() })
      .where(eq(applicationTemplates.id, templateId));

    return { success: true };
  },

  delete: async ({ request, cookies }: { request: Request; cookies: any }) => {
    const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

    const sessionId = getSessionIdFromCookies(cookies);
    if (!sessionId || !(await validateSession(sessionId))) {
      return fail(401, { error: 'Unauthorized' });
    }

    const userId = await validateSession(sessionId);
    const formData = await request.formData();
    const templateId = formData.get('templateId')?.toString();

    if (!templateId) return fail(400, { error: 'Template ID required' });

    const template = await db
      .select()
      .from(applicationTemplates)
      .where(eq(applicationTemplates.id, templateId))
      .get();
    if (!template) return fail(404, { error: 'Template not found' });

    const membership = await db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.userId, userId!))
      .all();
    if (!membership.some((m) => m.teamId === template.teamId)) {
      return fail(403, { error: 'Not authorized to delete this template' });
    }

    await db
      .delete(applicationTemplates)
      .where(eq(applicationTemplates.id, templateId));

    return { success: true };
  },

  apply: async ({ request, cookies }: { request: Request; cookies: any }) => {
    const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

    const sessionId = getSessionIdFromCookies(cookies);
    if (!sessionId || !(await validateSession(sessionId))) {
      return fail(401, { error: 'Unauthorized' });
    }

    const userId = await validateSession(sessionId);
    const formData = await request.formData();

    const templateId = formData.get('templateId')?.toString();
    const name = formData.get('name')?.toString()?.trim();
    const workerId = formData.get('workerId')?.toString();
    const teamId = formData.get('teamId')?.toString();

    if (!templateId || !name || !workerId || !teamId) {
      return fail(400, { error: 'All fields are required' });
    }

    // Validate name format
    if (!/^[a-z][a-z0-9-]*$/.test(name)) {
      return fail(400, { error: 'Name must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens' });
    }

    // Check unique name
    const existingApp = await db.select().from(applications).where(eq(applications.name, name)).get();
    if (existingApp) {
      return fail(400, { error: `Application name "${name}" is already taken` });
    }

    // Load template
    const template = await db
      .select()
      .from(applicationTemplates)
      .where(eq(applicationTemplates.id, templateId))
      .get();
    if (!template) return fail(404, { error: 'Template not found' });

    // Verify visibility
    const memberships = await db
      .select()
      .from(teamMembers)
      .where(eq(teamMembers.userId, userId!))
      .all();
    const userTeamIds = memberships.map((m) => m.teamId);
    if (!template.shared && !userTeamIds.includes(template.teamId)) {
      return fail(403, { error: 'Not authorized to use this template' });
    }

    // Validate worker
    const worker = await db.select().from(workers).where(eq(workers.id, workerId)).get();
    if (!worker) return fail(400, { error: 'Worker not found' });
    if (!worker.baseDomain) return fail(400, { error: 'Worker must have a base domain configured' });

    const domain = `${name}.${worker.baseDomain}`;
    const { v4: uuidv4 } = await import('uuid');
    const appId = uuidv4();

    await db.insert(applications).values({
      id: appId,
      name,
      description: template.description,
      workerId,
      teamId,
      domain,
      type: template.type,
      deploymentFormat: template.deploymentFormat,
      manifest: template.manifest,
      environment: template.environment,
      volumes: template.volumes,
      restartPolicy: template.restartPolicy,
      createdBy: userId || undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    throw redirect(303, `/applications/${appId}`);
  },
};
