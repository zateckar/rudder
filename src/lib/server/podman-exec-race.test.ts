import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import net from 'node:net';
import { createPodmanClient, PodmanApiError, type PodmanClient } from './podman';

/**
 * Running two commands on one worker in one visit.
 *
 * `/exec/{id}/start` is a hijacked connection: Podman takes the socket over for
 * the duration of the command and closes it at the end. The keep-alive agent
 * does not know that, so it can hand the same socket to the next request in the
 * window before the FIN is processed — and Node reports that as `Error:
 * aborted`, with no status and no body.
 *
 * The exit-code lookup has absorbed this for a while by retrying. What it did
 * not cover is the *next command's* exec creation, which is the first request
 * after the hijacked one and lands on the same dead socket. That is what the
 * application firewall panel does — `cscli alerts list`, then `cscli decisions
 * list` — and it failed with "Could not reach the worker: aborted" on an
 * occasional load, blaming a worker that was answering normally.
 *
 * Served by a raw TCP socket rather than `node:http`, because the whole point is
 * a response that stops halfway and a connection that dies without a FIN. An
 * HTTP server is built to prevent exactly that.
 */

/** Frame `text` as Podman frames stdout on a non-TTY exec. */
function stdoutFrame(text: string): Buffer {
  const payload = Buffer.from(text, 'utf-8');
  const header = Buffer.alloc(8);
  header[0] = 1;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/** Whether the next exec creation should die mid-response. */
let breakNextCreate = false;
/** How many times an exec instance was asked for. */
let createCount = 0;
/** The `Connection` header the start request carried. */
let startConnectionHeader: string | undefined;

let server: net.Server;
let client: PodmanClient;

function respond(socket: net.Socket, status: string, body: Buffer, contentType: string): void {
  socket.write(
    `HTTP/1.1 ${status}\r\nContent-Type: ${contentType}\r\nContent-Length: ${body.length}\r\n\r\n`,
  );
  socket.write(body);
}

function handle(socket: net.Socket, method: string, path: string): void {
  const json = (status: string, value: unknown) =>
    respond(socket, status, Buffer.from(JSON.stringify(value)), 'application/json');

  if (/^\/containers\/[^/]+\/exec$/.test(path) && method === 'POST') {
    createCount += 1;

    if (path.startsWith('/containers/missing/')) {
      json('404 Not Found', {
        cause: 'no such container',
        message: 'no container with name or ID "missing" found: no such container',
        response: 404,
      });
      return;
    }

    if (breakNextCreate) {
      breakNextCreate = false;
      // The request is read and the connection then goes away without a byte of
      // response — which is what a request dispatched onto a socket the worker
      // was already closing looks like from the client end.
      socket.destroy();
      return;
    }

    json('200 OK', { Id: 'exec-1' });
    return;
  }

  if (/^\/exec\/[^/]+\/start$/.test(path) && method === 'POST') {
    respond(socket, '200 OK', stdoutFrame('[]\n'), 'application/vnd.docker.multiplexed-stream');
    // Podman closes a hijacked connection when the command ends. Closing here
    // too is what makes this a reproduction rather than a well-behaved stub.
    socket.end();
    return;
  }

  if (/^\/exec\/[^/]+\/json$/.test(path)) {
    json('200 OK', { Running: false, ExitCode: 0 });
    return;
  }

  json('404 Not Found', { message: 'not found' });
}

beforeAll(async () => {
  server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);

    socket.on('error', () => {
      /* the client hanging up mid-request is the case under test */
    });

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      // One request at a time, which is all a keep-alive agent sends.
      for (;;) {
        const headEnd = buffer.indexOf('\r\n\r\n');
        if (headEnd === -1) return;

        const head = buffer.subarray(0, headEnd).toString('utf-8');
        const [requestLine, ...headerLines] = head.split('\r\n');
        const [method, target] = requestLine.split(' ');

        const headers = new Map<string, string>();
        for (const line of headerLines) {
          const at = line.indexOf(':');
          if (at > 0) {
            headers.set(line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim());
          }
        }

        const length = Number(headers.get('content-length') ?? '0');
        const bodyStart = headEnd + 4;
        if (buffer.length < bodyStart + length) return;
        buffer = buffer.subarray(bodyStart + length);

        const path = (target ?? '').split('?')[0];
        if (/^\/exec\/[^/]+\/start$/.test(path)) {
          startConnectionHeader = headers.get('connection');
        }
        handle(socket, method ?? 'GET', path);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as net.AddressInfo;
  client = createPodmanClient({ apiUrl: `http://127.0.0.1:${address.port}` });
});

afterAll(() => {
  client.destroy();
  server.close();
});

beforeEach(() => {
  breakNextCreate = false;
  createCount = 0;
  startConnectionHeader = undefined;
});

describe('execContainerHttp on a socket that died under it', () => {
  test('creates the exec again rather than reporting the worker unreachable', async () => {
    breakNextCreate = true;

    const result = await client.execContainerHttp('crowdsec', ['cscli', 'decisions', 'list'], {
      attachStdout: true,
      attachStderr: true,
      tty: false,
    });

    expect(result.stdout).toBe('[]\n');
    expect(result.exitCodeKnown).toBe(true);
    expect(result.exitCode).toBe(0);
    // Once for the socket that was already gone, once for the one that worked.
    expect(createCount).toBe(2);
  });

  test('does not repeat a command the worker actually refused', async () => {
    // A 404 is an answer. Retrying it would ask a worker that has already said
    // the container is gone to say so twice, and would put a delay in front of
    // every genuinely-missing container.
    const failure = client.execContainerHttp('missing', ['cscli', 'version']);

    await expect(failure).rejects.toThrow(PodmanApiError);
    expect(createCount).toBe(1);
  });

  test('tells Podman not to keep the hijacked connection alive', async () => {
    // The cause rather than the cure: a connection Podman is going to close at
    // the end of the command must not go back into the agent's pool, or the
    // next request inherits it.
    await client.execContainerHttp('crowdsec', ['cscli', 'version']);

    expect(startConnectionHeader).toBe('close');
  });
});
