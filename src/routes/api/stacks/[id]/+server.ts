import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { stacks, applications, teams, teamMembers, users, workers, containers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { getRestPodmanClient } from '$lib/server/podman-client';
import { executeApplicationDeploy } from '$lib/server/deploy';

async function getUser(cookies: any) {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return null;
  return db.select().from(users).where(eq(users.id, userId)).get();
}

/** GET: Get stack with its applications */
export async function GET({ params, cookies }: { params: { id: string }; cookies: any }) {
  const user = await getUser(cookies);
  if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

  const stack = await db.select().from(stacks).where(eq(stacks.id, params.id)).get();
  if (!stack) return json({ error: 'Stack not found' }, { status: 404 });

  const apps = await db.select().from(applications).where(eq(applications.stackId, params.id)).all();
  const team = stack.teamId ? await db.select().from(teams).where(eq(teams.id, stack.teamId)).get() : null;

  // Get container statuses and URLs for each app
  const appsWithStatus = [];
  for (const app of apps) {
    const appContainers = await db.select().from(containers).where(eq(containers.applicationId, app.id)).all();
    const worker = app.workerId ? await db.select().from(workers).where(eq(workers.id, app.workerId)).get() : null;

    // Extract deduplicated service URLs from traefik labels
    const urlMap = new Map<string, string>();
    for (const c of appContainers) {
      if (!c.labels) continue;
      try {
        const labels: Record<string, string> = JSON.parse(c.labels);
        for (const [key, value] of Object.entries(labels)) {
          if (key.startsWith('traefik.http.routers.') && key.endsWith('.rule')) {
            const match = (value as string).match(/Host\(`([^`]+)`\)/);
            if (match) {
              const url = `https://${match[1]}`;
              if (!urlMap.has(url)) urlMap.set(url, url);
            }
          }
        }
      } catch { /* ignore */ }
    }

    const appUrl = app.domain
      ? `https://${app.domain}`
      : (urlMap.values().next().value ?? null);

    appsWithStatus.push({
      ...app,
      containers: appContainers,
      workerName: worker?.name ?? null,
      appUrl,
      serviceUrls: app.type === 'compose' ? Array.from(urlMap.entries()).map(([url]) => ({ url })) : [],
    });
  }

  return json({
    ...stack,
    teamName: team?.name ?? 'Unknown',
    applications: appsWithStatus,
  });
}

/** PATCH: Update stack */
export async function PATCH({ params, request, cookies }: { params: { id: string }; request: Request; cookies: any }) {
  const user = await getUser(cookies);
  if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

  const stack = await db.select().from(stacks).where(eq(stacks.id, params.id)).get();
  if (!stack) return json({ error: 'Stack not found' }, { status: 404 });

  const body = await request.json();

  // Handle removing an app from the stack
  if (body.removeAppId) {
    await db.update(applications)
      .set({ stackId: null, updatedAt: new Date() })
      .where(eq(applications.id, body.removeAppId));
    return json({ success: true });
  }

  const updates: Record<string, any> = { updatedAt: new Date() };

  if (body.name !== undefined) updates.name = body.name;
  if (body.description !== undefined) updates.description = body.description;

  await db.update(stacks).set(updates).where(eq(stacks.id, params.id));

  return json({ success: true });
}

/** DELETE: Delete stack (unsets stackId on apps, doesn't delete apps) */
export async function DELETE({ params, cookies }: { params: { id: string }; cookies: any }) {
  const user = await getUser(cookies);
  if (!user) return json({ error: 'Unauthorized' }, { status: 401 });

  const stack = await db.select().from(stacks).where(eq(stacks.id, params.id)).get();
  if (!stack) return json({ error: 'Stack not found' }, { status: 404 });

  // Unset stackId on all apps in this stack
  await db.update(applications).set({ stackId: null, updatedAt: new Date() }).where(eq(applications.stackId, params.id));

  // Delete the stack
  await db.delete(stacks).where(eq(stacks.id, params.id));

  return json({ success: true });
}

/** POST: Bulk action on all apps in the stack */
export async function POST({ params, request, cookies }: { params: { id: string }; request: Request; cookies: any }) {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');
  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const stack = await db.select().from(stacks).where(eq(stacks.id, params.id)).get();
  if (!stack) return json({ error: 'Stack not found' }, { status: 404 });

  const body = await request.json();
  const { action } = body;

  if (!action || !['deploy', 'stop', 'restart'].includes(action)) {
    return json({ error: 'Invalid action. Must be deploy, stop, or restart.' }, { status: 400 });
  }

  const apps = await db.select().from(applications).where(eq(applications.stackId, params.id)).all();

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
      } else {
        const podmanClient = getRestPodmanClient(worker);
        const appContainers = await db.select().from(containers).where(eq(containers.applicationId, app.id)).all();

        for (const container of appContainers) {
          try {
            if (action === 'stop') {
              await podmanClient.stopContainer(container.containerId);
              await db.update(containers).set({ status: 'exited', updatedAt: new Date() }).where(eq(containers.id, container.id));
            } else if (action === 'restart') {
              await podmanClient.restartContainer(container.containerId);
              await db.update(containers).set({ status: 'running', updatedAt: new Date() }).where(eq(containers.id, container.id));
            }
          } catch (e: any) {
            console.error(`Failed to ${action} container ${container.containerId}:`, e.message);
          }
        }
        results.push({ appId: app.id, appName: app.name, success: true, message: `${action} completed` });
      }
    } catch (e: any) {
      results.push({ appId: app.id, appName: app.name, success: false, message: e.message });
    }
  }

  const allSuccess = results.every(r => r.success);
  return json({
    success: allSuccess,
    message: allSuccess
      ? `${action} completed for all ${results.length} applications`
      : `${action} completed with some errors`,
    results,
  });
}
