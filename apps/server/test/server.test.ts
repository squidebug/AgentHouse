import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { after, before, describe, test } from 'node:test';
import { createAgentHouseServer } from '../src/web/http/server';
import { HostClient } from '../src/web/host-client';
import { isAlive } from '../src/shared/kill-tree';
import { forgetWebServer, recordWebServer, runningWebServer, webServerFile } from '../src/web/instance';
import { login, openSocket, plain, request, screenText, sleep, startServer, tempStateDir, waitFor, type TestServer } from './helpers';

let app: TestServer;
let cookie: string;
let origin: string;

before(async () => {
  app = await startServer();
  cookie = await login(app.port, app.token);
  origin = `http://127.0.0.1:${app.port}`;
});

after(async () => {
  await app.close();
});

describe('access control', () => {
  test('requests without the token are refused', async () => {
    assert.equal((await request(app.port, 'GET', '/api/sessions')).status, 401);
  });

  test('a wrong token is refused', async () => {
    assert.equal((await request(app.port, 'GET', '/auth?token=wrong')).status, 401);
  });

  test('a Host outside the allowlist is refused (DNS rebinding)', async () => {
    const res = await request(app.port, 'GET', `/auth?token=${app.token}`, { headers: { host: `evil.example:${app.port}` } });
    assert.equal(res.status, 403);
  });

  test('the login sets an HttpOnly, SameSite=Strict cookie', async () => {
    const res = await request(app.port, 'GET', `/auth?token=${app.token}`);
    assert.equal(res.status, 302);
    assert.match(String(res.headers['set-cookie']?.[0]), /HttpOnly; SameSite=Strict/);
  });

  test('state changes from another origin are refused', async () => {
    const res = await request(app.port, 'POST', '/api/sessions', { headers: { cookie, origin: 'http://evil.example' }, body: { vendor: 'fake' } });
    assert.equal(res.status, 403);
  });

  test('WebSockets from another origin are refused (CSWSH)', async () => {
    const socket = await openSocket(app.port, '/ws/events', { cookie, origin: 'http://evil.example' });
    assert.equal(socket.status, 403);
  });

  test('malformed launch requests are rejected', async () => {
    const res = await request(app.port, 'POST', '/api/sessions', { headers: { cookie, origin }, body: { vendor: 'unknown' } });
    assert.equal(res.status, 400);
  });
});

describe('a session', () => {
  test('runs, mirrors, takes input, survives reconnects and leaves nothing behind', async () => {
    const events = await openSocket(app.port, '/ws/events', { cookie, origin });
    const created = await request(app.port, 'POST', '/api/sessions', { headers: { cookie, origin }, body: { vendor: 'fake', title: '테스트', cols: 100, rows: 30 } });
    assert.equal(created.status, 201);
    const session = created.json as { id: string; pid: number; title: string };
    assert.equal(session.title, '테스트');
    assert.ok(await waitFor(() => events.messages.some((m) => m.type === 'sessions' && (m.sessions as unknown[]).length === 1), 3000), 'session list pushed');

    // Nobody watches for the first 2.5 s: the startup queries must not stall the CLI.
    await sleep(2500);
    const first = await openSocket(app.port, `/ws/session?id=${session.id}`, { cookie, origin });
    assert.equal(first.status, 101);
    await waitFor(() => first.messages.some((m) => m.type === 'snapshot'), 3000);
    const snapshot = plain(String(first.messages.find((m) => m.type === 'snapshot')?.data));
    assert.match(snapshot, /fake-agent ready/);
    assert.match(snapshot, /REPORT cpr=\d+;\d+/, 'cursor position query answered while nobody watched');
    const childPid = Number(snapshot.match(/REPORT child=(\d+)/)?.[1]);

    first.ws?.send(JSON.stringify({ type: 'claim' }));
    first.ws?.send(JSON.stringify({ type: 'input', data: '\x1b[5;10R' })); // a browser-generated reply: dropped
    const composed = await request(app.port, 'POST', `/api/sessions/${session.id}/compose`, {
      headers: { cookie, origin },
      body: { text: '안녕하세요 AgentHouse\n둘째 줄 ✓', enterDelayMs: 100, quietMs: 100 },
    });
    assert.deepEqual(composed.json, { sessionId: session.id, sent: true, submitted: true });
    assert.ok(await waitFor(() => screenText(first.messages).includes('둘째 줄 ✓'), 5000), 'Korean multi-line text arrives');
    assert.ok(!screenText(first.messages).includes('5;10R'), 'browser reply did not reach the CLI');

    first.ws?.close();
    await sleep(200);
    const second = await openSocket(app.port, `/ws/session?id=${session.id}`, { cookie, origin });
    await waitFor(() => second.messages.some((m) => m.type === 'snapshot'), 3000);
    const again = plain(String(second.messages.find((m) => m.type === 'snapshot')?.data));
    assert.match(again, /둘째 줄 ✓/, 'reconnect restores the screen');

    const removed = await request(app.port, 'DELETE', `/api/sessions/${session.id}`, { headers: { cookie, origin } });
    assert.equal(removed.status, 200);
    await sleep(1000);
    assert.equal(isAlive(session.pid), false, 'CLI process ended');
    assert.ok(Number.isFinite(childPid) && !isAlive(childPid), 'grandchild (MCP-server stand-in) ended');
    second.ws?.close();
    events.ws?.close();
  });

  test('a missing working folder is reported, not launched', async () => {
    const res = await request(app.port, 'POST', '/api/sessions', {
      headers: { cookie, origin },
      body: { vendor: 'fake', cwd: 'Z:\\does\\not\\exist\\agenthouse' },
    });
    assert.equal(res.status, 400);
    assert.equal((res.json as { code: string }).code, 'CWD_NOT_FOUND');
  });
});

describe('staying up', () => {
  test('a frame over the limit closes that socket only; the web server keeps serving', async () => {
    const events = await openSocket(app.port, '/ws/events', { cookie, origin });
    const closed = new Promise<number>((resolve) => events.ws?.on('close', (code) => resolve(code)));
    events.ws?.send('x'.repeat(3 * 1024 * 1024));
    assert.equal(await closed, 1009, 'too big');
    assert.equal((await request(app.port, 'GET', '/api/sessions', { headers: { cookie } })).status, 200, 'still serving');
  });

  test('a taken port falls back to the next; with none left, nothing of the server stays behind', async () => {
    const client = await HostClient.connect({ stateDir: app.stateDir, spawn: false });
    try {
      const other = await createAgentHouseServer({ port: app.port, fallbackPorts: [0], host: client });
      assert.notEqual(other.port, app.port);
      await other.close();
      await assert.rejects(createAgentHouseServer({ port: app.port, host: client }), { code: 'EADDRINUSE' });
    } finally {
      client.close();
    }
  });

  test('a second start finds the web server already serving the state folder; a record one left behind is ignored', async () => {
    const dir = await tempStateDir();
    const write = (record: object) => writeFileSync(webServerFile(dir), JSON.stringify(record));
    try {
      assert.equal(await runningWebServer(dir), null, 'none yet');
      // Another live process that answers the login: the one to open.
      write({ pid: process.ppid, port: app.port, url: 'http://127.0.0.1/auth', token: app.token });
      assert.equal((await runningWebServer(dir))?.port, app.port);
      write({ pid: process.ppid, port: app.port, url: 'http://127.0.0.1/auth', token: 'not-its-token' });
      assert.equal(await runningWebServer(dir), null, 'something else on that port');
      write({ pid: 2 ** 22 + 7, port: app.port, url: 'http://127.0.0.1/auth', token: app.token });
      assert.equal(await runningWebServer(dir), null, 'its process has ended');
      recordWebServer(dir, { port: app.port, url: 'http://127.0.0.1/auth', token: app.token });
      assert.equal(await runningWebServer(dir), null, 'never itself');
      forgetWebServer(dir);
      assert.equal(existsSync(webServerFile(dir)), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
