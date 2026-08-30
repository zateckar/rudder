import { redirect, fail } from '@sveltejs/kit';
import { db, safeWorkerColumns } from '$lib/db';
import { applicationTemplates, applications, teams, teamMembers, workers } from '$lib/db/schema';
import { eq, inArray, or } from 'drizzle-orm';
import { buildAppDomain, assertDomainAvailable } from '$lib/server/domains';
import {
  type AuthContext,
  canWriteToTeam,
  currentUser as sessionUser,
  isTeamMember,
  requirePageUser,
} from '$lib/server/auth';

/** Whether this caller may share, unshare or delete a template. */
async function canModifyTemplate(ctx: AuthContext, template: any): Promise<boolean> {
  if (ctx.user.role === 'admin') return true;
  if (template.createdBy === ctx.user.id) return true;
  return !!template.teamId && isTeamMember(ctx.user.id, template.teamId);
}

/** Resolve the caller, or the `fail()` an action should return. */
function actor(event: { locals: App.Locals }): AuthContext | null {
  return sessionUser(event);
}

export const load = async (event: { locals: App.Locals; url: URL }) => {
  const currentUser = requirePageUser(event).user;
  const userId = currentUser.id;

  // Get user's team memberships
  const memberships = await db
    .select()
    .from(teamMembers)
    .where(eq(teamMembers.userId, userId))
    .all();
  const teamIds = memberships.map((m) => m.teamId);
  const urlTeam = event.url.searchParams.get('team');

  // Visible templates: own team's templates + shared templates from other teams
  let visibleTemplates;
  if (currentUser.role === 'admin' && (!urlTeam || urlTeam === 'all')) {
    visibleTemplates = await db.select().from(applicationTemplates).all();
  } else {
    let targetTeamIds = teamIds;
    if (urlTeam && urlTeam !== 'all') {
      targetTeamIds = (currentUser.role === 'admin' || teamIds.includes(urlTeam)) ? [urlTeam] : [];
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
  save: async (event: { request: Request; locals: App.Locals }) => {
    const ctx = actor(event);
    if (!ctx) return fail(401, { error: 'Unauthorized' });
    const userId = ctx.user.id;
    const formData = await event.request.formData();

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
    if (!(await canWriteToTeam(ctx, app.teamId))) {
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
        exposedPorts: app.exposedPorts,
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

  share: async (event: { request: Request; locals: App.Locals }) =>
    setShared(event, true),

  unshare: async (event: { request: Request; locals: App.Locals }) =>
    setShared(event, false),

  delete: async (event: { request: Request; locals: App.Locals }) => {
    const ctx = actor(event);
    if (!ctx) return fail(401, { error: 'Unauthorized' });

    const formData = await event.request.formData();
    const templateId = formData.get('templateId')?.toString();
    if (!templateId) return fail(400, { error: 'Template ID required' });

    const template = await db
      .select()
      .from(applicationTemplates)
      .where(eq(applicationTemplates.id, templateId))
      .get();
    if (!template) return fail(404, { error: 'Template not found' });

    if (!(await canModifyTemplate(ctx, template))) {
      return fail(403, { error: 'Not authorized to delete this template' });
    }

    await db.delete(applicationTemplates).where(eq(applicationTemplates.id, templateId));

    return { success: true };
  },

  apply: async (event: { request: Request; locals: App.Locals }) => {
    const ctx = actor(event);
    if (!ctx) return fail(401, { error: 'Unauthorized' });
    const userId = ctx.user.id;
    const formData = await event.request.formData();

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

    // Verify visibility of the template…
    if (!template.shared && !(await isTeamMember(userId, template.teamId))) {
      return fail(403, { error: 'Not authorized to use this template' });
    }

    // …and authority over the team the new application is being placed in.
    // This was missing: the team came from the submitted form and was written
    // straight through, so a shared template was a way to create an application
    // inside any team in the installation — where it consumes that team's
    // quota, claims a domain and is deployed on their behalf. This is exactly
    // what `canWriteToTeam` exists for.
    if (!(await canWriteToTeam(ctx, teamId))) {
      return fail(403, { error: 'Not authorized to create applications in this team' });
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
      exposedPorts: template.exposedPorts,
      // Stated rather than left to the column default. A template carries no
      // auth configuration — an OIDC client secret is not something to copy
      // between applications — so this is the one decision the row has to make,
      // and it was making it by omission: drizzle leaves an unsupplied column
      // out of the INSERT, and the deployed databases defaulted it to 'none'
      // rather than the 'global' the schema promised. Every application created
      // from a template was therefore created unauthenticated. See
      // drizzle/0001, which fixes the databases; this is the half that means it
      // cannot happen again through this path.
      authType: 'global',
      createdBy: userId || undefined,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    throw redirect(303, `/applications/${appId}`);
  },
};

/**
 * `share` and `unshare` differed by one boolean and were otherwise identical,
 * down to the error strings.
 */
async function setShared(event: { request: Request; locals: App.Locals }, shared: boolean) {
  const ctx = actor(event);
  if (!ctx) return fail(401, { error: 'Unauthorized' });

  const formData = await event.request.formData();
  const templateId = formData.get('templateId')?.toString();
  if (!templateId) return fail(400, { error: 'Template ID required' });

  const template = await db
    .select()
    .from(applicationTemplates)
    .where(eq(applicationTemplates.id, templateId))
    .get();
  if (!template) return fail(404, { error: 'Template not found' });

  if (!(await canModifyTemplate(ctx, template))) {
    return fail(403, { error: 'Not authorized to modify this template' });
  }

  await db
    .update(applicationTemplates)
    .set({ shared, updatedAt: new Date() })
    .where(eq(applicationTemplates.id, templateId));

  return { success: true };
}
