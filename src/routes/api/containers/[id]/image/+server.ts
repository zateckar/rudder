import { json } from '@sveltejs/kit';
import { db } from '$lib/db';
import { containers, workers } from '$lib/db/schema';
import { eq } from 'drizzle-orm';
import { getRestPodmanClient } from '$lib/server/podman-client';

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

export async function GET({ params, cookies }: { params: { id: string }; cookies: any }) {
  const { getSessionIdFromCookies, validateSession } = await import('$lib/auth');

  const sessionId = getSessionIdFromCookies(cookies);
  if (!sessionId || !(await validateSession(sessionId))) {
    return json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dbContainer = await db
    .select()
    .from(containers)
    .where(eq(containers.id, params.id))
    .get();

  if (!dbContainer || !dbContainer.workerId) {
    return json({ error: 'Container not found' }, { status: 404 });
  }

  const worker = await db
    .select()
    .from(workers)
    .where(eq(workers.id, dbContainer.workerId))
    .get();

  if (!worker) {
    return json({ error: 'Worker not found' }, { status: 404 });
  }

  try {
    const client = getRestPodmanClient(worker);

    const [inspect, history] = await Promise.all([
      client.getImageJson(dbContainer.image),
      client.getImageHistory(dbContainer.image),
    ]);
    client.destroy();

    const repoTag = inspect.RepoTags?.[0] ?? dbContainer.image;
    const [name, tag] = repoTag.includes(':') ? repoTag.split(':') : [repoTag, 'latest'];

    return json({
      name,
      tag,
      fullName: repoTag,
      digest: inspect.RepoDigests?.[0] ?? null,
      created: inspect.Created,
      size: inspect.Size,
      sizeHuman: formatBytes(inspect.Size),
      virtualSize: inspect.VirtualSize,
      virtualSizeHuman: formatBytes(inspect.VirtualSize ?? inspect.Size),
      architecture: inspect.Architecture,
      os: inspect.Os,
      exposedPorts: Object.keys(inspect.Config?.ExposedPorts ?? {}),
      env: (inspect.Config?.Env ?? []).filter(
        (e) => !e.startsWith('PATH=') && !e.startsWith('HOME=')
      ),
      cmd: inspect.Config?.Cmd ?? [],
      entrypoint: inspect.Config?.Entrypoint ?? [],
      workingDir: inspect.Config?.WorkingDir ?? '',
      labels: inspect.Config?.Labels ?? {},
      history: history.map((h) => ({
        id: h.Id?.substring(0, 12) ?? '<missing>',
        created: h.Created,
        createdAt: new Date(h.Created * 1000).toISOString(),
        createdBy: h.CreatedBy
          .replace('/bin/sh -c #(nop) ', '')
          .replace('/bin/sh -c ', 'RUN ')
          .trim(),
        size: h.Size,
        sizeHuman: formatBytes(h.Size ?? 0),
        comment: h.Comment,
      })),
    });
  } catch (error: any) {
    console.error('Image details error:', error);
    return json({ error: error.message }, { status: 500 });
  }
}
