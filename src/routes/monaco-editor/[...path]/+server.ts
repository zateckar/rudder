import { readFile } from 'fs/promises';
import { join } from 'path';
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

export const GET: RequestHandler = async ({ params }) => {
  const filePath = params.path;
  const absPath = join(process.cwd(), 'node_modules', 'monaco-editor', filePath);

  try {
    const content = await readFile(absPath);
    const ext = filePath.slice(filePath.lastIndexOf('.'));
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    return new Response(content, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
      },
    });
  } catch {
    return new Response('Not Found', { status: 404 });
  }
};
