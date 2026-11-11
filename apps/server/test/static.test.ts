import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { serveStatic } from '../src/http/static';

const parent = mkdtempSync(path.join(os.tmpdir(), 'agenthouse-static-'));
const root = path.join(parent, 'dist');
mkdirSync(path.join(root, 'assets'), { recursive: true });
writeFileSync(path.join(root, 'index.html'), '<!doctype html><title>app</title>');
writeFileSync(path.join(root, 'assets', 'index-AvzqXkOT.js'), 'console.log(1)');
writeFileSync(path.join(parent, 'secret.txt'), 'outside the web root');
after(() => rmSync(parent, { recursive: true, force: true }));

function fakeResponse() {
  const reply = { status: 0, headers: {} as Record<string, string>, body: '' };
  const res = {
    writeHead(status: number, headers: Record<string, string>) {
      reply.status = status;
      reply.headers = headers;
    },
    end(body: Buffer) {
      reply.body = body.toString('utf8');
    },
  } as unknown as ServerResponse;
  return { res, reply };
}

describe('static files', () => {
  test('pages come with a CSP that forbids inline scripts and framing', async () => {
    const { res, reply } = fakeResponse();
    assert.equal(await serveStatic(root, '/', res), true);
    assert.match(reply.body, /<title>app/);
    assert.match(reply.headers['content-security-policy'] ?? '', /script-src 'self';/);
    assert.match(reply.headers['content-security-policy'] ?? '', /frame-ancestors 'none'/);
    assert.equal(reply.headers['referrer-policy'], 'no-referrer');
  });

  test('client routes fall back to index.html; hashed assets are cached for good', async () => {
    const page = fakeResponse();
    assert.equal(await serveStatic(root, '/some/route', page.res), true);
    assert.match(page.reply.body, /<title>app/);
    const asset = fakeResponse();
    assert.equal(await serveStatic(root, '/assets/index-AvzqXkOT.js', asset.res), true);
    assert.match(asset.reply.headers['cache-control'] ?? '', /immutable/);
    assert.equal(await serveStatic(root, '/missing.js', fakeResponse().res), false);
  });

  test('nothing outside the web root is served', async () => {
    for (const attempt of ['/../secret.txt', '/%2e%2e/secret.txt', '/..%5csecret.txt', '/%E0%A4%A']) {
      assert.equal(await serveStatic(root, attempt, fakeResponse().res), false, attempt);
    }
  });
});
