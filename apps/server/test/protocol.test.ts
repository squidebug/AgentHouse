import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { WebSocketServer } from 'ws';
import { createSessionHost } from '../src/host/server';
import { buildIdOf, hostBuildId } from '../src/shared/build';
import { childEnv } from '../src/shared/child-env';
import { hostProof, HostRequestError } from '../src/shared/host-protocol';
import { hostMessages } from '../src/web/doctor';
import { HostClient, stopHosts } from '../src/web/host-client';
import { fakeSpec, request, tempStateDir, waitFor } from './helpers';

/** Stands in for a host of an older protocol: it speaks only the parts every version keeps. */
async function olderHost(stateDir: string, protocol: number, sessions: number) {
  const token = `older-host-token-${protocol}`;
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const received: unknown[] = [];
  server.on('connection', (ws, req) => {
    const nonce = String(req.headers['x-agenthouse-nonce']);
    ws.send(JSON.stringify({ type: 'hello', protocol, pid: process.pid, proof: hostProof(token, nonce), webToken: 'w', sessions: [], limits: [] }));
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString()) as { id: number; op: string };
      received.push(message.op);
      if (message.op === 'shutdown') ws.send(JSON.stringify({ type: 'reply', id: message.id, ok: true, result: { closed: sessions } }));
    });
  });
  const port = (server.address() as AddressInfo).port;
  await writeFile(path.join(stateDir, `host-${protocol}.json`), JSON.stringify({ protocol, pid: process.pid, port, token, startedAt: 1 }));
  return { received, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe('host protocol', () => {
  test('a session has the id the web server chose, and only once', async () => {
    const stateDir = await tempStateDir();
    const host = await createSessionHost({ stateDir, idleExitMs: null });
    const client = await HostClient.connect({ stateDir, spawn: false });
    try {
      const spec = fakeSpec();
      assert.equal((await client.spawn(spec)).id, spec.id);
      await assert.rejects(client.spawn({ ...fakeSpec(), id: spec.id }), (error: HostRequestError) => error.code === 'DUPLICATE');
      await assert.rejects(client.spawn({ ...fakeSpec(), id: '../../x' }), (error: HostRequestError) => error.code === 'INVALID_REQUEST');
      await client.closeSession(spec.id);
    } finally {
      client.close();
      await host.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test('each conversation (a new one after /clear) is listed with its transcript', async () => {
    const stateDir = await tempStateDir();
    const config = await mkdtemp(path.join(os.tmpdir(), 'agenthouse-claude-config-'));
    const host = await createSessionHost({ stateDir, idleExitMs: null });
    const client = await HostClient.connect({ stateDir, spawn: false });
    const projects = path.join(config, 'projects', 'C--work');
    try {
      const info = await client.spawn(fakeSpec({ vendor: 'claude', hookToken: 'hook-secret', vendorSessionId: 'first', env: { ...childEnv(), CLAUDE_CONFIG_DIR: config } }));
      const hook = (body: object) => request(client.port, 'POST', '/hook', { headers: { authorization: 'Bearer hook-secret' }, body });
      const transcripts = () => client.get(info.id)?.transcripts ?? [];

      await hook({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'first', transcript_path: path.join(projects, 'first.jsonl') });
      assert.ok(await waitFor(() => transcripts().length === 1, 2000));
      // Other events, e.g. from a sub-agent, never start a conversation.
      await hook({ hook_event_name: 'PreToolUse', session_id: 'first', transcript_path: path.join(projects, 'first', 'subagents', 'agent-a.jsonl') });
      await hook({ hook_event_name: 'SessionEnd', reason: 'clear', session_id: 'first', transcript_path: path.join(projects, 'first.jsonl') });
      await hook({ hook_event_name: 'SessionStart', source: 'clear', session_id: 'second', transcript_path: path.join(projects, 'second.jsonl') });
      assert.ok(await waitFor(() => transcripts().length === 2, 2000));
      assert.deepEqual(
        transcripts().map((t) => [t.vendorSessionId, path.basename(t.path)]),
        [
          ['first', 'first.jsonl'],
          ['second', 'second.jsonl'],
        ],
      );
      assert.equal(client.get(info.id)?.vendorSessionId, 'second');
      // A path outside Claude's projects folder is never taken (the host would open it).
      await hook({ hook_event_name: 'SessionStart', source: 'resume', session_id: 'third', transcript_path: path.join(os.tmpdir(), 'elsewhere.jsonl') });
      await hook({ hook_event_name: 'Stop' });
      assert.ok(await waitFor(() => client.get(info.id)?.status.value === 'idle', 2000));
      assert.equal(transcripts().length, 2);
      await client.closeSession(info.id);
    } finally {
      client.close();
      await host.close();
      await rm(stateDir, { recursive: true, force: true });
      await rm(config, { recursive: true, force: true });
    }
  });

  test('--stop ends the host and the hosts that older protocol versions left behind', async () => {
    const stateDir = await tempStateDir();
    const host = await createSessionHost({ stateDir, idleExitMs: null });
    const older = await olderHost(stateDir, 3, 2);
    // A state file whose host is long gone.
    await writeFile(path.join(stateDir, 'host-2.json'), JSON.stringify({ protocol: 2, pid: 999_999_999, port: 1, token: 't', startedAt: 1 }));
    try {
      const client = await HostClient.connect({ stateDir, spawn: false });
      await client.spawn(fakeSpec());
      client.close();
      assert.equal(
        (await hostMessages({ build: hostBuildId(), stateDir, stopCommand: 'pnpm stop' })).map((m) => m.id).join(),
        'ENV_HOST_OLDER_VERSION',
        'the doctor sees the older host',
      );

      const ended = host.done;
      assert.deepEqual(await stopHosts(stateDir), { hosts: 2, sessions: 3 });
      assert.deepEqual(older.received, ['shutdown']);
      assert.equal(await ended, 'shutdown', 'the current host was asked to leave');
    } finally {
      await older.close();
      await host.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test('a host that runs older code than the files on disk is reported', async () => {
    const stateDir = await tempStateDir();
    try {
      const messages = await hostMessages({ build: 'built-before', stateDir, stopCommand: 'pnpm dev:stop' });
      assert.deepEqual(
        messages.map((m) => [m.id, m.command]),
        [['ENV_HOST_OUTDATED', 'pnpm dev:stop']],
      );
      assert.deepEqual(await hostMessages({ build: hostBuildId(), stateDir, stopCommand: 'pnpm stop' }), []);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test('the build id follows the contents of the host files only', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'agenthouse-build-'));
    try {
      await mkdir(path.join(root, 'host'));
      await writeFile(path.join(root, 'host', 'a.ts'), 'one');
      await writeFile(path.join(root, 'web.ts'), 'web');
      const first = buildIdOf(root, ['host']);
      await writeFile(path.join(root, 'web.ts'), 'web changed');
      assert.equal(buildIdOf(root, ['host']), first, 'web server code does not count');
      await writeFile(path.join(root, 'host', 'a.ts'), 'two');
      assert.notEqual(buildIdOf(root, ['host']), first);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
