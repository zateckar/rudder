import { json } from '@sveltejs/kit';
import { db } from '#lib/db/index.ts';
import { deployWebhooks, applications, auditLogs } from '#lib/db/schema.ts';
import { eq, and } from 'drizzle-orm';
import { hashKey } from '#lib/server/encryption.ts';
import { executeApplicationDeploy } from '#lib/server/deploy.ts';
import { applicationTask, getTask, operationView } from '#lib/server/application-operations.ts';
import { operationResponse } from '#lib/server/operation-http.ts';

async function authorizeWebhook(applicationId: string, request: Request) {
  const authHeader = request.headers.get('authorization');
  const rawToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (!rawToken) {
    return { error: json(
      { error: 'Missing authentication token — send it as `Authorization: Bearer <token>`' },
      { status: 401 },
    ) };
  }

  // Hash the provided token and look up matching webhook
  const tokenHash = hashKey(rawToken);

  const webhook = await db
    .select()
    .from(deployWebhooks)
    .where(
      and(
        eq(deployWebhooks.applicationId, applicationId),
        eq(deployWebhooks.token, tokenHash),
        eq(deployWebhooks.enabled, true),
      )
    )
    .get();

  if (!webhook) {
    return { error: json({ error: 'Invalid or disabled webhook token' }, { status: 401 }) };
  }

  return { webhook };
}

export async function GET({ params, request }: { params: { id: string }; request: Request }) {
  const auth = await authorizeWebhook(params.id, request);
  if (auth.error) return auth.error;
  const id = new URL(request.url).searchParams.get('id');
  const task = id ? getTask(id) : undefined;
  const headers = { 'Cache-Control': 'no-store' };
  if (!task || task.applicationId !== params.id || task.startedBy !== `webhook:${auth.webhook.id}`) {
    return json({ error: 'Operation not found' }, { status: 404, headers });
  }
  return json({ operation: operationView(task) }, { headers });
}

/**
 * POST — unauthenticated webhook trigger endpoint for CI/CD.
 *
 * Auth via `Authorization: Bearer <token>`, and only that.
 *
 * `?token=<token>` used to be accepted as well. A URL is the one part of a
 * request that everything logs by default — the reverse proxy's access log,
 * anything with `X-Forwarded-*` in front of it, and this panel's own audit
 * trail, which records `url.search` — so that put a credential that triggers a
 * production deploy into files with a wider audience and a different retention
 * policy than the token itself has. The terminal WebSocket was moved off the
 * query string for the same reason; see `#lib/terminal-protocol.ts`.
 *
 * Nothing Rudder generates used the query form: the URL handed out at creation
 * time has always been the bare path, with the token shown separately.
 */
export async function POST({ params, request }: { params: { id: string }; request: Request }) {
  const applicationId = params.id;

  const auth = await authorizeWebhook(applicationId, request);
  if (auth.error) return auth.error;
  const { webhook } = auth;
  const app = db.select({ id: applications.id, name: applications.name, teamId: applications.teamId })
    .from(applications).where(eq(applications.id, applicationId)).get();
  if (!app) return json({ error: 'Application not found' }, { status: 404 });

  // Update lastUsedAt
  await db
    .update(deployWebhooks)
    .set({ lastUsedAt: new Date() })
    .where(eq(deployWebhooks.id, webhook.id));

  // Webhook calls carry no session or API key, so the global audit hook skips
  // them — record the deploy here instead.
  try {
    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      userId: webhook.createdBy,
      teamId: app.teamId,
      action: 'DEPLOY',
      resourceType: 'application',
      resourceId: applicationId,
      details: JSON.stringify({ via: 'webhook', webhookId: webhook.id }),
      createdAt: new Date(),
    });
  } catch (e) {
    console.error('Failed to write webhook audit log:', e);
  }

  // Trigger the deploy
  try {
    const actor = `webhook:${webhook.id}`;
    return await operationResponse(request, applicationTask(app, 'deploy', actor),
      (reportProgress) => executeApplicationDeploy(applicationId, webhook.createdBy, { reportProgress }),
      (result, operationId) => result.success
        ? json({ success: true, message: 'Deployment triggered', operationId })
        : json({ success: false, message: result.message, operationId }, { status: result.statusCode || 500 }),
      true);
  } catch (error: any) {
    console.error('Webhook deploy error:', error);
    return json({ success: false, message: error.message || 'Deployment failed' }, { status: 500 });
  }
}
