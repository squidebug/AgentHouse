import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { SessionInfo } from '@agenthouse/protocol';
import { createSessionHost, type SessionHost } from '../src/host/server';
import { childEnv } from '../src/shared/child-env';
import { isAlive } from '../src/shared/kill-tree';
import { HostClient } from '../src/web/host-client';
import { fakeSpec as spec, plain, request, screenText, sleep, tempStateDir, waitFor, type Socket } from './helpers';

let stateDir: string;
let host: SessionHost;
let client: HostClient;

before(async () => {
  stateDir = await tempStateDir();
  // Small, so the stalled viewer below falls behind whatever the OS buffers on the socket.
  host = await createSessionHost({ stateDir, idleExitMs: null, viewerBacklog: { max: 256 * 1024, resyncBelow: 64 * 1024 } });
  client = await HostClient.connect({ stateDir, spawn: false });
});

after(async () => {
  client.close();
  await host.close();
  await rm(stateDir, { recursive: true, force: true });
});

function watch(info: SessionInfo) {
  const ws = client.openTerminal(info.id);
  const messages: Socket['messages'] = [];
  ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
  const opened = new Promise((resolve) => ws.once('open', resolve));
  return { ws, messages, opened, send: (data: string) => ws.send(JSON.stringify({ type: 'input', data })) };
}

describe('a session in the host', () => {
  test('Esc during a turn: the transcript says it was interrupted, though no hook does', async () => {
    const config = await mkdtemp(path.join(os.tmpdir(), 'agenthouse-claude-config-'));
    const transcript = path.join(config, 'projects', 'C--work', 'cli-session.jsonl');
    await mkdir(path.dirname(transcript), { recursive: true });
    await writeFile(transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: 'count to 1500' } })}\n`);
    const info = await client.spawn(spec({ vendor: 'claude', hookToken: 'hook-secret', env: { ...childEnv(), CLAUDE_CONFIG_DIR: config } }));
    const hook = (body: object) => request(client.port, 'POST', '/hook', { headers: { authorization: 'Bearer hook-secret' }, body });
    const status = () => client.get(info.id)?.status;
    const terminal = watch(info);
    try {
      await terminal.opened;
      await hook({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'cli-session', transcript_path: transcript });
      await hook({ hook_event_name: 'UserPromptSubmit' });
      assert.ok(await waitFor(() => status()?.value === 'working', 2000));

      // Esc that only closed a menu: the transcript has no marker, so the turn goes on.
      terminal.send('\x1b');
      await sleep(1800);
      assert.equal(status()?.value, 'working');

      await appendFile(transcript, `${JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } })}\n`);
      terminal.send('\x1b');
      assert.ok(await waitFor(() => status()?.value === 'idle', 3000), 'idle after the marker');
      assert.equal(status()?.reason, 'interrupted');
    } finally {
      terminal.ws.close();
      await client.closeSession(info.id);
      await rm(config, { recursive: true, force: true });
    }
  });

  test('a real CLI is ended with Ctrl+C first, not killed', async () => {
    const info = await client.spawn(spec({ vendor: 'claude' }));
    const terminal = watch(info);
    await terminal.opened;
    assert.ok(await waitFor(() => plain(screenText(terminal.messages)).includes('fake-agent ready'), 5000));
    const closed = await client.closeSession(info.id);
    assert.deepEqual(closed, { exited: true, stillAlive: false });
    // The fake prints this when it gets Ctrl+C; a killed process prints nothing more.
    assert.ok(await waitFor(() => plain(screenText(terminal.messages)).includes('bye'), 2000), 'it saw Ctrl+C and quit by itself');
    terminal.ws.close();
  });

  test('a viewer that stops reading is dropped from the live stream and resynced, the CLI never waits', async () => {
    const info = await client.spawn(spec());
    const terminal = watch(info);
    try {
      await terminal.opened;
      assert.ok(await waitFor(() => plain(screenText(terminal.messages)).includes('fake-agent ready'), 5000));
      terminal.send('flood');
      terminal.ws.pause();
      await sleep(4000);
      terminal.ws.resume();
      assert.ok(await waitFor(() => terminal.messages.filter((m) => m.type === 'snapshot').length >= 2, 10_000), 'resynced from a snapshot');
      assert.ok(await waitFor(() => plain(screenText(terminal.messages.slice(-50))).includes('flood done'), 10_000), 'and back on the live screen');
      assert.ok(isAlive(info.pid));
    } finally {
      terminal.ws.close();
      await client.closeSession(info.id);
    }
  });

  test('a CLI that ended by itself still shows its last screen to a viewer that comes later', async () => {
    const info = await client.spawn(spec());
    const first = watch(info);
    try {
      await first.opened;
      assert.ok(await waitFor(() => plain(screenText(first.messages)).includes('fake-agent ready'), 5000));
      first.send('exit');
      assert.ok(await waitFor(() => client.get(info.id)?.state === 'exited', 5000), 'it quit by itself');
      first.ws.close();
      // Past the moment the host lets the mirror go and keeps the screen as text.
      await sleep(2000);
      const later = watch(info);
      await later.opened;
      assert.ok(await waitFor(() => later.messages.some((m) => m.type === 'snapshot'), 3000), 'a snapshot for the late viewer');
      const screen = plain(screenText(later.messages));
      assert.ok(screen.includes('fake-agent ready') && screen.includes('bye'), 'the whole last screen');
      assert.equal(client.get(info.id)?.screen, true);
      later.ws.close();
    } finally {
      await client.closeSession(info.id);
    }
  });
});
