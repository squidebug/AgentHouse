import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { SessionInfo } from '@agenthouse/protocol';
import { HostClient } from '../src/host/client';
import type { SpawnSpec } from '../src/host/protocol';
import { createSessionHost } from '../src/host/server';
import { readState } from '../src/host/state';
import { createAgentHouseServer } from '../src/http/server';
import { childEnv } from '../src/sessions/env';
import { isAlive, killTree } from '../src/util/kill-tree';
import { fakeAgentPath, login, openSocket, plain, request, screenText, sleep, tempStateDir, waitFor, type Socket } from './helpers';

async function webServer(stateDir: string) {
  const client = await HostClient.connect({ stateDir, spawn: false });
  const app = await createAgentHouseServer({ port: 0, fakeAgentPath, host: client });
  const cookie = await login(app.port, app.token);
  return {
    app,
    cookie,
    headers: { cookie, origin: `http://127.0.0.1:${app.port}` },
    async stop() {
      await app.close();
      client.close();
    },
  };
}

function fakeSpec(tempPaths: string[] = []): SpawnSpec {
  return {
    vendor: 'fake',
    title: 'fake',
    file: process.execPath,
    args: [fakeAgentPath],
    cwd: os.tmpdir(),
    env: childEnv(),
    cols: 100,
    rows: 30,
    theme: 'dark',
    model: null,
    effort: null,
    permissionMode: null,
    cliVersion: null,
    vendorSessionId: null,
    tempPaths,
    hookToken: null,
    agentsCommand: null,
  };
}

describe('session host', () => {
  test('sessions keep running while the web server restarts', async () => {
    const stateDir = await tempStateDir();
    const host = await createSessionHost({ stateDir, idleExitMs: null });
    try {
      const first = await webServer(stateDir);
      const created = await request(first.app.port, 'POST', '/api/sessions', { headers: first.headers, body: { vendor: 'fake', title: '재시작' } });
      assert.equal(created.status, 201);
      const session = created.json as SessionInfo;
      const term = await openSocket(first.app.port, `/ws/session?id=${session.id}`, first.headers);
      assert.ok(await waitFor(() => plain(screenText(term.messages)).includes('fake-agent ready'), 5000), 'relayed output');
      // A turn in progress: output keeps coming while no web server is attached.
      term.ws?.send(JSON.stringify({ type: 'input', data: 'stream' }));
      assert.ok(await waitFor(() => screenText(term.messages).includes('tick 1'), 3000), 'relayed input');
      await first.stop();
      assert.ok(isAlive(session.pid), 'the CLI keeps running without a web server');
      await sleep(2500);

      const second = await webServer(stateDir);
      assert.equal(second.app.token, first.app.token, 'the login token comes from the host');
      const listed = await request(second.app.port, 'GET', '/api/sessions', { headers: { cookie: first.cookie } });
      assert.equal(listed.status, 200, 'the browser stays logged in');
      assert.deepEqual(
        (listed.json as SessionInfo[]).map((s) => s.id),
        [session.id],
      );
      const again = await openSocket(second.app.port, `/ws/session?id=${session.id}`, second.headers);
      assert.ok(await waitFor(() => again.messages.some((m) => m.type === 'snapshot'), 3000));
      const restored = plain(String(again.messages.find((m) => m.type === 'snapshot')?.data));
      assert.match(restored, /stream done/, 'output from while the web server was down is on screen');
      again.ws?.close();

      const removed = await request(second.app.port, 'DELETE', `/api/sessions/${session.id}`, { headers: second.headers });
      assert.equal(removed.status, 200);
      assert.ok(await waitFor(() => !isAlive(session.pid), 3000), 'removing it ends the CLI');
      await second.stop();
    } finally {
      await host.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test('the host lets in only web servers that hold its token', async () => {
    const stateDir = await tempStateDir();
    const host = await createSessionHost({ stateDir, idleExitMs: null });
    try {
      const state = readState(stateDir);
      assert.ok(state);
      assert.equal((await openSocket(state.port, '/control', {})).status, 401, 'no token');
      assert.equal((await openSocket(state.port, '/control', { authorization: 'Bearer wrong' })).status, 401, 'wrong token');
      const browser = await openSocket(state.port, '/control', { authorization: `Bearer ${state.token}`, origin: 'http://127.0.0.1:7357' });
      assert.equal(browser.status, 401, 'never a browser, even one with the token');
      const allowed = await openSocket(state.port, '/control', { authorization: `Bearer ${state.token}` });
      assert.equal(allowed.status, 101);
      allowed.ws?.close();
    } finally {
      await host.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test('hook events set the status; the composer leaves a session waiting for approval alone', async () => {
    const stateDir = await tempStateDir();
    const host = await createSessionHost({ stateDir, idleExitMs: null });
    const client = await HostClient.connect({ stateDir, spawn: false });
    try {
      const info = await client.spawn({ ...fakeSpec(), vendor: 'claude', hookToken: 'hook-secret' });
      const post = (route: string, body: object, headers: Record<string, string> = {}) =>
        request(client.port, 'POST', route, { headers: { authorization: 'Bearer hook-secret', ...headers }, body });
      const statusOf = () => client.get(info.id)?.status;

      assert.equal((await post('/hook', {}, { authorization: 'Bearer wrong' })).status, 401, 'wrong token');
      assert.equal((await post('/hook', {}, { origin: 'http://127.0.0.1:7357' })).status, 401, 'never a browser');

      await post('/hook', { hook_event_name: 'SessionStart', source: 'startup', session_id: 'cli-session-1' });
      assert.ok(await waitFor(() => statusOf()?.value === 'idle', 2000), 'started');
      assert.equal(client.get(info.id)?.telemetry.level, 'full');
      assert.equal(client.get(info.id)?.vendorSessionId, 'cli-session-1');

      const terminal = client.openTerminal(info.id);
      const messages: Socket['messages'] = [];
      terminal.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
      await waitFor(() => plain(screenText(messages)).includes('fake-agent ready'), 5000);

      await post('/hook', { hook_event_name: 'UserPromptSubmit' });
      await post('/hook', { hook_event_name: 'PreToolUse', tool_name: 'Write' });
      await post('/hook', { hook_event_name: 'PermissionRequest', tool_name: 'Write' });
      assert.ok(await waitFor(() => statusOf()?.value === 'awaiting_permission', 2000), 'waiting for approval');
      assert.equal(statusOf()?.reason, 'Write');
      const refused = await client.compose(info.id, { text: 'must not answer the dialog', enterDelayMs: 50, quietMs: 50 });
      assert.deepEqual(refused, { sent: false, submitted: false, reason: 'awaiting_permission' });

      await post('/hook', { hook_event_name: 'PostToolUse', tool_name: 'Write' });
      await post('/hook', { hook_event_name: 'Stop' });
      assert.ok(await waitFor(() => statusOf()?.value === 'idle', 2000), 'turn over');
      const sent = await client.compose(info.id, { text: 'now it can go', enterDelayMs: 50, quietMs: 50 });
      assert.deepEqual(sent, { sent: true, submitted: true });
      assert.ok(await waitFor(() => screenText(messages).includes('now it can go'), 3000));
      assert.ok(!screenText(messages).includes('must not answer'), 'the refused text never reached the CLI');
      terminal.close();

      await post('/status', {
        model: { display_name: 'Haiku 5.5' },
        effort: { level: 'low' },
        context_window: { used_percentage: 4, context_window_size: 200000 },
        rate_limits: { five_hour: { used_percentage: 13, resets_at: 1794388800 } },
      });
      assert.ok(await waitFor(() => client.limits().length === 1, 2000), 'plan limits reported');
      assert.deepEqual(client.limits()[0]?.fiveHour, { usedPct: 13, resetsAt: 1794388800000 });
      assert.ok(await waitFor(() => client.get(info.id)?.telemetry.contextPct === 4, 2000), 'context use reported');
    } finally {
      client.close();
      await host.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test('a host started on demand runs sessions on its own and leaves when idle', async () => {
    const stateDir = await tempStateDir();
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'agenthouse-temp-'));
    const client = await HostClient.connect({ stateDir, spawn: true, hostArgs: ['--idle-exit-ms', '1000'] });
    const hostPid = client.pid;
    try {
      assert.notEqual(hostPid, process.pid, 'a separate process');
      const info = await client.spawn(fakeSpec([tempDir]));
      const terminal = client.openTerminal(info.id);
      const messages: Socket['messages'] = [];
      terminal.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
      assert.ok(await waitFor(() => plain(screenText(messages)).includes('fake-agent ready'), 8000), 'the CLI runs in the detached host');
      terminal.close();

      const closed = await client.closeSession(info.id);
      assert.equal(closed.exited, true);
      assert.ok(await waitFor(() => !existsSync(tempDir), 3000), "the session's temporary files go with it");
      client.close();
      assert.ok(await waitFor(() => !isAlive(hostPid), 8000), 'an idle host leaves');
      assert.equal(readState(stateDir), null, 'and removes its state file');
    } finally {
      client.close();
      if (isAlive(hostPid)) await killTree(hostPid);
      await rm(stateDir, { recursive: true, force: true });
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
