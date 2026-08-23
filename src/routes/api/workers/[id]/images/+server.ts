import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withPodman } from '$lib/server/podman-client';
import { requireWorker, route } from '$lib/server/auth';

export const GET: RequestHandler = route(async (event) => {
  const { worker } = await requireWorker(event, event.params.id!);

  const images = await withPodman(worker, (c) => c.listImages());

  return json({
    images: images.map((img: any) => ({
      id: img.Id,
      repoTags: img.RepoTags || [],
      size: img.Size || 0,
      created: img.Created,
    })),
  });
});

export const POST: RequestHandler = route(async (event) => {
  const { worker } = await requireWorker(event, event.params.id!);

  const body = await event.request.json();
  const imageName = body.image;
  if (!imageName || typeof imageName !== 'string') {
    return json({ error: 'Image name is required' }, { status: 400 });
  }

  await withPodman(worker, (c) => c.pullImage(imageName));
  return json({ success: true, image: imageName });
});

export const DELETE: RequestHandler = route(async (event) => {
  const { worker } = await requireWorker(event, event.params.id!);

  const imageId = event.url.searchParams.get('image');
  if (!imageId) {
    return json({ error: 'Image ID is required (?image=...)' }, { status: 400 });
  }

  // Podman refuses to remove an image a container still references. `route()`
  // turns that PodmanApiError into its own 409 rather than a 500 — the operator
  // can act on "still in use"; they cannot act on "internal server error".
  await withPodman(worker, (c) => c.removeImage(imageId));
  return json({ success: true });
});
