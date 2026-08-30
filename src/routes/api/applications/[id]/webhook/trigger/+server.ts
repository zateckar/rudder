import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { deployWebhooks, applications, auditLogs } from '$lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { hashKey } from '$lib/server/encryption';
import { executeApplicationDeploy } from '$lib/server/deploy';

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
 * query string for the same reason; see `$lib/terminal-protocol`.
 *
 * Nothing Rudder generates used the query form: the URL handed out at creation
 * time has always been the bare path, with the token shown separately.
 */
export async function POST({ params, request }: { params: { id: string }; request: Request }) {
  const applicationId = params.id;

  const authHeader = request.headers.get('authorization');
  const rawToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null;

  if (!rawToken) {
    return json(
      { error: 'Missing authentication token — send it as `Authorization: Bearer <token>`' },
      { status: 401 },
    );
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
    return json({ error: 'Invalid or disabled webhook token' }, { status: 401 });
  }

  // Update lastUsedAt
  await db
    .update(deployWebhooks)
    .set({ lastUsedAt: new Date() })
    .where(eq(deployWebhooks.id, webhook.id));

  // Webhook calls carry no session or API key, so the global audit hook skips
  // them — record the deploy here instead.
  try {
    const app = await db
      .select({ teamId: applications.teamId })
      .from(applications)
      .where(eq(applications.id, applicationId))
      .get();

    await db.insert(auditLogs).values({
      id: crypto.randomUUID(),
      userId: webhook.createdBy,
      teamId: app?.teamId ?? null,
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
    const result = await executeApplicationDeploy(applicationId, webhook.createdBy);
    if (!result.success) {
      return json({ success: false, message: result.message }, { status: result.statusCode || 500 });
    }
    return json({ success: true, message: 'Deployment triggered' });
  } catch (error: any) {
    console.error('Webhook deploy error:', error);
    return json({ success: false, message: error.message || 'Deployment failed' }, { status: 500 });
  }
}
