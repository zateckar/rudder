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
  const { worker, volume } = await requireAppVolume(application, event.params.name!, 'back up');

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

  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        stream.on('data', (chunk: Buffer) => {
          controller.enqueue(new Uint8Array(chunk));
          // Backpressure, and the whole reason this is streamed at all. The
          // worker is typically on the LAN and the browser at the other end of
          // a WAN link, so without pausing, every chunk Podman can produce
          // queues in memory here and the control plane holds the entire
          // archive after all.
          if ((controller.desiredSize ?? 1) <= 0) stream.pause();
        });
        stream.on('end', () => {
          controller.close();
          void releaseOnce();
        });
        stream.on('error', (err) => {
          controller.error(err);
          void releaseOnce();
        });
      },
      pull() {
        // The consumer has drained below the mark. A `resume` on a stream that
        // was never paused is a no-op, so this needs no state of its own.
        stream.resume();
      },
      cancel() {
        // The browser went away mid-download. Without this the helper container
        // would sit on the worker holding the volume open until its lock expired.
        stream.destroy();
        return releaseOnce();
      },
    },
    // Counted in bytes rather than chunks: a chunk-counting default would hold
    // one chunk of whatever size Podman happened to send, which says nothing
    // about memory. A megabyte is enough to keep the socket busy.
    new ByteLengthQueuingStrategy({ highWaterMark: 1024 * 1024 }),
  );

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
