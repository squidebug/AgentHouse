import { readFile, stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import path from 'node:path';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/** Serves the built web app; unknown paths get index.html so client routes work. */
export async function serveStatic(root: string, pathname: string, res: ServerResponse): Promise<boolean> {
  const decoded = decodeURIComponent(pathname);
  const target = path.resolve(root, `.${decoded}`);
  if (target !== root && !target.startsWith(root + path.sep)) return false;

  let file = target;
  if (!(await isFile(file))) {
    if (path.extname(decoded)) return false;
    file = path.join(root, 'index.html');
    if (!(await isFile(file))) return false;
  }
  const hashed = /[.-][A-Za-z0-9_-]{8,}\.(js|css|woff2?)$/.test(file);
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
  });
  res.end(await readFile(file));
  return true;
}
