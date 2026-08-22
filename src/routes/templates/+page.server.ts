import { redirect, fail } from '@sveltejs/kit';
import { db, safeWorkerColumns, safeUserColumns } from '$lib/db';
import { applicationTemplates, applications, users, teams, teamMembers, workers } from '$lib/db/schema';
import { and, eq, inArray, or } from 'drizzle-orm';
import { buildAppDomain, assertDomainAvailable } from '$lib/server/domains';

async function canModifyTemplate(userId: string, template: any): Promise<boolean> {
  // Global admins can modify any template
  const currentUser = await db.select().from(users).where(eq(users.id, userId)).get();
  if (currentUser?.role === 'admin') return true;

  // Template creator can modify their own templates
  if (template.createdBy === userId) return true;

  // User is a member of the owning team
  const membership = await db
    .select()
    .from(teamMembers)
    .where(eq(teamMembers.userId, userId))
    .all();
  return membership.some((m) => m.teamId === template.teamId);
}

/** Whether `userId` may act on `teamId`'s behalf. Admins always may. */
async function canActForTeam(userId: string, teamId: string): Promise<boolean> {
  const currentUser = await db.select().from(users).where(eq(users.id, userId)).get();
  if (currentUser?.role === 'admin') return true;

  const membership = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.userId, userId), eq(teamMembers.teamId, teamId)))
    .get();
  return !!membership;
}

export const load = async ({ cookies, url }: { cookies: any; url: URL }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId) throw redirect(303, '/login');

  const userId = await validateSession(sessionId);
  if (!userId) throw redirect(303, '/login');

  const currentUser = await db.select(safeUserColumns).from(users).where(eq(users.id, userId)).get();

  // Get user's team memberships
  const memberships = await db
    .select()
    .from(teamMembers)
    .where(eq(teamMembers.userId, userId))
    .all();
  const teamIds = memberships.map((m) => m.teamId);
  const urlTeam = url.searchParams.get('team');

  // Visible templates: own team's templates + shared templates from other teams
  let visibleTemplates;
  if (currentUser?.role === 'admin' && (!urlTeam || urlTeam === 'all')) {
    visibleTemplates = await db.select().from(applicationTemplates).all();
  } else {
    let targetTeamIds = teamIds;
    if (urlTeam && urlTeam !== 'all') {
      targetTeamIds = (currentUser?.role === 'admin' || teamIds.includes(urlTeam)) ? [urlTeam] : [];
    }

    if (targetTeamIds.length > 0) {
      visibleTemplates = await db
        .select()
        .from(applicationTemplates)
        .where(
          or(
            inArray(applicationTemplates.teamId, targetTeamIds),
            eq(applicationTemplates.shared, true),
            eq(applicationTemplates.createdBy, userId)
          )
        )
        .all();
    } else {
      visibleTemplates = await db
        .select()
        .from(applicationTemplates)
        .where(
          or(
            eq(applicationTemplates.shared, true),
            eq(applicationTemplates.createdBy, userId)
          )
        )
        .all();
    }
  }

  const allTeams = await db.select().from(teams).all();
  const allWorkers = await db.select(safeWorkerColumns).from(workers).all();
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

    // The application was fetched by id alone, so this action would copy any
    // application in the installation — manifest and environment block included
    // — into a template owned by that application's team. 404 rather than 403:
    // the caller cannot see this application, so it should not be able to tell
    // an inaccessible id from a nonexistent one.
    if (!userId || !(await canActForTeam(userId, app.teamId))) {
      return fail(404, { error: 'Application not found' });
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
      return fail(500, { error: `Failed to save template: ${e.message}` });
    }

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

    // Verify user can modify this template
    if (!(await canModifyTemplate(userId!, template))) {
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

    if (!(await canModifyTemplate(userId!, template))) {
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

    if (!(await canModifyTemplate(userId!, template))) {
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

    const domain = buildAppDomain(name, worker.baseDomain);
    const domainConflict = await assertDomainAvailable(domain);
    if (domainConflict) return fail(400, { error: domainConflict });

    const appId = crypto.randomUUID();

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
