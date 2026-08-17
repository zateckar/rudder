/**
 * Adoption for one worker.
 *
 * `GET`  lists containers Rudder does not manage. Read-only.
 * `POST` adopts exactly the container ids in the body, and nothing else.
 *
 * Admin only. Adoption creates application rows and decides which team owns
 * them, which is not a per-team operation.
 */
import { json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth';
import { adoptContainers, listAdoptableContainers, type AdoptRequest } from '$lib/server/app-discovery';

export async function GET({ params, cookies }: { params: { id: string }; cookies: any }) {
  await requireAdmin(cookies);
  try {
    return json({ containers: await listAdoptableContainers(params.id) });
  } catch (e: any) {
    console.error('[adopt] Could not list adoptable containers:', e);
    return json({ error: e.message }, { status: 502 });
  }
}

export async function POST({
  params,
  request,
  cookies,
}: {
  params: { id: string };
  request: Request;
  cookies: any;
}) {
  const ctx = await requireAdmin(cookies);

  const body = await request.json().catch(() => null);
  const raw = body?.containers;
  if (!Array.isArray(raw) || raw.length === 0) {
    return json({ error: 'Name at least one container to adopt' }, { status: 400 });
  }

  // Every adoption is attributable to a container id an operator sent. Nothing
  // here walks the worker and decides for itself.
  const requests: AdoptRequest[] = [];
  for (const entry of raw) {
    const containerId = typeof entry === 'string' ? entry : entry?.containerId;
    if (typeof containerId !== 'string' || containerId.length === 0) {
      return json({ error: 'Every entry needs a containerId' }, { status: 400 });
    }
    requests.push({
      containerId,
      name: typeof entry?.name === 'string' ? entry.name : undefined,
      teamId: typeof entry?.teamId === 'string' ? entry.teamId : null,
      domain: typeof entry?.domain === 'string' ? entry.domain : undefined,
    });
  }

  try {
    const result = await adoptContainers(params.id, requests, ctx.user?.id ?? null);
    return json({
      success: result.adopted.length > 0,
      adopted: result.adopted,
      skipped: result.skipped,
      message:
        `Adopted ${result.adopted.length} container${result.adopted.length === 1 ? '' : 's'}` +
        (result.skipped.length > 0 ? `, skipped ${result.skipped.length}` : ''),
    });
  } catch (e: any) {
    console.error('[adopt] Adoption failed:', e);
    return json({ error: e.message }, { status: 500 });
  }
}
