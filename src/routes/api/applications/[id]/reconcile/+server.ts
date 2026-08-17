/**
 * Reconcile one application on demand.
 *
 * `GET` recomputes the diff for this application's worker right now, rather than
 * reading the last timer pass. Read-only.
 *
 * `POST` corrects the drift the only way `missing` and `stale` can be corrected:
 * by deploying. There is no separate repair path, and there should not be — a
 * deploy already creates what is absent, replaces what was built from different
 * configuration, and verifies the result before routing to it. Writing a second
 * mechanism to patch containers into shape would be a second thing to keep
 * correct, and the less-tested of the two.
 *
 * Neither verb can remove anything. Orphan removal is human-gated and lives
 * elsewhere by design.
 */
import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { executeApplicationDeploy } from '$lib/server/deploy';
import { canAccessApplication, requireAuth } from '$lib/server/auth';
import { actionable, reconcileWorker } from '$lib/server/reconcile';

export async function GET({ params, cookies }: { params: { id: string }; cookies: any }) {
  await requireAuth(cookies);

  const access = await canAccessApplication(cookies, params.id);
  if (!access) return json({ error: 'Application not found' }, { status: 404 });

  const { application: app } = access;
  if (!app.workerId) return json({ error: 'No worker assigned to this application' }, { status: 400 });

  const worker = await db.select().from(workers).where(eq(workers.id, app.workerId)).get();
  if (!worker) return json({ error: 'Worker not found' }, { status: 404 });

  try {
    const report = await reconcileWorker(worker, { apply: false });
    // Foreign containers are the worker's business, not this application's, and
    // it can do nothing about them.
    const drift = actionable(report.drift).filter((d) => d.appId === params.id);
    const error = report.errors.find((e) => e.appId === params.id);
    return json({
      ranAt: report.ranAt,
      drift,
      clean: drift.length === 0 && !error,
      unreconcilable: error?.message ?? null,
    });
  } catch (e: any) {
    console.error('[reconcile] On-demand pass failed:', e);
    return json({ error: e.message }, { status: 502 });
  }
}

export async function POST({ params, cookies }: { params: { id: string }; cookies: any }) {
  const ctx = await requireAuth(cookies);

  const access = await canAccessApplication(cookies, params.id);
  if (!access) return json({ error: 'Application not found' }, { status: 404 });

  try {
    const result = await executeApplicationDeploy(params.id, ctx.user?.id ?? null);
    if (!result.success) {
      return json({ error: result.message }, { status: result.statusCode || 500 });
    }
    return json({ success: true, message: 'Reconciled by deploying the current configuration' });
  } catch (e: any) {
    console.error('[reconcile] Corrective deploy failed:', e);
    return json({ error: e.message }, { status: 500 });
  }
}
