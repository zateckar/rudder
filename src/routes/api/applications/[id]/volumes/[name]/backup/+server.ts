import type { RequestHandler } from './$types';
import { requireApplication, route } from '$lib/server/auth';
import { requireAppVolume } from '$lib/server/app-volumes';
import { backupVolume } from '$lib/server/volume-ops';
import { toDnsLabel } from '$lib/server/domains';

/**
 * Stream a volume's contents out as a tar archive.
 *
 * Streamed rather than buffered end to end: a volume is arbitrarily large, and
 * the control plane must not hold one in memory to hand it to the browser. The
 * helper container on the worker and the Podman client behind the stream are
 * released when the response body closes — including when the client disconnects
 * mid-download, which `cancel` covers.
 *
 * The application does not need to be stopped. Reading a volume under a running
 * container gives an archive of whatever was on disk at the time, which is the
 * ordinary caveat of any live backup and worth far more than refusing to take
 * one.
 */
export const GET: RequestHandler = route(async (event) => {
  const { application } = await requireApplication(event, event.params.id!);
  const { worker, volume } = await requireAppVolume(application, event.params.name!);

  if (!volume.present) {
    return new Response(
      JSON.stringify({
        error:
          `"${volume.name}" does not exist on worker "${worker.name}" yet. A volume is created ` +
          `the first time a container mounts it, so deploy the application before backing it up.`,
      }),
      { status: 409, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const { stream, release } = await backupVolume(worker, application.id, volume.name);

  let released = false;
  const releaseOnce = () => {
    if (released) return Promise.resolve();
    released = true;
    return release();
  };

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
      stream.on('end', () => {
        controller.close();
        void releaseOnce();
      });
      stream.on('error', (err) => {
        controller.error(err);
        void releaseOnce();
      });
    },
    cancel() {
      // The browser went away mid-download. Without this the helper container
      // would sit on the worker holding the volume open until its lock expired.
      stream.destroy();
      return releaseOnce();
    },
  });

  // Both parts through `toDnsLabel`: a bare compose volume name comes straight
  // from a manifest, and this value is interpolated into a response header.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${toDnsLabel(application.name)}-${toDnsLabel(volume.label)}-${stamp}.tar`;

  return new Response(body, {
    headers: {
      'Content-Type': 'application/x-tar',
      'Content-Disposition': `attachment; filename="${filename}"`,
      // The size is not known until the stream ends, and a wrong
      // Content-Length would truncate the archive.
      'Cache-Control': 'no-store',
    },
  });
});
