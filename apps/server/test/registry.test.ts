import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { AccountLimits, SessionInfo } from '@agenthouse/protocol';
import { isAlive, killTree } from '../src/shared/kill-tree';
import { HostClient, stopHosts } from '../src/web/host-client';
import { createAgentHouseServer } from '../src/web/http/server';
import { registryFile, SessionRegistry } from '../src/web/registry';
import { LimitsLog } from '../src/web/usage-log';
import { fakeAgentPath, login, noRealCli, openSocket, request, tempStateDir, waitFor } from './helpers';

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
    tasks: [],
    schedules: [],
    invoked: [],
    ...extra,
  };
}

describe('session registry', () => {
  test('sessions outlive their session host in the list, as ended, until removed', async () => {
    const stateDir = await tempStateDir();
    const client = await HostClient.connect({ stateDir, spawn: true, hostArgs: ['--idle-exit-ms', '60000'] });
    const app = await createAgentHouseServer({ port: 0, fakeAgentPath, host: client, ...noRealCli });
    let open = true;
    try {
      const authorization = await login(app);
      const headers = { authorization, origin: `http://127.0.0.1:${app.port}` };
      const created = await request(app.port, 'POST', '/api/sessions', { headers, body: { vendor: 'fake', title: 'before' } });
      const session = created.json as SessionInfo;
      assert.ok(await waitFor(() => readRegistry(stateDir).some((s) => s.id === session.id), 10_000), 'written to sessions.json');

      const firstHost = client.pid;
      await killTree(firstHost);
      assert.ok(await waitFor(() => client.connected && client.pid !== firstHost, 45_000), 'a new host took over');
      const listed = (await request(app.port, 'GET', '/api/sessions', { headers })).json as SessionInfo[];
      const ended = listed.find((s) => s.id === session.id);
      assert.deepEqual([ended?.state, ended?.screen, ended?.exit?.code, ended?.title], ['exited', false, null, 'before']);
      assert.equal((await openSocket(app.port, `/ws/session?id=${session.id}`, headers)).status, 404, 'no terminal is left');
      assert.ok(await waitFor(() => readRegistry(stateDir).find((s) => s.id === session.id)?.state === 'exited', 10_000));

      // Ended from AgentHouse, a session stays listed too, ended, until it is removed.
      const other = (await request(app.port, 'POST', '/api/sessions', { headers, body: { vendor: 'fake', title: 'ended here' } })).json as SessionInfo;
      assert.ok(await waitFor(() => readRegistry(stateDir).some((s) => s.id === other.id), 10_000));
      assert.equal((await request(app.port, 'POST', `/api/sessions/${other.id}/end`, { headers })).status, 200);
      const after = ((await request(app.port, 'GET', '/api/sessions', { headers })).json as SessionInfo[]).find((s) => s.id === other.id);
      assert.deepEqual([after?.state, after?.screen, after?.title], ['exited', false, 'ended here']);
      assert.equal(isAlive(other.pid), false, 'its CLI has ended');

      for (const id of [session.id, other.id]) assert.equal((await request(app.port, 'DELETE', `/api/sessions/${id}`, { headers })).status, 200);
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

  test('an entry of the file that is not what was written costs that entry, not the start', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agenthouse-registry-'));
    const file = registryFile(dir);
    try {
      // What the server or the page reads of an entry without a check. With the first, and with the
      // missing sub-agent, the web server did not start: ending such a session read what is not there.
      const broken = [
        { ...info('no-status'), status: null },
        { ...info('status-without-time'), status: { value: 'idle' } },
        { ...info('exit-as-text'), exit: 'yesterday' },
        { ...info('no-telemetry'), telemetry: null },
        { ...info('transcript-without-path'), transcripts: [{ vendorSessionId: null, since: 1 }] },
        { ...info('agent-missing'), agents: [null] },
        null,
        'text',
      ];
      // One from before sub-agents and background work were tracked has none of their lists.
      const { agents: _agents, tasks: _tasks, schedules: _schedules, invoked: _invoked, ...old } = info('old');
      writeFileSync(file, JSON.stringify({ version: 1, sessions: [...broken, old, info('good')] }));
      const registry = new SessionRegistry(file);
      registry.record([]);
      const kept = registry.past([]);
      assert.deepEqual(kept.map((s) => s.id), ['old', 'good']);
      assert.deepEqual([kept[0]?.agents, kept[0]?.tasks, kept[0]?.schedules, kept[0]?.invoked], [[], [], [], []]);
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

  test('the readings since a time, the oldest first, from the files of the months since then; a month back at most', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agenthouse-usage-'));
    try {
      const day = 24 * 3_600_000;
      const now = Date.UTC(2026, 11, 3, 12);
      const reading = (at: number, used: number): AccountLimits => ({ vendor: 'claude', fiveHour: window(used, at + 3_600_000), sevenDay: window(40, now + day), at });
      const line = (entry: object) => `${JSON.stringify({ v: 1, ...entry })}\n`;
      const [old, earlier, week, lately, latest] = [reading(now - 40 * day, 1), reading(now - 20 * day, 2), reading(now - 5 * day, 3), reading(now - 2 * day, 4), reading(now - 3_600_000, 5)] as const;
      // Its windows are not windows, or have no time to start over: the line counts, with what can be read of it.
      const odd = { vendor: 'claude', fiveHour: { usedPct: '12', resetsAt: 5 }, sevenDay: { usedPct: 12, resetsAt: 'soon' }, at: week.at + 1 };
      writeFileSync(path.join(dir, 'limits-2026-10.jsonl'), line(old));
      writeFileSync(
        path.join(dir, 'limits-2026-11.jsonl'),
        [line(earlier), '{"v":1,"vendor":"claude","at":', '\n\n', line({ ...week, v: 2 }), line({ ...week, vendor: 'other' }), line({ ...week, at: 'then' }), 'null\n', line(week), line(odd)].join(''),
      );
      // This month's file as the log writes it, the later reading first.
      const log = new LimitsLog(dir);
      log.append([latest]);
      log.append([lately]);

      assert.deepEqual(await log.since(now - 6 * day, now), [week, { vendor: 'claude', fiveHour: null, sevenDay: window(12, null), at: odd.at }, lately, latest], 'from two files, in the order of their times');
      assert.deepEqual((await log.since(0, now)).map((entry) => entry.at), [earlier.at, week.at, odd.at, lately.at, latest.at], 'nothing from more than a month back, and no line that is none');
      assert.deepEqual(await log.since(now - 1000, now), []);
      assert.deepEqual(await new LimitsLog(path.join(dir, 'none')).since(0, now), [], 'no log yet');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
