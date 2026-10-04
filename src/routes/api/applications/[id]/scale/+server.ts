import { json } from '@sveltejs/kit';
import { executeApplicationDeploy } from '$lib/server/deploy';
import { canAccessApplication, requireAuth } from '$lib/server/auth';

export async function PATCH({ params, request, cookies }: { params: { id: string }; request: Request; cookies: any }) {
  const ctx = await requireAuth(cookies);

  const access = await canAccessApplication(cookies, params.id);
  if (!access) {
    return json({ error: 'Application not found' }, { status: 404 });
  }

  const { application: app } = access;

  const body = await request.json();
  const replicas = body.replicas;

  if (typeof replicas !== 'number' || replicas < 1 || replicas > 10 || !Number.isInteger(replicas)) {
    return json({ error: 'Replicas must be an integer between 1 and 10' }, { status: 400 });
  }

  if (app.type !== 'single') {
    return json({ error: 'Scaling replicas is only supported for single container applications' }, { status: 400 });
  }

  // Validate the requested plan under the deployment locks before saving it.
  try {
    const result = await executeApplicationDeploy(params.id, ctx.user?.id ?? null, { replicas });
    if (!result.success) {
      return json({ error: result.message }, { status: result.statusCode || 500 });
    }
    return json({ success: true, message: `Scaled to ${replicas} replica${replicas !== 1 ? 's' : ''}` });
  } catch (error: any) {
    console.error('Scale error:', error);
    return json({ error: error.message }, { status: 500 });
  }
}
