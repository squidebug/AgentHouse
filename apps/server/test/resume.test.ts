import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { ConversationEntry, ConversationServerMessage, SessionInfo } from '@agenthouse/protocol';
import { isAlive } from '../src/shared/kill-tree';
import { eventually, login, openSocket, plain, request, screenText, startServer, waitFor, type TestServer } from './helpers';

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

const sessions = async () => (await request(app.port, 'GET', '/api/sessions', { headers })).json as SessionInfo[];
const sessionNow = async (id: string) => (await sessions()).find((s) => s.id === id);
const create = async (body: Record<string, unknown>) => (await request(app.port, 'POST', '/api/sessions', { headers, body: { vendor: 'fake', ...body } })).json as SessionInfo;
const compose = (id: string, text: string) => request(app.port, 'POST', `/api/sessions/${id}/compose`, { headers, body: { text, enterDelayMs: 50, quietMs: 50 } });
const resume = (id: string, body: Record<string, unknown> = {}) => request(app.port, 'POST', `/api/sessions/${id}/resume`, { headers, body });
/** Idle, with the transcript its first hook named. */
const reported = (id: string) => eventually(() => sessionNow(id), (s) => s?.status.value === 'idle' && s.transcripts.length === 1, 8000);
/** The answers in a transcript, in order. */
function answers(file: string): string[] {
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type?: string; message?: { content?: Array<{ type?: string; text?: string }> } })
    .filter((record) => record.type === 'assistant')
    .flatMap((record) => (record.message?.content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? ''));
}
const terminalShows = async (id: string, text: string) => {
  const term = await openSocket(app.port, `/ws/session?id=${id}`, headers);
  const shown = await waitFor(() => plain(screenText(term.messages)).includes(text), 5000);
  term.ws?.close();
  return shown;
};

describe('an ended session started again', () => {
  test('it is the same session, running, and its conversation goes on in the transcript it had', async () => {
    const created = await create({ title: 'again', model: 'opus', effort: 'high' });
    const transcript = (await reported(created.id))?.transcripts[0];
    assert.ok(transcript?.vendorSessionId, 'its conversation has the id AgentHouse chose');
    await compose(created.id, 'first question');
    assert.ok(await waitFor(() => answers(transcript.path).length === 1, 8000), 'a turn before it ends');

    const running = await resume(created.id);
    assert.deepEqual([running.status, (running.json as { code?: string }).code], [409, 'SESSION_RUNNING'], 'a session that runs has nothing to resume');

    assert.equal((await request(app.port, 'POST', `/api/sessions/${created.id}/end`, { headers })).status, 200);
    const ended = await sessionNow(created.id);
    assert.deepEqual([ended?.state, ended?.screen], ['exited', false]);

    // Asked twice at once, as a double click does: it starts once.
    const [resumed, second] = await Promise.all([resume(created.id, { theme: 'light' }), resume(created.id, { theme: 'light' })]);
    assert.deepEqual([resumed.status, second.status, (second.json as { code?: string }).code], [201, 409, 'RESUME_IN_PROGRESS']);
    const again = resumed.json as SessionInfo;
    assert.deepEqual(
      [again.id, again.title, again.cwd, again.model, again.effort, again.vendorSessionId, again.state],
      [created.id, 'again', created.cwd, 'opus', 'high', transcript.vendorSessionId, 'running'],
      'the same session with what it was launched with, on the conversation it had',
    );
    assert.notEqual(again.pid, created.pid, 'another process');
    const live = await reported(created.id);
    assert.deepEqual([live?.state, live?.screen, live?.transcripts[0]?.path], ['running', true, transcript.path], 'it reports in, on the same transcript');
    assert.equal((await sessions()).filter((s) => s.title === 'again').length, 1, 'one session in the list, not two');
    assert.ok(await terminalShows(created.id, `REPORT resumed=${transcript.vendorSessionId}`), 'the CLI was told to go on with that conversation');

    await compose(created.id, 'second question');
    assert.ok(await waitFor(() => answers(transcript.path).length === 2, 8000), 'the next turn is written after the first');
    assert.deepEqual(answers(transcript.path), ['fake answer: first question', 'fake answer: second question']);

    // The conversation view reads it whole: what was said before it ended, and after.
    const socket = await openSocket(app.port, `/ws/conversation?id=${created.id}`, headers);
    const texts = () =>
      socket.messages
        .flatMap((message) => (message as unknown as ConversationServerMessage).entries ?? [])
        .filter((entry): entry is Extract<ConversationEntry, { kind: 'text' }> => entry.kind === 'text')
        .map((entry) => entry.text);
    assert.ok(await waitFor(() => texts().includes('fake answer: first question') && texts().includes('fake answer: second question'), 8000), 'both turns show');
    socket.ws?.close();
    assert.equal((await request(app.port, 'DELETE', `/api/sessions/${created.id}`, { headers })).status, 200);
  });

  test('one that ended by itself is let go by the host first, which still held its last screen', async () => {
    const created = await create({ title: 'quit' });
    const transcript = (await reported(created.id))?.transcripts[0];
    assert.ok(transcript);
    await compose(created.id, 'a question');
    assert.ok(await waitFor(() => answers(transcript.path).length === 1, 8000));
    // The fake agent leaves on this word, as a CLI the user quit would.
    await compose(created.id, 'exit');
    const quit = await eventually(() => sessionNow(created.id), (s) => s?.state === 'exited', 8000);
    assert.deepEqual([quit?.state, quit?.screen], ['exited', true], 'ended, its screen still with the host');

    const resumed = await resume(created.id);
    assert.equal(resumed.status, 201);
    const live = await reported(created.id);
    assert.deepEqual([live?.id, live?.state, live?.transcripts[0]?.path], [created.id, 'running', transcript.path]);
    assert.ok(isAlive(live?.pid ?? 0));
    assert.equal((await request(app.port, 'DELETE', `/api/sessions/${created.id}`, { headers })).status, 200);
  });

  test('without a conversation on disk, or without its folder, nothing is started', async () => {
    // Its first hook names the transcript, but nothing was asked, so nothing was written: Claude Code would find no conversation.
    const silent = await create({ title: 'silent' });
    const named = await reported(silent.id);
    assert.equal(answers(named?.transcripts[0]?.path ?? '').length, 0);
    assert.equal((await request(app.port, 'POST', `/api/sessions/${silent.id}/end`, { headers })).status, 200);
    const refused = await resume(silent.id);
    assert.deepEqual([refused.status, (refused.json as { code?: string }).code], [409, 'NO_CONVERSATION']);

    const folder = await mkdtemp(path.join(os.tmpdir(), 'agenthouse-gone-'));
    const moved = await create({ title: 'moved', cwd: folder });
    const transcript = (await reported(moved.id))?.transcripts[0];
    assert.ok(transcript);
    await compose(moved.id, 'a question');
    assert.ok(await waitFor(() => answers(transcript.path).length === 1, 8000));
    assert.equal((await request(app.port, 'POST', `/api/sessions/${moved.id}/end`, { headers })).status, 200);
    await rm(folder, { recursive: true, force: true });
    const gone = await resume(moved.id);
    assert.deepEqual([gone.status, (gone.json as { code?: string }).code], [400, 'CWD_NOT_FOUND']);

    for (const id of [silent.id, moved.id]) {
      const still = await sessionNow(id);
      assert.deepEqual([still?.state, still?.title], ['exited', id === silent.id ? 'silent' : 'moved'], 'it stays listed, ended, as it was');
      assert.equal((await request(app.port, 'DELETE', `/api/sessions/${id}`, { headers })).status, 200);
    }
    assert.equal((await resume('no-such-session')).status, 404);
  });
});
