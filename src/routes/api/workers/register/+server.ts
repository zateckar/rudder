import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';

export async function POST({ request }: { request: Request }) {
  // Require a shared secret for worker self-registration
  const registrationSecret = env.WORKER_REGISTRATION_SECRET;
  if (!registrationSecret) {
    return json({ error: 'Worker registration is not configured' }, { status: 503 });
  }

  const authHeader = request.headers.get('authorization');
  const token = authHeader?.replace('Bearer ', '') || (await request.json().catch(() => ({}))).token;

  if (!token || token !== registrationSecret) {
    return json({ error: 'Unauthorized - invalid registration token' }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const { hostname, caCert, clientCert, clientKey } = body;

  if (!hostname) {
    return json({ error: 'Hostname required' }, { status: 400 });
  }

  const worker = await db.select().from(workers).where(eq(workers.hostname, hostname)).get();

  if (!worker) {
    return json({ error: 'Worker not found - must be provisioned first' }, { status: 404 });
  }

  await db.update(workers)
    .set({
      podmanApiUrl: `https://${hostname}:8443`,
      podmanCaCert: caCert || null,
      podmanClientCert: clientCert || null,
      podmanClientKey: clientKey || null,
    })
    .where(eq(workers.id, worker.id));

  return json({ success: true, message: 'Worker registered successfully' });
}
