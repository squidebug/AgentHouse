import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { WebSocketServer } from 'ws';
import type { SessionInfo } from '@agenthouse/protocol';
import { HostClient, HostUnavailableError } from '../src/web/host-client';
import { HOST_PROTOCOL, hostProof } from '../src/shared/host-protocol';
import { createSessionHost } from '../src/host/server';
import { readState, runDir, writeState } from '../src/shared/state';
import { createAgentHouseServer } from '../src/web/http/server';
import { isAlive, killTree } from '../src/shared/kill-tree';
import { fakeAgentPath, fakeSpec, login, openSocket, plain, request, screenText, sleep, tempStateDir, waitFor, type Socket } from './helpers';

/** A web server on the host of `stateDir`. Stopping it twice is fine: a test stops it where it means to, and again when it ends. */
async function webServer(stateDir: string, port = 0) {
  const client = await HostClient.connect({ stateDir, spawn: false });
  const app = await createAgentHouseServer({ port, fakeAgentPath, host: client });
  const authorization = await login(app);
  let stopped = false;
  return {
    app,
    authorization,
    headers: { authorization, origin: `http://127.0.0.1:${app.port}` },
    async stop() {
      if (stopped) return;
      stopped = true;
      await app.close();
      client.close();
    },
  };
}

describe('session host', () => {
  test('sessions keep running while the web server restarts', async () => {
    const stateDir = await tempStateDir();
    const host = await createSessionHost({ stateDir, idleExitMs: null });
    // Stopped at the end whatever happened. One left listening after a failed check kept this file's
    // process alive, and the whole run waiting for it.
    const servers: Array<Awaited<ReturnType<typeof webServer>>> = [];
    try {
      const first = await webServer(stateDir);
      servers.push(first);
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

      // Logins are bound to the port and to the host's secret: back on the same port, they still hold.
      const second = await webServer(stateDir, first.app.port);
      servers.push(second);
      assert.equal(second.app.key, first.app.key, 'the key comes from the host and the port');
      const listed = await request(second.app.port, 'GET', '/api/sessions', { headers: { authorization: first.authorization } });
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
      for (const server of servers) await server.stop().catch(() => {});
      await host.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test('the host lets in only web servers that hold its token, and proves it holds it too', async () => {
    const stateDir = await tempStateDir();
    const stale = path.join(runDir(stateDir), 'agenthouse-left-behind');
    await mkdir(stale, { recursive: true });
    const host = await createSessionHost({ stateDir, idleExitMs: null });
    try {
      const state = readState(stateDir);
      assert.ok(state);
      const nonce = 'a-nonce-from-the-web-server';
      const auth = { authorization: `Bearer ${state.token}`, 'x-agenthouse-nonce': nonce };
      assert.equal((await openSocket(state.port, '/control', { 'x-agenthouse-nonce': nonce })).status, 401, 'no token');
      assert.equal((await openSocket(state.port, '/control', { ...auth, authorization: 'Bearer wrong' })).status, 401, 'wrong token');
      assert.equal((await openSocket(state.port, '/control', { ...auth, origin: 'http://127.0.0.1:7357' })).status, 401, 'never a browser, even one with the token');
      const allowed = await openSocket(state.port, '/control', auth);
      assert.equal(allowed.status, 101);
      assert.ok(await waitFor(() => allowed.messages.length > 0, 2000));
      assert.equal(allowed.messages[0]?.proof, hostProof(state.token, nonce), 'the hello proves the host knows the token');
      allowed.ws?.close();
      assert.ok(await waitFor(() => !existsSync(stale), 3000), 'files a previous host left behind are cleared');
    } finally {
      await host.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test("a web server ignores something squatting on a dead host's port", async () => {
    const stateDir = await tempStateDir();
    // Whatever now listens where a host used to: it answers like a host but cannot prove the token.
    const impostor = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    impostor.on('connection', (ws) => ws.send(JSON.stringify({ type: 'hello', protocol: HOST_PROTOCOL, pid: 1, proof: 'forged', webToken: 'chosen-by-them', sessions: [], limits: [] })));
    try {
      await new Promise<void>((resolve) => impostor.once('listening', resolve));
      writeState(stateDir, { protocol: HOST_PROTOCOL, pid: process.pid, port: (impostor.address() as AddressInfo).port, token: 'the-real-token', startedAt: 1 });
      await assert.rejects(HostClient.connect({ stateDir, spawn: false }), HostUnavailableError);
    } finally {
      impostor.close();
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

  test('the composer: nothing before the CLI started or into a dialog another call hides; control characters dropped; one text at a time', async () => {
    const stateDir = await tempStateDir();
    const host = await createSessionHost({ stateDir, idleExitMs: null });
    const client = await HostClient.connect({ stateDir, spawn: false });
    try {
      const info = await client.spawn({ ...fakeSpec(), vendor: 'claude', hookToken: 'hook-secret' });
      const hook = (body: object) => request(client.port, 'POST', '/hook', { headers: { authorization: 'Bearer hook-secret' }, body });
      const statusOf = () => client.get(info.id)?.status;
      const terminal = client.openTerminal(info.id);
      const messages: Socket['messages'] = [];
      terminal.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
      await waitFor(() => plain(screenText(messages)).includes('fake-agent ready'), 5000);
      const compose = (text: string, extra: object = {}) => client.compose(info.id, { text, enterDelayMs: 50, quietMs: 50, ...extra });

      // Claude asks whether to trust a new folder before any hook: Enter would pick its default, "No, exit".
      assert.deepEqual(await compose('too early'), { sent: false, submitted: false, reason: 'starting' });
      await hook({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'cli-session-2' });
      assert.ok(await waitFor(() => statusOf()?.value === 'idle', 2000));

      // Two calls in parallel: the one that needs approval asks, the other ends first.
      const rm_ = { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } };
      await hook({ hook_event_name: 'UserPromptSubmit' });
      await hook({ hook_event_name: 'PreToolUse', tool_use_id: 'read-1', tool_name: 'Read', tool_input: { file_path: 'a.txt' } });
      await hook({ hook_event_name: 'PreToolUse', tool_use_id: 'bash-1', ...rm_ });
      await hook({ hook_event_name: 'PermissionRequest', ...rm_ });
      await hook({ hook_event_name: 'PostToolUse', tool_use_id: 'read-1', tool_name: 'Read', tool_input: { file_path: 'a.txt' } });
      assert.ok(await waitFor(() => statusOf()?.value === 'awaiting_permission', 2000), 'the dialog still shows');
      assert.deepEqual(await compose('must not answer'), { sent: false, submitted: false, reason: 'awaiting_permission' });
      await hook({ hook_event_name: 'PostToolUse', tool_use_id: 'bash-1', ...rm_ });
      await hook({ hook_event_name: 'Stop' });
      assert.ok(await waitFor(() => statusOf()?.value === 'idle', 2000));

      // Sent at once, they go one after the other; an ESC or Ctrl+C inside never reaches the CLI as a key.
      const [first, second] = await Promise.all([compose('alpha'), compose('beta\x1b[201~!rm\x03\x15 end')]);
      assert.deepEqual([first, second], [
        { sent: true, submitted: true },
        { sent: true, submitted: true },
      ]);
      // The fake agent echoes what it reads as JSON; a paste and its Enter may arrive in one read.
      const afterBeta = () => {
        const screen = screenText(messages);
        return screen.slice(screen.indexOf('beta[201~!rm end'));
      };
      assert.ok(await waitFor(() => screenText(messages).includes('beta[201~!rm end') && afterBeta().includes('\\r'), 3000), 'the text without its control characters, then Enter');
      const screen = screenText(messages);
      const alpha = screen.indexOf('alpha');
      assert.ok(alpha !== -1 && screen.slice(alpha, screen.indexOf('beta')).includes('\\r'), "alpha's Enter before beta");
      assert.ok(!screen.includes('must not answer') && !screen.includes('too early') && !screen.includes('\\u0003'));

      // Enter alone, for text that went in before.
      const count = (needle: string) => screenText(messages).split(needle).length - 1;
      const [enters, pastes] = [count('IN "\\r"'), count('[200~')];
      assert.deepEqual(await compose('', { enterOnly: true }), { sent: true, submitted: true });
      assert.ok(await waitFor(() => count('IN "\\r"') === enters + 1, 2000), 'one Enter');
      assert.equal(count('[200~'), pastes, 'nothing pasted');
      terminal.close();
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
      const info = await client.spawn(fakeSpec({ tempPaths: [tempDir] }));
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
