import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { AccountLimits, SessionInfo } from '@agenthouse/protocol';
import { killTree } from '../src/shared/kill-tree';
import { HostClient, stopHosts } from '../src/web/host-client';
import { createAgentHouseServer } from '../src/web/http/server';
import { registryFile, SessionRegistry } from '../src/web/registry';
import { LimitsLog } from '../src/web/usage-log';
import { fakeAgentPath, login, openSocket, request, tempStateDir, waitFor } from './helpers';

function readRegistry(stateDir: string): SessionInfo[] {
  try {
    return (JSON.parse(readFileSync(registryFile(stateDir), 'utf8')) as { sessions: SessionInfo[] }).sessions;
  } catch {
    return [];
  }
}

function info(id: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id,
    vendor: 'claude',
    title: id,
    cwd: os.tmpdir(),
    model: null,
    effort: null,
    permissionMode: null,
    cli: { file: 'claude.exe', version: '2.1.322' },
    vendorSessionId: `${id}-cli`,
    pid: 1234,
    cols: 100,
    rows: 30,
    startedAt: 1000,
    state: 'running',
    exit: null,
    screen: true,
    status: { value: 'working', reason: null, tool: null, error: false, at: 2000 },
    telemetry: { level: 'full', model: 'Haiku 5.5', effort: 'low', contextPct: 4, contextWindow: 200000, costUsd: null },
    transcripts: [{ vendorSessionId: `${id}-cli`, path: path.join(os.tmpdir(), `${id}.jsonl`), since: 1500 }],
    agents: [],
    ...extra,
  };
}

describe('session registry', () => {
  test('sessions outlive their session host in the list, as ended, until removed', async () => {
    const stateDir = await tempStateDir();
    const client = await HostClient.connect({ stateDir, spawn: true, hostArgs: ['--idle-exit-ms', '60000'] });
    const app = await createAgentHouseServer({ port: 0, fakeAgentPath, host: client });
    let open = true;
    try {
      const cookie = await login(app.port, app.token);
      const headers = { cookie, origin: `http://127.0.0.1:${app.port}` };
      const created = await request(app.port, 'POST', '/api/sessions', { headers, body: { vendor: 'fake', title: 'before' } });
      const session = created.json as SessionInfo;
      assert.ok(await waitFor(() => readRegistry(stateDir).some((s) => s.id === session.id), 3000), 'written to sessions.json');

      const firstHost = client.pid;
      await killTree(firstHost);
      assert.ok(await waitFor(() => client.connected && client.pid !== firstHost, 20_000), 'a new host took over');
      const listed = (await request(app.port, 'GET', '/api/sessions', { headers })).json as SessionInfo[];
      const ended = listed.find((s) => s.id === session.id);
      assert.deepEqual([ended?.state, ended?.screen, ended?.exit?.code, ended?.title], ['exited', false, null, 'before']);
      assert.equal((await openSocket(app.port, `/ws/session?id=${session.id}`, headers)).status, 404, 'no terminal is left');
      assert.ok(await waitFor(() => readRegistry(stateDir).find((s) => s.id === session.id)?.state === 'exited', 3000));

      assert.equal((await request(app.port, 'DELETE', `/api/sessions/${session.id}`, { headers })).status, 200);
      assert.deepEqual((await request(app.port, 'GET', '/api/sessions', { headers })).json, []);
      open = false;
      await app.close();
      assert.deepEqual(readRegistry(stateDir), [], 'removed for good');
    } finally {
      if (open) await app.close();
      client.close();
      await stopHosts(stateDir);
      await rm(stateDir, { recursive: true, force: true });
    }
  });

  test('the file keeps what the host reported, and the 50 newest ended sessions', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agenthouse-registry-'));
    const file = registryFile(dir);
    try {
      const first = new SessionRegistry(file);
      first.record([info('running'), info('done', { state: 'exited', exit: { code: 0, signal: null, at: 3000 }, status: { value: 'exited', reason: null, tool: null, error: false, at: 3000 } })]);
      first.flush();

      // A later web server, after the host went away: both are ended now.
      const second = new SessionRegistry(file);
      second.record([]);
      const past = second.past([]);
      assert.deepEqual(
        past.map((s) => [s.id, s.state, s.screen, s.exit?.code ?? null]),
        [
          ['running', 'exited', false, null],
          ['done', 'exited', false, 0],
        ],
      );
      assert.equal(past[0]?.transcripts.length, 1, 'its conversation can still be read');
      assert.equal(past[0]?.telemetry.model, 'Haiku 5.5');

      const at = (i: number) => 10_000 + i;
      second.record(Array.from({ length: 60 }, (_, i) => info(`s${i}`, { startedAt: at(i), status: { value: 'idle', reason: null, tool: null, error: false, at: at(i) } })));
      second.record([]);
      const kept = second.past([]).map((s) => s.id);
      assert.equal(kept.length, 50);
      assert.deepEqual([kept.includes('s10'), kept.includes('s9'), kept.includes('done')], [true, false, false], 'the ones that ended last stay');
      second.remove('s59');
      second.flush();
      assert.equal(new SessionRegistry(file).past([]).length, 49);

      writeFileSync(file, '{not json');
      assert.deepEqual(new SessionRegistry(file).past([]), [], 'an unreadable file starts over');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('usage log', () => {
  const window = (usedPct: number, resetsAt: number | null) => ({ usedPct, resetsAt });

  test('a line per change; the last one shows after a restart, without windows that reset since', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agenthouse-usage-'));
    try {
      const now = Date.now();
      const later = now + 3_600_000;
      const log = new LimitsLog(dir);
      const entry = (fiveHour: AccountLimits['fiveHour'], sevenDay: AccountLimits['sevenDay'], at: number): AccountLimits => ({ vendor: 'claude', fiveHour, sevenDay, at });
      log.append([entry(window(10, later), window(20, later), now)]);
      log.append([entry(window(10, later), window(20, later), now + 1)]);
      log.append([entry(window(12, later), window(20, later), now + 2)]);
      const month = new Date(now).toISOString().slice(0, 7);
      const lines = readFileSync(path.join(dir, `limits-${month}.jsonl`), 'utf8').trim().split('\n');
      assert.equal(lines.length, 2, 'unchanged usage is not written again');
      assert.equal(new LimitsLog(dir).last(now)[0]?.fiveHour?.usedPct, 12);

      log.append([entry(window(50, now - 1000), window(21, later), now + 3)]);
      assert.deepEqual(new LimitsLog(dir).last(now), [entry(null, window(21, later), now + 3)], 'the 5-hour window reset since');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("early in a month, last month's file still has the last value", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agenthouse-usage-'));
    try {
      const now = Date.UTC(2026, 11, 1, 0, 30);
      const before = Date.UTC(2026, 10, 30, 23, 0);
      new LimitsLog(dir).append([{ vendor: 'claude', fiveHour: { usedPct: 30, resetsAt: now + 60_000 }, sevenDay: null, at: before }]);
      assert.equal(new LimitsLog(dir).last(now)[0]?.fiveHour?.usedPct, 30);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
