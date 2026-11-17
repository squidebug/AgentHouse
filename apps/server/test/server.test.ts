import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { createAgentHouseServer } from '../src/web/http/server';
import { HostClient } from '../src/web/host-client';
import { isAlive } from '../src/shared/kill-tree';
import { forgetWebServer, recordWebServer, runningWebServer, webServerFile } from '../src/web/instance';
import { login, openSocket, plain, request, screenText, sleep, startServer, tempStateDir, waitFor, type TestServer } from './helpers';

let app: TestServer;
let authorization: string;
let origin: string;

before(async () => {
  app = await startServer();
  authorization = await login(app);
  origin = `http://127.0.0.1:${app.port}`;
});

after(async () => {
  await app.close();
});

const codeOf = (url: string) => new URL(url).searchParams.get('code')!;

describe('access control', () => {
  test('the API refuses a request without a token and says what gives a login address', async () => {
    const res = await request(app.port, 'GET', '/api/sessions');
    assert.equal(res.status, 401);
    assert.deepEqual(res.json, { error: '로그인이 필요합니다.', code: 'AUTH_REQUIRED', command: 'pnpm start' });
  });

  test('a wrong or forged token is refused, and no cookie counts, not even with the key in it', async () => {
    const [nonce] = authorization.slice('Bearer '.length).split('.');
    const refused: Array<Record<string, string>> = [{ authorization: 'Bearer wrong' }, { authorization: `Bearer ${nonce}.forged` }, { cookie: `ah_token=${app.key}` }];
    for (const headers of refused) {
      assert.equal((await request(app.port, 'GET', '/api/sessions', { headers })).status, 401, JSON.stringify(headers));
    }
    assert.equal((await request(app.port, 'GET', '/api/sessions', { headers: { authorization } })).status, 200, 'a page token');
    assert.equal((await request(app.port, 'GET', '/api/sessions', { headers: { authorization: `Bearer ${app.key}` } })).status, 200, 'the key of local tools');
  });

  test('a login code works once; the token it gives opens the API and, as a subprotocol, the sockets', async () => {
    const code = codeOf(app.loginUrl());
    const first = await request(app.port, 'POST', '/api/login', { headers: { origin }, body: { code } });
    assert.equal(first.status, 200);
    const token = (first.json as { token: string }).token;
    const again = await request(app.port, 'POST', '/api/login', { headers: { origin }, body: { code } });
    assert.equal(again.status, 401);
    assert.equal((again.json as { code: string }).code, 'LOGIN_EXPIRED', 'spent');
    assert.equal((await request(app.port, 'GET', '/api/auth', { headers: { authorization: `Bearer ${token}` } })).status, 200);

    const socket = await openSocket(app.port, '/ws/events', { origin }, ['agenthouse', `ah-token.${token}`]);
    assert.equal(socket.status, 101);
    assert.equal(socket.ws?.protocol, 'agenthouse', 'the token is never echoed back');
    socket.ws?.close();
    assert.equal((await openSocket(app.port, '/ws/events', { origin }, ['agenthouse'])).status, 401, 'no token');
    assert.equal((await openSocket(app.port, '/ws/events', { origin }, ['agenthouse', 'ah-token.wrong'])).status, 401, 'a wrong one');
  });

  test('login codes go to local tools holding the key only; a page cannot ask for one', async () => {
    const ask = (headers: Record<string, string>) => request(app.port, 'POST', '/auth/code', { headers });
    const given = await ask({ authorization: `Bearer ${app.key}` });
    assert.equal(given.status, 200);
    assert.match((given.json as { url: string }).url, new RegExp(`^http://127\\.0\\.0\\.1:${app.port}/\\?code=[\\w-]+$`));
    assert.equal((await ask({ authorization: `Bearer ${app.key}`, origin })).status, 401, 'asked from a page');
    assert.equal((await ask({ authorization })).status, 401, 'a page token is not the key');
    assert.equal((await ask({})).status, 401);
  });

  test('a login from another origin is refused', async () => {
    const res = await request(app.port, 'POST', '/api/login', { headers: { origin: 'http://evil.example' }, body: { code: codeOf(app.loginUrl()) } });
    assert.equal(res.status, 403);
  });

  test('a Host outside the allowlist is refused (DNS rebinding)', async () => {
    const res = await request(app.port, 'GET', '/api/sessions', { headers: { host: `evil.example:${app.port}`, authorization } });
    assert.equal(res.status, 403);
  });

  test('the address of the old login leads to the page', async () => {
    const res = await request(app.port, 'GET', `/auth?token=${app.key}`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/');
  });

  test('state changes from another origin are refused', async () => {
    const res = await request(app.port, 'POST', '/api/sessions', { headers: { authorization, origin: 'http://evil.example' }, body: { vendor: 'fake' } });
    assert.equal(res.status, 403);
  });

  test('WebSockets from another origin are refused (CSWSH)', async () => {
    const socket = await openSocket(app.port, '/ws/events', { authorization, origin: 'http://evil.example' });
    assert.equal(socket.status, 403);
  });

  test('malformed launch requests are rejected', async () => {
    const res = await request(app.port, 'POST', '/api/sessions', { headers: { authorization, origin }, body: { vendor: 'unknown' } });
    assert.equal(res.status, 400);
  });

  test('the page is served without a token, and a browser still sending the old cookie is told to drop it', async () => {
    const webDist = await tempStateDir();
    writeFileSync(path.join(webDist, 'index.html'), '<!doctype html><title>AgentHouse</title>');
    const client = await HostClient.connect({ stateDir: app.stateDir, spawn: false });
    const site = await createAgentHouseServer({ port: 0, host: client, webDist, claudeSessions: null });
    try {
      const page = await request(site.port, 'GET', '/');
      assert.equal(page.status, 200);
      assert.match(page.text, /AgentHouse/);
      assert.equal(page.headers['set-cookie'], undefined);
      const old = await request(site.port, 'GET', '/', { headers: { cookie: 'ah_token=something' } });
      assert.match(String(old.headers['set-cookie']?.[0]), /^ah_token=; Max-Age=0/);
      assert.equal((await request(site.port, 'GET', '/api/sessions')).status, 401, 'the API behind it is not public');
    } finally {
      await site.close();
      client.close();
      await rm(webDist, { recursive: true, force: true });
    }
  });
});

describe('a session', () => {
  test('runs, mirrors, takes input, survives reconnects and leaves nothing behind', async () => {
    const events = await openSocket(app.port, '/ws/events', { authorization, origin });
    const created = await request(app.port, 'POST', '/api/sessions', { headers: { authorization, origin }, body: { vendor: 'fake', title: '테스트', cols: 100, rows: 30 } });
    assert.equal(created.status, 201);
    const session = created.json as { id: string; pid: number; title: string };
    assert.equal(session.title, '테스트');
    assert.ok(await waitFor(() => events.messages.some((m) => m.type === 'sessions' && (m.sessions as unknown[]).length === 1), 10_000), 'session list pushed');

    // Nobody watches for the first 2.5 s: the startup queries must not stall the CLI.
    await sleep(2500);
    const first = await openSocket(app.port, `/ws/session?id=${session.id}`, { authorization, origin });
    assert.equal(first.status, 101);
    // On a busy machine the CLI may not be up after those 2.5 s: what it prints is waited for, in the
    // snapshot or after it.
    const shown = () => plain(screenText(first.messages));
    assert.ok(await waitFor(() => /fake-agent ready/.test(shown()), 10_000), 'the CLI started');
    assert.ok(await waitFor(() => /REPORT cpr=\d+;\d+/.test(shown()), 10_000), 'cursor position query answered with nobody watching it start');
    const snapshot = shown();
    const childPid = Number(snapshot.match(/REPORT child=(\d+)/)?.[1]);

    first.ws?.send(JSON.stringify({ type: 'claim' }));
    first.ws?.send(JSON.stringify({ type: 'input', data: '\x1b[5;10R' })); // a browser-generated reply: dropped
    const composed = await request(app.port, 'POST', `/api/sessions/${session.id}/compose`, {
      headers: { authorization, origin },
      body: { text: '안녕하세요 AgentHouse\n둘째 줄 ✓', enterDelayMs: 100, quietMs: 100 },
    });
    assert.deepEqual(composed.json, { sessionId: session.id, sent: true, submitted: true });
    assert.ok(await waitFor(() => screenText(first.messages).includes('둘째 줄 ✓'), 10_000), 'Korean multi-line text arrives');
    assert.ok(!screenText(first.messages).includes('5;10R'), 'browser reply did not reach the CLI');

    first.ws?.close();
    await sleep(200);
    const second = await openSocket(app.port, `/ws/session?id=${session.id}`, { authorization, origin });
    await waitFor(() => second.messages.some((m) => m.type === 'snapshot'), 10_000);
    const again = plain(String(second.messages.find((m) => m.type === 'snapshot')?.data));
    assert.match(again, /둘째 줄 ✓/, 'reconnect restores the screen');

    const removed = await request(app.port, 'DELETE', `/api/sessions/${session.id}`, { headers: { authorization, origin } });
    assert.equal(removed.status, 200);
    assert.ok(await waitFor(() => !isAlive(session.pid), 10_000), 'CLI process ended');
    assert.ok(Number.isFinite(childPid) && (await waitFor(() => !isAlive(childPid), 10_000)), 'grandchild (MCP-server stand-in) ended');
    second.ws?.close();
    events.ws?.close();
  });

  test('a missing working folder is reported, not launched', async () => {
    const res = await request(app.port, 'POST', '/api/sessions', {
      headers: { authorization, origin },
      body: { vendor: 'fake', cwd: 'Z:\\does\\not\\exist\\agenthouse' },
    });
    assert.equal(res.status, 400);
    assert.equal((res.json as { code: string }).code, 'CWD_NOT_FOUND');
  });

  test('a long text in Korean is taken up to the length the API allows, not cut off by the size of its bytes', async () => {
    const created = await request(app.port, 'POST', '/api/sessions', { headers: { authorization, origin }, body: { vendor: 'fake', title: 'long-text' } });
    const id = (created.json as { id: string }).id;
    try {
      // 150,000 characters are 450 KB in UTF-8. The work goes nowhere (no such delegate), but the text is read.
      const taken = await request(app.port, 'POST', `/api/sessions/${id}/delegations`, { headers: { authorization, origin }, body: { childId: 'nobody', text: '가'.repeat(150_000) } });
      assert.equal(taken.status, 404);
      const tooLong = await request(app.port, 'POST', `/api/sessions/${id}/delegations`, { headers: { authorization, origin }, body: { childId: 'nobody', text: '가'.repeat(200_001) } });
      assert.equal(tooLong.status, 400, 'past the length the API allows');
    } finally {
      await request(app.port, 'DELETE', `/api/sessions/${id}`, { headers: { authorization, origin } });
    }
  });
});

describe('staying up', () => {
  test('a frame over the limit closes that socket only; the web server keeps serving', async () => {
    const events = await openSocket(app.port, '/ws/events', { authorization, origin });
    const closed = new Promise<number>((resolve) => events.ws?.on('close', (code) => resolve(code)));
    events.ws?.send('x'.repeat(3 * 1024 * 1024));
    assert.equal(await closed, 1009, 'too big');
    assert.equal((await request(app.port, 'GET', '/api/sessions', { headers: { authorization } })).status, 200, 'still serving');
  });

  test('a taken port falls back to the next; with none left, nothing of the server stays behind', async () => {
    const client = await HostClient.connect({ stateDir: app.stateDir, spawn: false });
    try {
      const other = await createAgentHouseServer({ port: app.port, fallbackPorts: [0], host: client, claudeSessions: null });
      assert.notEqual(other.port, app.port);
      await other.close();
      await assert.rejects(createAgentHouseServer({ port: app.port, host: client, claudeSessions: null }), { code: 'EADDRINUSE' });
    } finally {
      client.close();
    }
  });

  test('a second start finds the web server already serving the state folder; a record one left behind is ignored', async () => {
    const dir = await tempStateDir();
    const write = (record: object) => writeFileSync(webServerFile(dir), JSON.stringify(record));
    try {
      assert.equal(await runningWebServer(dir), null, 'none yet');
      // Another live process that gives out login addresses for its key: the one to open.
      write({ pid: process.ppid, port: app.port, url: app.url, key: app.key });
      const running = await runningWebServer(dir);
      assert.equal(running?.port, app.port);
      const opened = await request(app.port, 'POST', '/api/login', { headers: { origin }, body: { code: codeOf(running!.loginUrl) } });
      assert.equal(opened.status, 200, 'its address logs a browser in');
      write({ pid: process.ppid, port: app.port, url: app.url, key: 'not-its-key' });
      assert.equal(await runningWebServer(dir), null, 'something else on that port');
      write({ pid: 2 ** 22 + 7, port: app.port, url: app.url, key: app.key });
      assert.equal(await runningWebServer(dir), null, 'its process has ended');
      recordWebServer(dir, { port: app.port, url: app.url, key: app.key });
      assert.equal(await runningWebServer(dir), null, 'never itself');
      forgetWebServer(dir);
      assert.equal(existsSync(webServerFile(dir)), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
