import { json } from '@sveltejs/kit';
import { getRestPodmanClient } from '$lib/server/podman-client';
import { authErrorResponse, requireContainerAccess } from '$lib/server/auth';

const SHELL = '/bin/sh';

/**
 * The shell named as a whole path, not as the beginning of a longer one.
 *
 * A plain substring test matched `/bin/shx` as well, so `cat /bin/shx` — an
 * ordinary command failing for an ordinary reason — was read as "this image has
 * no shell", ran a second time as argv, and reported `shell: null` for an image
 * that has one. The path may be quoted or followed by a colon, so the boundary
 * is "not another path character".
 */
const SHELL_PATH = /\/bin\/sh(?![\w./-])/;

/**
 * Whether the shell itself was what could not be executed.
 *
 * Podman reports a missing executable in the exec's output with a non-zero exit
 * rather than as a transport error, so the only way to tell "this image has no
 * shell" from "your command failed" is to read the message back and check that
 * the thing it could not find is the shell.
 */
function shellIsMissing(result: { stdout: string; stderr: string; exitCode: number }): boolean {
  if (result.exitCode === 0) return false;
  // Both streams: the runtime reports this on stderr, but a TTY-less exec that
  // answered without frame headers lands in stdout.
  const output = `${result.stdout}\n${result.stderr}`;
  // A line beginning `sh:` or `/bin/sh:` is the shell itself talking, which
  // proves it is there: `/bin/sh: 1: /app/start: not found` means the script is
  // missing, not the interpreter. Re-running that as argv would execute the
  // command a second time to no purpose.
  if (/(?:^|\n)\s*(?:\/bin\/)?sh:/.test(output)) return false;
  if (!SHELL_PATH.test(output)) return false;
  return /executable file .*not found|no such file or directory/i.test(output);
}

export async function POST({ params, request, cookies }: { params: { id: string }; request: Request; cookies: any }) {
  let container, worker;
  try {
    ({ container, worker } = await requireContainerAccess(cookies, params.id));
  } catch (error) {
    return authErrorResponse(error);
  }

  const { command } = await request.json();

  if (!command || typeof command !== 'string') {
    return json({ error: 'Command required' }, { status: 400 });
  }

  let client: ReturnType<typeof getRestPodmanClient>;
  try {
    client = getRestPodmanClient(worker);
  } catch (e: any) {
    return json({ error: `Client creation failed: ${e.message}` }, { status: 400 });
  }

  try {
    // Run through a shell, because that is what the terminal claims to be and
    // what anyone typing `grep x | wc -l` expects. Splitting on whitespace and
    // exec'ing argv directly passed `&&`, `|` and `>` to the program as literal
    // arguments, which fails silently and confusingly.
    let result = await client.execContainerHttp(
      container.containerId,
      [SHELL, '-c', command],
    );
    let shell: string | null = SHELL;

    // Distroless and scratch images have no shell at all. Fall back to argv, so
    // those containers keep working, and say so rather than leaving the user to
    // wonder why their pipe did nothing.
    if (shellIsMissing(result)) {
      shell = null;
      result = await client.execContainerHttp(
        container.containerId,
        command.trim().split(/\s+/),
      );
    }

    client.destroy();

    return json({
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      shell,
    });
  } catch (error: any) {
    console.error('Exec error:', {
      message: error.message,
      code: error.code,
    });
    client.destroy();
    return json({ error: error.message, code: error.code }, { status: 500 });
  }
}

/**
 * Interactive terminals do not run through this route.
 *
 * This handler used to return a bare 101, which SvelteKit passes through as an
 * ordinary response — no upgrade ever happened and the socket was never
 * connected. The working path is `/api/terminal/ws`, whose upgrade is handled
 * on the HTTP server; see `src/lib/server/ws/registry.ts`.
 */
export async function GET({ params, cookies }: { params: { id: string }; cookies: any }) {
  try {
    await requireContainerAccess(cookies, params.id);
  } catch (error) {
    return authErrorResponse(error);
  }

  return json(
    {
      error:
        'Interactive terminals use /api/terminal/ws. Obtain a token from ' +
        'POST /api/terminal/token and connect there.',
    },
    { status: 410 },
  );
}
