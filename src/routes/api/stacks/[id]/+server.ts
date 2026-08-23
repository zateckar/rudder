import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { stacks, applications, teams, teamMembers, workers, containers } from '$lib/db/schema';
import { and, eq, inArray } from 'drizzle-orm';
import { withPodman } from '$lib/server/podman-client';
import { executeApplicationDeploy } from '$lib/server/deploy';
import { applyToContainers, lifecycleMessage } from '$lib/server/deploy/lifecycle';
import { AuthorizationError, requireUser, route } from '$lib/server/auth';
import { primaryUrl, serviceUrls } from '$lib/server/app-urls';

/**
 * Resolve a stack the caller is allowed to touch.
 *
 * A stack is a handle on a whole team's worth of applications — GET returns
 * their full rows, POST deploys, stops and restarts every one of them — so
 * every method here needs the membership check, not just the mutating ones.
 * 404 rather than 403 so the route does not confirm which stack ids exist.
 */
async function requireStack(
  event: { locals: App.Locals },
  stackId: string,
): Promise<{ userId: string; stack: typeof stacks.$inferSelect }> {
  const ctx = requireUser(event);

  const stack = await db.select().from(stacks).where(eq(stacks.id, stackId)).get();
  if (!stack) throw new AuthorizationError('Stack not found', 404);

  if (ctx.user.role !== 'admin') {
    // A stack with no team predates team scoping and belongs to nobody, so it
    // is not something a member may reach either.
    if (!stack.teamId) throw new AuthorizationError('Stack not found', 404);

    const membership = await db
      .select()
      .from(teamMembers)
      .where(and(eq(teamMembers.teamId, stack.teamId), eq(teamMembers.userId, ctx.user.id)))
      .get();
    if (!membership) throw new AuthorizationError('Stack not found', 404);
  }

  return { userId: ctx.user.id, stack };
}

/** GET: Get stack with its applications */
export const GET: RequestHandler = route(async (event) => {
  const stackId = event.params.id!;
  const { stack } = await requireStack(event, stackId);

  const apps = await db.select().from(applications).where(eq(applications.stackId, stackId)).all();
  const team = stack.teamId
    ? await db.select().from(teams).where(eq(teams.id, stack.teamId)).get()
    : null;

  // Two queries for the whole stack rather than two per application: this ran a
  // containers select and a workers select inside the loop.
  const appIds = apps.map((a) => a.id);
  const allContainers = appIds.length
    ? await db.select().from(containers).where(inArray(containers.applicationId, appIds)).all()
    : [];
  const workerIds = [...new Set(apps.map((a) => a.workerId).filter((w): w is string => !!w))];
  const workerRows = workerIds.length
    ? await db.select({ id: workers.id, name: workers.name }).from(workers).where(inArray(workers.id, workerIds)).all()
    : [];
  const workerName = new Map(workerRows.map((w) => [w.id, w.name]));

  const appsWithStatus = apps.map((app) => {
    const appContainers = allContainers.filter((c) => c.applicationId === app.id);
    return {
      ...app,
      containers: appContainers,
      workerName: (app.workerId && workerName.get(app.workerId)) ?? null,
      appUrl: primaryUrl(app.domain, appContainers),
      serviceUrls: app.type === 'compose' ? serviceUrls(appContainers) : [],
    };
  });

  return json({
    ...stack,
    teamName: team?.name ?? 'Unknown',
    applications: appsWithStatus,
  });
});

/** PATCH: Update stack */
export const PATCH: RequestHandler = route(async (event) => {
  const stackId = event.params.id!;
  await requireStack(event, stackId);

  const body = await event.request.json();

  // Handle removing an app from the stack
  if (body.removeAppId) {
    // Confirm the application is actually in this stack before detaching it.
    // Keying the update on the id alone let a caller detach any application in
    // the installation, including one in a stack they cannot see.
    const member = await db
      .select({ id: applications.id })
      .from(applications)
      .where(and(eq(applications.id, body.removeAppId), eq(applications.stackId, stackId)))
      .get();
    if (!member) {
      return json({ error: 'Application is not part of this stack' }, { status: 404 });
    }
    await db.update(applications)
      .set({ stackId: null, updatedAt: new Date() })
      .where(eq(applications.id, member.id));
    return json({ success: true });
  }

  const updates: Record<string, any> = { updatedAt: new Date() };
  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;

  await db.update(stacks).set(updates).where(eq(stacks.id, stackId));

  return json({ success: true });
});

/** DELETE: Delete stack (unsets stackId on apps, doesn't delete apps) */
export const DELETE: RequestHandler = route(async (event) => {
  const stackId = event.params.id!;
  await requireStack(event, stackId);

  await db
    .update(applications)
    .set({ stackId: null, updatedAt: new Date() })
    .where(eq(applications.stackId, stackId));

  await db.delete(stacks).where(eq(stacks.id, stackId));

  return json({ success: true });
});

/** POST: Bulk action on all apps in the stack */
export const POST: RequestHandler = route(async (event) => {
  const stackId = event.params.id!;
  const { userId } = await requireStack(event, stackId);

  const { action } = await event.request.json();

  if (!action || !['deploy', 'stop', 'restart'].includes(action)) {
    return json({ error: 'Invalid action. Must be deploy, stop, or restart.' }, { status: 400 });
  }

  const apps = await db.select().from(applications).where(eq(applications.stackId, stackId)).all();
  if (apps.length === 0) {
    return json({ success: true, message: 'No applications in this stack' });
  }

  const results: { appId: string; appName: string; success: boolean; message: string }[] = [];

  for (const app of apps) {
    if (!app.workerId) {
      results.push({ appId: app.id, appName: app.name, success: false, message: 'No worker assigned' });
      continue;
    }

    const worker = await db.select().from(workers).where(eq(workers.id, app.workerId)).get();
    if (!worker) {
      results.push({ appId: app.id, appName: app.name, success: false, message: 'Worker not found' });
      continue;
    }

    try {
      if (action === 'deploy') {
        const result = await executeApplicationDeploy(app.id, userId);
        results.push({ appId: app.id, appName: app.name, success: result.success, message: result.message });
        continue;
      }

      // Only the generation that is serving, matching /api/applications/deploy:
      // a retained generation is stopped on purpose and restarting it would
      // resurrect the old version's processes with no traffic routed to them.
      const appContainers = await db
        .select()
        .from(containers)
        .where(and(eq(containers.applicationId, app.id), eq(containers.state, 'active')))
        .all();

      // `applyToContainers`, so a container Podman refused is reported instead
      // of logged. This loop used to swallow every failure into console.error
      // and push `success: true` regardless — a stop that stopped nothing said
      // "stop completed".
      const outcome = await withPodman(worker, (client) =>
        applyToContainers(appContainers, (id) =>
          action === 'stop' ? client.stopContainer(id) : client.restartContainer(id),
        ),
      );

      if (outcome.succeeded.length > 0) {
        await db
          .update(containers)
          .set({ status: action === 'stop' ? 'exited' : 'running', updatedAt: new Date() })
          .where(inArray(containers.id, outcome.succeeded));
      }

      results.push({
        appId: app.id,
        appName: app.name,
        success: outcome.failures.length === 0,
        message: lifecycleMessage(
          action === 'stop' ? 'stopped' : 'restarted',
          appContainers.length,
          outcome,
        ),
      });
    } catch (e: any) {
      results.push({ appId: app.id, appName: app.name, success: false, message: e.message });
    }
  }

  const allSuccess = results.every((r) => r.success);
  return json({
    success: allSuccess,
    message: allSuccess
      ? `${action} completed for all ${results.length} applications`
      : `${action} completed with some errors`,
    results,
  });
});
