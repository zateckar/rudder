import { json } from '@sveltejs/kit';
import { executeApplicationDeploy } from '#lib/server/deploy.ts';
import { canAccessApplication, requireAuth } from '#lib/server/auth.ts';
import { applicationTask } from '#lib/server/application-operations.ts';
import { operationResponse } from '#lib/server/operation-http.ts';

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
    return await operationResponse(request, applicationTask(app, 'scale', ctx.user.id),
      (reportProgress) => executeApplicationDeploy(params.id, ctx.user.id, { replicas, reportProgress }),
      (result, operationId) => result.success
        ? json({ success: true, message: `Scaled to ${replicas} replica${replicas !== 1 ? 's' : ''}`, operationId })
        : json({ error: result.message, operationId }, { status: result.statusCode || 500 }));
  } catch (error: any) {
    console.error('Scale error:', error);
    return json({ error: error.message }, { status: 500 });
  }
}
