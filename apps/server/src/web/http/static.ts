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

// Defense in depth for a page that can type into shells: only the app's own
// scripts run (no inline or injected ones), it cannot be framed, and it sends
// no referrer. Styles stay inline-capable because MUI injects <style> tags.
const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; " +
    "connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
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
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  const target = path.resolve(root, `.${decoded}`);
  if (target !== root && !target.startsWith(root + path.sep)) return false;

  let file = target;
  if (!(await isFile(file))) {
    if (path.extname(decoded)) return false;
    file = path.join(root, 'index.html');
    if (!(await isFile(file))) return false;
  }
  const hashed = /[.-][A-Za-z0-9_-]{8,}\.(js|css|woff2?)$/.test(file);
  // Read before any header goes out: a file a rebuild just replaced fails here, while the reply can still be an error.
  const body = await readFile(file);
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
    'x-content-type-options': 'nosniff',
    ...SECURITY_HEADERS,
  });
  res.end(body);
  return true;
}
