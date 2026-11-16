import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { ConversationEntry, ConversationServerMessage, SessionInfo, SkillInfo } from '@agenthouse/protocol';
import { listedSkills, skillsOf } from '../src/claude/skills';
import { eventually, login, openSocket, request, startServer, waitFor, type TestServer } from './helpers';

// The fake agent writes its transcript only under a CLAUDE_CONFIG_DIR, never into ~/.claude.
const config = mkdtempSync(path.join(os.tmpdir(), 'agenthouse-claude-config-'));
process.env.CLAUDE_CONFIG_DIR = config;

let app: TestServer;
let headers: Record<string, string>;

before(async () => {
  app = await startServer();
  headers = { authorization: await login(app), origin: `http://127.0.0.1:${app.port}` };
});

after(async () => {
  await app.close();
  rmSync(config, { recursive: true, force: true });
});

async function start(title: string) {
  const created = await request(app.port, 'POST', '/api/sessions', { headers, body: { vendor: 'fake', title } });
  const session = created.json as SessionInfo;
  const now = async () => ((await request(app.port, 'GET', '/api/sessions', { headers })).json as SessionInfo[]).find((s) => s.id === session.id);
  await eventually(now, (s) => s?.status.value === 'idle' && s.transcripts.length === 1, 8000);
  const tell = (text: string) => request(app.port, 'POST', `/api/sessions/${session.id}/compose`, { headers, body: { text, enterDelayMs: 50, quietMs: 50 } });
  return { session, now, tell };
}

describe('what a session leaves running, sets for later, and the skills it has', () => {
  test('a shell command in the background is listed under its session until it ends; a monitor shows its latest line', async () => {
    const { session, now, tell } = await start('background');
    assert.deepEqual([session.tasks, session.schedules, session.invoked], [[], [], []], 'a new session has none');
    await tell('run it in the background and keep it');
    const running = await eventually(now, (s) => s?.tasks.length === 1 && s.status.value === 'idle', 8000);
    assert.deepEqual(
      running?.tasks.map((t) => [t.type, t.description, t.command, t.state, t.exitCode]),
      [['shell', 'Wait for the build', 'sleep 20; echo done', 'running', null]],
      'the turn that started it has ended, and it runs on',
    );
    await tell('one more in the background');
    const ended = await eventually(now, (s) => s?.tasks.length === 2 && s.tasks[1]?.state === 'done' && s.status.value === 'idle', 8000);
    assert.deepEqual(ended?.tasks.map((t) => [t.state, t.exitCode]), [['running', null], ['done', 0]], 'its end was reported: exit code 0; the first still runs');
    await tell('monitor the deploy');
    const watched = await eventually(now, (s) => s?.tasks.length === 3 && s.tasks[2]?.state === 'done', 8000);
    assert.deepEqual([watched?.tasks[2]?.type, watched?.tasks[2]?.description, watched?.tasks[2]?.lastEvent], ['monitor', 'deploy status', 'deployed 3 of 5']);

    const closed = await request(app.port, 'POST', `/api/sessions/${session.id}/end`, { headers });
    assert.equal(closed.status, 200);
    const after = await eventually(now, (s) => s?.state === 'exited', 8000);
    assert.equal(after?.tasks[0]?.state, 'stopped', 'what still ran ended with the session');
    await request(app.port, 'DELETE', `/api/sessions/${session.id}`, { headers });
  });

  test('a scheduled prompt is listed with its schedule, counts its runs, and its run shows in the conversation as what the turn answers', async () => {
    const { session, now, tell } = await start('schedule');
    const socket = await openSocket(app.port, `/ws/conversation?id=${session.id}`, headers);
    await tell('schedule a check and run it');
    const ran = await eventually(now, (s) => s?.schedules[0]?.runs === 1 && s.status.value === 'idle', 8000);
    const job = ran?.schedules[0];
    assert.deepEqual([job?.schedule, job?.recurring, job?.prompt, job?.runs], ['*/1 * * * *', true, 'check the deploy', 1]);
    assert.ok(job?.lastAt, 'when it last ran');
    assert.ok(job?.nextAt && job.nextAt > Date.now(), 'its next run is as CronCreate said, until that time has passed');

    const entries = () => {
      const all = new Map<string, ConversationEntry>();
      for (const raw of socket.messages) for (const entry of (raw as unknown as ConversationServerMessage).entries) all.set(entry.id, entry);
      return [...all.values()];
    };
    assert.ok(await waitFor(() => entries().some((e) => e.kind === 'text' && e.text === 'the deploy is fine'), 8000));
    const prompts = entries().filter((e) => e.kind === 'prompt');
    assert.deepEqual(
      prompts.map((e) => (e.kind === 'prompt' ? [e.text, e.scheduled ?? false] : null)),
      [
        ['schedule a check and run it', false],
        ['check the deploy', true],
      ],
      'the prompt the CLI gave the session by itself is marked as scheduled',
    );
    socket.ws?.close();
    await request(app.port, 'POST', `/api/sessions/${session.id}/end`, { headers });
    const after = await eventually(now, (s) => s?.state === 'exited', 8000);
    assert.deepEqual(after?.schedules, [], 'nothing is scheduled once its process is gone');
    await request(app.port, 'DELETE', `/api/sessions/${session.id}`, { headers });
  });

  test("the skills of a session's conversation, with the ones it ran marked", async () => {
    const { session, now, tell } = await start('skills');
    const skills = async () => ((await request(app.port, 'GET', `/api/sessions/${session.id}/skills`, { headers })).json as { skills: SkillInfo[] }).skills;
    assert.deepEqual(await skills(), [], 'nothing is listed before the conversation has a transcript');
    await tell('use a skill');
    await eventually(now, (s) => s?.invoked.includes('ping-pong') === true && s.status.value === 'idle', 8000);
    await tell('/loop 1m say hello');
    const used = await eventually(now, (s) => s?.invoked.length === 2 && s.status.value === 'idle', 8000);
    assert.deepEqual(used?.invoked, ['ping-pong', 'loop']);
    assert.deepEqual(
      (await skills()).map((s) => [s.name, s.source, s.used]),
      [
        ['ping-pong', 'builtin', true],
        ['loop', 'builtin', true],
        ['fake-plugin:review', 'plugin', false],
      ],
    );
    assert.equal((await request(app.port, 'GET', '/api/sessions/nope/skills', { headers })).status, 404);
    await request(app.port, 'DELETE', `/api/sessions/${session.id}`, { headers });
  });
});

describe("a transcript's skill listing", () => {
  const dir = path.join(config, 'projects', 'skills-test');
  const file = path.join(dir, 'conversation.jsonl');
  const listing = {
    type: 'attachment',
    attachment: {
      type: 'skill_listing',
      isInitial: true,
      skillCount: 5,
      names: ['dev-api', 'ping-pong', 'loop', 'anthropic-skills:docx', '../../outside', 'loop'],
      content: ['- dev-api: API 명세서로 핸들러 코드를 생성', '- ping-pong: Replies with pong', '- loop: Run a prompt on a recurring interval', '- anthropic-skills:docx: Use this skill for Word documents: reports, memos'].join('\n'),
    },
  };

  before(() => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, [{ type: 'user', message: { role: 'user', content: 'hello "skill_listing"' } }, listing, { type: 'assistant' }].map((r) => JSON.stringify(r)).join('\n') + '\n');
  });

  test('names what the conversation was given and what each is for; names that are no names are left out', async () => {
    assert.deepEqual(await listedSkills(file), [
      { name: 'dev-api', about: 'API 명세서로 핸들러 코드를 생성' },
      { name: 'ping-pong', about: 'Replies with pong' },
      { name: 'loop', about: 'Run a prompt on a recurring interval' },
      { name: 'anthropic-skills:docx', about: 'Use this skill for Word documents: reports, memos' },
    ]);
    assert.deepEqual(await listedSkills(path.join(dir, 'missing.jsonl')), []);
  });

  test('a skill is the project\'s or the user\'s by the folder it lies in, a plugin\'s by its name, else the CLI\'s own', async () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'agenthouse-skills-cwd-'));
    try {
      mkdirSync(path.join(cwd, '.claude', 'skills', 'ping-pong'), { recursive: true });
      mkdirSync(path.join(config, 'skills', 'dev-api'), { recursive: true });
      const session = { cwd, transcripts: [{ vendorSessionId: 'x', path: file, since: 0 }], invoked: ['loop', 'clear'] };
      assert.deepEqual(
        (await skillsOf(session, config)).map((s) => [s.name, s.source, s.used]),
        [
          ['dev-api', 'user', false],
          ['ping-pong', 'project', false],
          ['loop', 'builtin', true],
          ['anthropic-skills:docx', 'plugin', false],
        ],
      );
      // Only one of Claude's own transcripts is read.
      assert.deepEqual(await skillsOf({ ...session, transcripts: [{ vendorSessionId: 'x', path: path.join(cwd, 'elsewhere.jsonl'), since: 0 }] }, config), []);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
