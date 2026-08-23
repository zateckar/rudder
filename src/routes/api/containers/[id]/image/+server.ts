import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withPodman } from '$lib/server/podman-client';
import { requireContainer, route } from '$lib/server/auth';
import { formatBytes } from '$lib/format';



export const GET: RequestHandler = route(async (event) => {
  const { container: dbContainer, worker } = await requireContainer(event, event.params.id!);

  const [inspect, history] = await withPodman(worker, (client) =>
    Promise.all([
      client.getImageJson(dbContainer.image),
      client.getImageHistory(dbContainer.image),
    ]),
  );

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
});
