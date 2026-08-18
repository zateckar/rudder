import { readFile } from 'fs/promises';
import { join, resolve, sep, extname } from 'path';
import type { RequestHandler } from './$types';

const MIME_TYPES: Record<string, string> = {
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

/**
 * The one directory this route may serve, resolved once.
 *
 * Everything below is about the fact that `params.path` is attacker-controlled
 * and arrives *decoded*. `join` resolves `..` rather than rejecting it, and the
 * URL parser only normalizes literal `..` segments — `%2e%2e%2f` survives
 * parsing and becomes `../` in the param. Joining that onto a base is therefore
 * an unauthenticated read of any file the process can open, which on this
 * deployment includes `data/.secrets.json` (the ENCRYPTION_KEY) and the SQLite
 * database itself.
 */
const ROOT = resolve(process.cwd(), 'node_modules', 'monaco-editor');

export const GET: RequestHandler = async ({ params }) => {
  const filePath = params.path;
  const absPath = resolve(join(ROOT, filePath));

  // Containment is checked after resolution, because that is the only point at
  // which `..` has been collapsed. The separator guards against a sibling
  // directory whose name merely starts with ROOT ("monaco-editor-x").
  if (absPath !== ROOT && !absPath.startsWith(ROOT + sep)) {
    return new Response('Not Found', { status: 404 });
  }

  // Serve only the asset kinds Monaco actually loads. Without this the route
  // hands out any file inside the package — including anything a future
  // dependency drops there — as application/octet-stream.
  const ext = extname(absPath).toLowerCase();
  const contentType = MIME_TYPES[ext];
  if (!contentType) {
    return new Response('Not Found', { status: 404 });
  }

  try {
    const content = await readFile(absPath);

    return new Response(new Uint8Array(content), {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return new Response('Not Found', { status: 404 });
  }
};
