import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { ConversationServerMessage, LatestWords, SessionInfo } from '@agenthouse/protocol';
import { askSessions, listedActivity, listedSessions, listedStatus } from '../src/claude/sessions';
import { latestRun, projectDir, transcriptFile } from '../src/claude/transcript';
import { childEnv } from '../src/shared/child-env';
import { appSettingsFile } from '../src/web/app-settings';
import { ExternalSessions } from '../src/web/external';
import { assistant, jsonl, prompt, text } from './fixtures/transcript';
import { eventually, fakeAgentPath, login, openSocket, request, startServer, waitFor, type TestServer } from './helpers';

// Transcripts are looked for under Claude's config folder: a temporary one, never ~/.claude.
const config = mkdtempSync(path.join(os.tmpdir(), 'agenthouse-claude-config-'));
process.env.CLAUDE_CONFIG_DIR = config;
const scratch = mkdtempSync(path.join(os.tmpdir(), 'agenthouse-external-'));

after(() => {
  rmSync(config, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

const folder = (name: string) => path.join(scratch, name);
/** An entry as `claude agents --json` prints it. */
const listed = (extra: Record<string, unknown> = {}) => ({ pid: 4242, cwd: folder('shop'), kind: 'interactive', startedAt: 1_794_000_000_000, sessionId: randomUUID(), name: 'shop-14', status: 'idle', ...extra });
/** Writes a conversation where Claude would: one prompt and its answer. */
function writeTranscript(file: string, asked: string, answered: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, jsonl([prompt(asked), assistant(`msg-${randomUUID()}`, text(answered), undefined, extra)]));
}

describe("Claude Code's own list of sessions", () => {
  test('an entry is taken when it says whose it is; what else it says is used only where it can be', () => {
    assert.equal(listedSessions({ sessions: [] }), null, 'not a list');
    assert.equal(listedSessions('[]'), null);
    const good = listed({ waitingFor: 'permission prompt', status: 'waiting' });
    const taken = listedSessions([good, listed({ pid: '12' }), listed({ pid: 1.5 }), listed({ pid: 0 }), null, 'text']);
    assert.equal(taken?.length, 1, 'no process id, no session');
    assert.deepEqual(taken?.[0], { pid: 4242, sessionId: good.sessionId, cwd: folder('shop'), name: 'shop-14', startedAt: 1_794_000_000_000, status: 'waiting', waitingFor: 'permission prompt' });
    // The id of a conversation names a file and the folder is opened: neither is taken as it comes.
    const odd = listedSessions([listed({ sessionId: '../../x' }), listed({ sessionId: undefined }), listed({ cwd: 'relative/folder' }), listed({ cwd: 7 })]);
    assert.deepEqual(odd?.map((entry) => [entry.sessionId === null, entry.cwd === null]), [[true, false], [true, false], [false, true], [false, true]]);
    // What is missing or not what it should be is left empty; a name is no longer than a line.
    const bare = listedSessions([listed({ name: 7, startedAt: 'yesterday', status: null }), listed({ name: 'n'.repeat(500) })]);
    assert.deepEqual([bare?.[0]?.name, bare?.[0]?.startedAt, bare?.[0]?.status, bare?.[0]?.waitingFor], [null, null, null, null]);
    assert.equal(bare?.[1]?.name?.length, 200);
  });

  test('idle, busy and waiting are the statuses AgentHouse shows', () => {
    assert.deepEqual(listedStatus({ status: 'idle', waitingFor: null }, null, 5), { value: 'idle', reason: null, tool: null, error: false, at: 5 });
    assert.equal(listedStatus({ status: 'busy', waitingFor: null }, null, 5).value, 'working');
    // An approval says no more than that; anything else it waits for is said in Claude's words.
    assert.deepEqual(listedStatus({ status: 'waiting', waitingFor: 'permission prompt' }, null, 5), { value: 'awaiting_permission', reason: null, tool: null, error: false, at: 5 });
    assert.deepEqual(listedStatus({ status: 'waiting', waitingFor: 'question' }, null, 5), { value: 'awaiting_input', reason: 'question', tool: null, error: false, at: 5 });
    assert.equal(listedStatus({ status: 'waiting', waitingFor: null }, null, 5).value, 'awaiting_input');
    assert.equal(listedStatus({ status: 'something new', waitingFor: null }, null, 5).value, 'unobserved');
    // Still the same: since when stays.
    const idle = listedStatus({ status: 'idle', waitingFor: null }, null, 5);
    assert.equal(listedStatus({ status: 'idle', waitingFor: null }, idle, 9), idle);
    assert.equal(listedStatus({ status: 'busy', waitingFor: null }, idle, 9).at, 9);
    // The words themselves, as the host reads them too when no hook tells it what its own session does.
    assert.deepEqual(
      [{ status: 'idle' }, { status: 'busy' }, { status: 'waiting', waitingFor: 'permission prompt' }, { status: 'waiting' }, { status: 'gone' }, { status: null }].map(listedActivity),
      ['idle', 'working', 'awaiting_permission', 'awaiting_input', null, null],
    );
  });

  test("a conversation's transcript is in the folder named after its project", () => {
    const cwd = process.platform === 'win32' ? 'C:\\work\\my shop_2' : '/work/my shop_2';
    const expected = process.platform === 'win32' ? 'C--work-my-shop-2' : '-work-my-shop-2';
    assert.equal(projectDir(config, cwd), path.join(config, 'projects', expected));
    assert.equal(transcriptFile(config, cwd, 'abc'), path.join(config, 'projects', expected, 'abc.jsonl'));
  });

  test('the latest answer says which model, effort and version a session runs with', () => {
    assert.deepEqual(latestRun([]), { model: null, effort: null, version: null });
    assert.deepEqual(latestRun([prompt('hello')]), { model: null, effort: null, version: null });
    const records = [
      prompt('first'),
      assistant('m1', text('one'), undefined, { effort: 'high', version: '2.1.300' }),
      prompt('second'),
      { ...assistant('m2', text('two'), undefined, { effort: 'max', version: '2.1.326' }), message: { id: 'm2', model: 'claude-opus-5-5', content: [text('two')] } },
      // What the CLI writes itself (an API error) names no model.
      { ...assistant('m3', text('failed')), message: { id: 'm3', model: '<synthetic>', content: [text('failed')] } },
      'not a record',
    ];
    assert.deepEqual(latestRun(records), { model: 'claude-opus-5-5', effort: 'max', version: '2.1.326' });
  });

  test('the test double stands in for the command, with what a check wrote for it', async () => {
    const command = { file: process.execPath, args: [fakeAgentPath, 'agents', '--json'] };
    const own = mkdtempSync(path.join(scratch, 'config-'));
    assert.deepEqual(await askSessions(command, { ...childEnv(), CLAUDE_CONFIG_DIR: own }), [], 'none made up');
    const entry = listed();
    writeFileSync(path.join(own, 'agents.json'), JSON.stringify([entry]));
    assert.deepEqual(await askSessions(command, { ...childEnv(), CLAUDE_CONFIG_DIR: own }), [entry]);
    // A command that fails, or prints something else, gives nothing.
    assert.equal(await askSessions({ file: process.execPath, args: ['-e', 'process.exit(3)'] }, childEnv()), null);
    assert.equal(await askSessions({ file: process.execPath, args: ['-e', 'console.log("no list")'] }, childEnv()), null);
  });
});

describe('sessions started outside AgentHouse', () => {
  /** A watcher of its own for a test, asked by hand: `answer` is what Claude says next. */
  function watcher(own: Array<Partial<SessionInfo>> = []) {
    const state = { answer: [] as unknown, asked: 0, changes: 0, hold: Promise.resolve() };
    const external = new ExternalSessions({
      ask: async () => {
        state.asked += 1;
        // Claude takes its time when a test says so.
        await state.hold;
        return state.answer;
      },
      own: () => own as SessionInfo[],
      configDir: config,
      everyMs: 3_600_000,
    });
    external.on('change', () => (state.changes += 1));
    return { external, state };
  }

  test('one is shown read-only, with what Claude lists and what its transcript says', async () => {
    const { external, state } = watcher();
    const entry = listed({ status: 'busy' });
    const file = transcriptFile(config, entry.cwd, entry.sessionId);
    writeTranscript(file, 'add an index', 'Added.', { effort: 'high', version: '2.1.326' });
    const written = new Date(Date.UTC(2026, 10, 17, 3, 0, 0));
    utimesSync(file, written, written);
    state.answer = [entry];
    external.watch(true);
    await external.ready(5000);
    after(() => external.close());

    const [session] = external.list();
    assert.ok(session);
    assert.equal(external.get(session.id), session);
    assert.equal(session.external, true);
    assert.deepEqual(
      { vendor: session.vendor, title: session.title, cwd: session.cwd, pid: session.pid, state: session.state, screen: session.screen, startedAt: session.startedAt, conversation: session.vendorSessionId },
      { vendor: 'claude', title: 'shop-14', cwd: entry.cwd, pid: 4242, state: 'running', screen: false, startedAt: entry.startedAt, conversation: entry.sessionId },
    );
    assert.deepEqual([session.model, session.effort, session.cli.version], ['claude-haiku-5-5', 'high', '2.1.326']);
    assert.deepEqual(session.transcripts.map((t) => [t.vendorSessionId, t.path]), [[entry.sessionId, file]]);
    // How long it has been at it is not known: its transcript's last line is the closest.
    assert.deepEqual(session.status, { value: 'working', reason: null, tool: null, error: false, at: written.getTime() });
    assert.deepEqual([session.agents, session.tasks, session.schedules, session.invoked], [[], [], [], []]);
    assert.equal(state.changes, 1);

    // The same answer again changes nothing; a new state does, from now on.
    await external.refresh();
    assert.equal(state.changes, 1);
    state.answer = [{ ...entry, status: 'waiting', waitingFor: 'permission prompt' }];
    const asked = Date.now();
    await external.refresh();
    const waiting = external.list()[0];
    assert.equal(waiting?.id, session.id, 'the same session');
    assert.equal(waiting?.status.value, 'awaiting_permission');
    assert.ok((waiting?.status.at ?? 0) >= asked);
    assert.equal(state.changes, 2);

    // Its next answer was given by another model: read again once the transcript has grown.
    writeFileSync(file, readFileSync(file, 'utf8') + jsonl([{ ...assistant('m9', text('More.')), message: { id: 'm9', model: 'claude-opus-5-5', content: [text('More.')] } }]));
    await external.refresh();
    assert.equal(external.list()[0]?.model, 'claude-opus-5-5');

    // It ended: gone at the next answer.
    state.answer = [];
    await external.refresh();
    assert.deepEqual(external.list(), []);
    assert.equal(external.get(session.id), undefined);
  });

  test('one that does not say which conversation it is in or where it runs is not shown, nor one on another machine', async () => {
    const { external, state } = watcher();
    after(() => external.close());
    state.answer = [
      listed({ pid: 60, sessionId: 'not-an-id' }),
      listed({ pid: 61, cwd: 'relative/folder' }),
      // Its notes would be read from there, and Windows sends the user's credentials to such a host.
      listed({ pid: 62, cwd: '\\\\host\\share\\project' }),
      listed({ pid: 63, cwd: '//host/share/project' }),
      listed({ pid: 64 }),
    ];
    external.watch(true);
    await external.ready(5000);
    // Only Windows has such folders: elsewhere `//host/share/project` is the machine's own /host/share/project.
    assert.deepEqual(external.list().map((session) => session.pid), process.platform === 'win32' ? [64] : [63, 64]);
  });

  test('one nobody has asked anything yet has a name, a folder and a state', async () => {
    const { external, state } = watcher();
    after(() => external.close());
    const entry = listed({ pid: 77, name: undefined, cwd: folder('infra'), startedAt: 1_794_000_500_000 });
    state.answer = [entry];
    external.watch(true);
    await external.ready(5000);
    const [session] = external.list();
    assert.equal(session?.title, 'infra', 'its folder stands in for a name');
    assert.deepEqual([session?.model, session?.effort, session?.cli.version], [null, null, null]);
    // Where its transcript will be, once it is asked something: the conversation view waits there.
    assert.deepEqual(session?.transcripts.map((t) => t.path), [transcriptFile(config, entry.cwd, entry.sessionId)]);
    assert.equal(session?.status.at, entry.startedAt, 'idle since it started, for all that is known');
  });

  test('/clear starts a conversation of its own, after the one before', async () => {
    const { external, state } = watcher();
    after(() => external.close());
    const entry = listed({ pid: 78 });
    writeTranscript(transcriptFile(config, entry.cwd, entry.sessionId), 'first', 'One.');
    state.answer = [entry];
    external.watch(true);
    await external.ready(5000);
    const cleared = { ...entry, sessionId: randomUUID() };
    state.answer = [cleared];
    await external.refresh();
    const [session] = external.list();
    assert.equal(external.list().length, 1, 'still one session');
    assert.deepEqual(session?.transcripts.map((t) => t.vendorSessionId), [entry.sessionId, cleared.sessionId]);
    assert.equal(session?.vendorSessionId, cleared.sessionId);
    // What it ran with is the new conversation's to say.
    assert.equal(session?.model, null);
  });

  test("a transcript in another project's folder is found there", async () => {
    const { external, state } = watcher();
    after(() => external.close());
    // Claude names the folder after where the session started; its list says where it is now.
    const entry = listed({ pid: 79, cwd: folder('moved') });
    const actual = path.join(config, 'projects', 'somewhere-else', `${entry.sessionId}.jsonl`);
    writeTranscript(actual, 'where am I', 'Elsewhere.');
    state.answer = [entry];
    external.watch(true);
    await external.ready(5000);
    assert.deepEqual(external.list()[0]?.transcripts.map((t) => t.path), [actual]);
    assert.equal(external.list()[0]?.model, 'claude-haiku-5-5');
  });

  test("AgentHouse's own sessions are in Claude's list too, and are not shown twice", async () => {
    const mine = listed({ pid: 500 });
    const resumedElsewhere = listed({ pid: 501 });
    const endedLongAgo = listed({ pid: 502 });
    const stranger = listed({ pid: 503 });
    const now = Date.now();
    const base = { transcripts: [], exit: null } as Partial<SessionInfo>;
    const { external, state } = watcher([
      { ...base, id: 'a', pid: 500, state: 'running', vendorSessionId: 'something-else' },
      // After /clear its conversation is another one, with the same process.
      { ...base, id: 'b', pid: 9999, state: 'running', vendorSessionId: null, transcripts: [{ vendorSessionId: resumedElsewhere.sessionId, path: 'x', since: 0 }] },
      // An ended one whose process id came around again, or whose conversation was taken up in a terminal: that is a stranger.
      { ...base, id: 'c', pid: 502, state: 'exited', exit: { code: 0, signal: null, at: now - 600_000 }, vendorSessionId: stranger.sessionId },
      // One that ended a moment ago may still be listed.
      { ...base, id: 'd', pid: 504, state: 'exited', exit: { code: 0, signal: null, at: now - 1000 }, vendorSessionId: null },
    ]);
    after(() => external.close());
    state.answer = [mine, resumedElsewhere, endedLongAgo, stranger, listed({ pid: 504 })];
    external.watch(true);
    await external.ready(5000);
    assert.deepEqual(external.list().map((s) => s.pid).sort(), [502, 503]);
  });

  test('an answer that fails now and then leaves them where they are', async () => {
    const { external, state } = watcher();
    after(() => external.close());
    state.answer = [listed({ pid: 80 })];
    external.watch(true);
    await external.ready(5000);
    state.answer = null;
    await external.refresh();
    await external.refresh();
    assert.equal(external.list().length, 1, 'two answers missing');
    await external.refresh();
    assert.deepEqual(external.list(), [], 'three: Claude has no list to give');
    state.answer = 'not a list';
    await external.refresh();
    assert.deepEqual(external.list(), []);
  });

  test('asked only while someone looks; what was known stays until asked again or turned off', async () => {
    const { external, state } = watcher();
    after(() => external.close());
    state.answer = [listed({ pid: 81 })];
    await external.ready(1000);
    assert.equal(state.asked, 0, 'nobody looks');
    external.watch(true);
    external.watch(true);
    await external.ready(5000);
    assert.equal(state.asked, 1, 'at once, and once');
    external.watch(false);
    assert.equal(external.list().length, 1, 'a page that comes back finds it');
    // An answer that comes in after watching stopped is not taken.
    state.answer = [];
    await external.refresh();
    assert.equal(external.list().length, 1);
    // A page that comes back does not wait for Claude again: it gets what was known, and the answer under way puts it right.
    let answerNow = () => {};
    state.hold = new Promise<void>((resolve) => (answerNow = resolve));
    external.watch(true);
    const late = new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 2000).unref());
    assert.equal(await Promise.race([external.ready(60_000).then(() => 'at once'), late]), 'at once');
    assert.equal(external.list().length, 1);
    answerNow();
    await external.refresh();
    assert.deepEqual(external.list(), [], 'put right by the next answer');
    state.hold = Promise.resolve();

    state.answer = [listed({ pid: 82 })];
    await external.refresh();
    const changes = state.changes;
    external.clear();
    assert.deepEqual(external.list(), []);
    assert.equal(state.changes, changes + 1);
  });
});

describe('sessions started outside AgentHouse, in the web server', () => {
  let app: TestServer;
  let headers: Record<string, string>;
  const state = { answer: [] as unknown, asked: 0 };
  const entry = listed({ pid: 31_337, cwd: folder('served'), name: 'outside' });
  const sessions = async () => (await request(app.port, 'GET', '/api/sessions', { headers })).json as SessionInfo[];

  before(async () => {
    writeTranscript(transcriptFile(config, entry.cwd, entry.sessionId), 'what is the plan', 'Three steps.');
    app = await startServer({
      claudeSessions: async () => {
        state.asked += 1;
        return state.answer;
      },
    });
    headers = { authorization: await login(app), origin: `http://127.0.0.1:${app.port}` };
  });

  after(async () => {
    await app.close();
  });

  test('a page gets them in its first list, and Claude is asked only while a page is open', async () => {
    state.answer = [entry];
    assert.deepEqual(await sessions(), [], 'nobody looks yet');
    assert.equal(state.asked, 0);

    const events = await openSocket(app.port, '/ws/events', headers);
    assert.equal(events.status, 101);
    assert.ok(await waitFor(() => events.messages.some((m) => m.type === 'external'), 5000));
    const first = events.messages.find((m) => m.type === 'sessions');
    const listedThere = (first?.sessions as SessionInfo[]).filter((s) => s.external);
    assert.equal(listedThere.length, 1, 'in the first list, not a later one');
    assert.equal(listedThere[0]?.title, 'outside');
    assert.deepEqual(events.messages.find((m) => m.type === 'external'), { type: 'external', on: true });
    assert.equal(state.asked, 1);

    // The page closes: nobody is asked for on its behalf, and what was known stays for when it comes back.
    events.ws?.close();
    assert.ok(await waitFor(() => events.ws?.readyState === 3, 2000));
    assert.equal((await sessions()).filter((s) => s.external).length, 1);
    const again = await openSocket(app.port, '/ws/events', headers);
    assert.ok(await waitFor(() => again.messages.some((m) => m.type === 'sessions'), 5000));
    assert.equal(state.asked, 2, 'asked again when a page opens');
    again.ws?.close();
  });

  test('its conversation is read like any other', async () => {
    const [session] = (await sessions()).filter((s) => s.external);
    assert.ok(session);
    const latest = (await request(app.port, 'GET', `/api/sessions/${session.id}/latest`, { headers })).json as LatestWords;
    assert.equal(latest.prompt, 'what is the plan');
    assert.equal(latest.answer, 'Three steps.');

    const socket = await openSocket(app.port, `/ws/conversation?id=${session.id}`, headers);
    assert.equal(socket.status, 101);
    assert.ok(await waitFor(() => socket.messages.some((m) => m.type === 'reset'), 5000));
    const reset = socket.messages.find((m) => m.type === 'reset') as unknown as ConversationServerMessage;
    assert.deepEqual(reset.entries.map((e) => e.kind), ['prompt', 'text']);
    socket.ws?.close();
    // It has no terminal here.
    assert.equal((await openSocket(app.port, `/ws/session?id=${session.id}`, headers)).status, 404);
  });

  test('what only a session of AgentHouse can do is refused for it', async () => {
    const [session] = (await sessions()).filter((s) => s.external);
    assert.ok(session);
    const created = await request(app.port, 'POST', '/api/sessions', { headers, body: { vendor: 'fake', title: 'own' } });
    const own = created.json as SessionInfo;
    const call = (method: string, route: string, body?: unknown) => request(app.port, method, `/api/sessions/${route}`, { headers, ...(body === undefined ? {} : { body }) });
    const refused = async (reply: Promise<{ status: number; json: unknown }>, status: number, code: string, label: string) => {
      const { status: got, json } = await reply;
      assert.deepEqual([got, (json as { code?: string } | null)?.code], [status, code], label);
    };
    await refused(call('POST', `${session.id}/end`), 409, 'EXTERNAL_SESSION', 'end');
    await refused(call('DELETE', session.id), 409, 'EXTERNAL_SESSION', 'remove');
    await refused(call('POST', `${session.id}/compose`, { text: 'hello' }), 409, 'EXTERNAL_SESSION', 'compose');
    await refused(call('POST', `${session.id}/resume`, {}), 409, 'SESSION_RUNNING', 'resume');
    await refused(call('PUT', `${session.id}/link`, { parentId: own.id }), 400, 'INVALID_REQUEST', 'under a session');
    await refused(call('PUT', `${own.id}/link`, { parentId: session.id }), 400, 'INVALID_REQUEST', 'a session under it');
    assert.equal((await sessions()).filter((s) => s.external).length, 1, 'still listed');
    await call('DELETE', own.id);
  });

  test('turned off, they are gone and Claude is no longer asked; the choice is kept', async () => {
    const events = await openSocket(app.port, '/ws/events', headers);
    assert.ok(await waitFor(() => events.messages.some((m) => m.type === 'external'), 5000));
    const asked = state.asked;

    const off = await request(app.port, 'PUT', '/api/external', { headers, body: { on: false } });
    assert.deepEqual([off.status, off.json], [200, { on: false }]);
    assert.ok(await waitFor(() => events.messages.some((m) => m.type === 'external' && m.on === false), 3000), 'every page hears of it');
    assert.ok(await waitFor(() => (events.messages.filter((m) => m.type === 'sessions').at(-1)?.sessions as SessionInfo[]).every((s) => !s.external), 3000));
    assert.deepEqual((await sessions()).filter((s) => s.external), []);
    assert.equal(JSON.parse(readFileSync(appSettingsFile(app.stateDir), 'utf8')).external, false);
    // A page that opens now is told so, and nothing is asked for it.
    const later = await openSocket(app.port, '/ws/events', headers);
    assert.ok(await waitFor(() => later.messages.some((m) => m.type === 'external'), 5000));
    assert.deepEqual(later.messages.find((m) => m.type === 'external'), { type: 'external', on: false });
    assert.equal(state.asked, asked);
    later.ws?.close();

    const on = await request(app.port, 'PUT', '/api/external', { headers, body: { on: true } });
    assert.equal(on.status, 200);
    const back = await eventually(sessions, (list) => list.some((s) => s.external), 5000);
    assert.equal(back.filter((s) => s.external).length, 1, 'asked again at once');
    assert.equal(JSON.parse(readFileSync(appSettingsFile(app.stateDir), 'utf8')).external, undefined);
    assert.equal((await request(app.port, 'PUT', '/api/external', { headers, body: { on: 'yes' } })).status, 400);
    events.ws?.close();
  });
});
