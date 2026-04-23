import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { deployWebhooks } from '$lib/db/schema';
import { eq, and } from 'drizzle-orm';
import { hashKey } from '$lib/server/encryption';
import { executeApplicationDeploy } from '$lib/server/deploy';

/**
 * POST — unauthenticated webhook trigger endpoint for CI/CD.
 *
 * Auth via:
 *   - Authorization: Bearer <token>
 *   - ?token=<token> query parameter
 */
export async function POST({ params, request, url }: { params: { id: string }; request: Request; url: URL }) {
  const applicationId = params.id;

  // Extract token from Authorization header or query param
  let rawToken: string | null = null;

  const authHeader = request.headers.get('authorization');
  if (authHeader && authHeader.startsWith('Bearer ')) {
    rawToken = authHeader.slice(7).trim();
  }

  if (!rawToken) {
    rawToken = url.searchParams.get('token');
  }

  if (!rawToken) {
    return json({ error: 'Missing authentication token' }, { status: 401 });
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
