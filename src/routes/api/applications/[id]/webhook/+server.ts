import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { deployWebhooks, applications } from '$lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import { randomBytes } from 'crypto';
import { hashKey } from '$lib/server/encryption';
import { canAccessApplication } from '$lib/server/auth';

/** GET — return the webhook for this application (if exists) */
export async function GET({ params, cookies }: { params: { id: string }; cookies: any }) {
  const access = await canAccessApplication(cookies, params.id);
  if (!access) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const webhook = await db
    .select()
    .from(deployWebhooks)
    .where(eq(deployWebhooks.applicationId, params.id))
    .get();

  if (!webhook) {
    return json({ webhook: null });
  }

  return json({
    webhook: {
      id: webhook.id,
      enabled: webhook.enabled,
      lastUsedAt: webhook.lastUsedAt,
      url: `/api/applications/${params.id}/webhook/trigger`,
    },
  });
}

/** POST — generate a new deploy webhook for this application */
export async function POST({ params, cookies }: { params: { id: string }; cookies: any }) {
  const access = await canAccessApplication(cookies, params.id);
  if (!access) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Remove existing webhook for this application (one per app)
  await db
    .delete(deployWebhooks)
    .where(eq(deployWebhooks.applicationId, params.id));

  // Generate random token and store its hash
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = hashKey(rawToken);

  const id = uuid();
  await db.insert(deployWebhooks).values({
    id,
    applicationId: params.id,
    token: tokenHash,
    enabled: true,
    createdBy: access.ctx.user.id,
    createdAt: new Date(),
  });

  return json({
    webhook: {
      id,
      enabled: true,
      lastUsedAt: null,
      url: `/api/applications/${params.id}/webhook/trigger`,
      token: rawToken, // returned ONCE — treat like an API key
    },
  });
}

/** DELETE — remove the webhook for this application */
export async function DELETE({ params, cookies }: { params: { id: string }; cookies: any }) {
  const access = await canAccessApplication(cookies, params.id);
  if (!access) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  await db
    .delete(deployWebhooks)
    .where(eq(deployWebhooks.applicationId, params.id));

  return json({ success: true });
}
