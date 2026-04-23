import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$lib/db';
import { workers, users } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { getRestPodmanClient } from '$lib/server/podman-client';

export const GET: RequestHandler = async ({ params, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.role !== 'admin') return json({ error: 'Admin access required' }, { status: 403 });

  const worker = await db.select().from(workers).where(eq(workers.id, params.id)).get();
  if (!worker) return json({ error: 'Worker not found' }, { status: 404 });

  try {
    const client = getRestPodmanClient(worker);
    try {
      const images = await client.listImages();
      return json({
        images: images.map((img: any) => ({
          id: img.Id,
          repoTags: img.RepoTags || [],
          size: img.Size || 0,
          created: img.Created,
        })),
      });
    } finally {
      client.destroy();
    }
  } catch (error: any) {
    return json({ error: error.message }, { status: 500 });
  }
};

export const POST: RequestHandler = async ({ params, request, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.role !== 'admin') return json({ error: 'Admin access required' }, { status: 403 });

  const worker = await db.select().from(workers).where(eq(workers.id, params.id)).get();
  if (!worker) return json({ error: 'Worker not found' }, { status: 404 });

  const body = await request.json();
  const imageName = body.image;
  if (!imageName || typeof imageName !== 'string') {
    return json({ error: 'Image name is required' }, { status: 400 });
  }

  try {
    const client = getRestPodmanClient(worker);
    try {
      await client.pullImage(imageName);
      return json({ success: true, image: imageName });
    } finally {
      client.destroy();
    }
  } catch (error: any) {
    return json({ error: error.message }, { status: 500 });
  }
};

export const DELETE: RequestHandler = async ({ params, url, cookies }) => {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  const userId = sessionId ? await validateSession(sessionId) : null;
  if (!userId) return json({ error: 'Unauthorized' }, { status: 401 });

  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (!user || user.role !== 'admin') return json({ error: 'Admin access required' }, { status: 403 });

  const worker = await db.select().from(workers).where(eq(workers.id, params.id)).get();
  if (!worker) return json({ error: 'Worker not found' }, { status: 404 });

  const imageId = url.searchParams.get('image');
  if (!imageId) {
    return json({ error: 'Image ID is required (?image=...)' }, { status: 400 });
  }

  try {
    const client = getRestPodmanClient(worker);
    try {
      await client.removeImage(imageId);
      return json({ success: true });
    } finally {
      client.destroy();
    }
  } catch (error: any) {
    return json({ error: error.message }, { status: 500 });
  }
};
