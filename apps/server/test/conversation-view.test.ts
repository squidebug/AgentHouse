import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { ConversationEntry, ConversationServerMessage, ConversationTurn, EntryDetail, SessionInfo } from '@agenthouse/protocol';
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

/** The view a browser builds from the socket's reset and update messages. */
function follow(messages: Array<{ type: string; [key: string]: unknown }>) {
  const turns = new Map<number, ConversationTurn>();
  const entries = new Map<string, ConversationEntry>();
  for (const raw of messages) {
    const message = raw as unknown as ConversationServerMessage;
    if (message.type === 'reset') {
      turns.clear();
      entries.clear();
    }
    for (const turn of message.turns) turns.set(turn.index, turn);
    for (const entry of message.entries) entries.set(entry.id, entry);
  }
  return { turns: [...turns.values()], entries: [...entries.values()] };
}

describe('conversation view', () => {
  test('a session that reports like Claude Code: status, then its conversation as it happens', async () => {
    const created = await request(app.port, 'POST', '/api/sessions', { headers, body: { vendor: 'fake', title: 'talk' } });
    const session = created.json as SessionInfo;
    const now = async () => ((await request(app.port, 'GET', '/api/sessions', { headers })).json as SessionInfo[]).find((s) => s.id === session.id);
    const started = await eventually(now, (s) => s?.status.value === 'idle' && s.transcripts.length === 1, 8000);
    assert.equal(started?.transcripts.length, 1, 'hooks reported in');

    const socket = await openSocket(app.port, `/ws/conversation?id=${session.id}`, headers);
    assert.equal(socket.status, 101);
    assert.ok(await waitFor(() => socket.messages.some((m) => m.type === 'reset'), 3000), 'the view starts, empty');

    const compose = (text: string) => request(app.port, 'POST', `/api/sessions/${session.id}/compose`, { headers, body: { text, enterDelayMs: 50, quietMs: 50 } });
    await compose('run a tool please');
    // The answer and the turn's length are separate lines; the view may be read between them.
    const answered = () => {
      const view = follow(socket.messages);
      return view.entries.some((e) => e.kind === 'text' && e.text === 'fake answer: run a tool please') && (view.turns[0]?.durationMs ?? null) !== null;
    };
    assert.ok(await waitFor(answered, 8000), 'prompt, tool call, answer and the turn length arrive');
    const view = follow(socket.messages);
    assert.deepEqual(
      view.entries.map((e) => e.kind),
      ['prompt', 'tool', 'text'],
    );
    const tool = view.entries.find((e) => e.kind === 'tool');
    assert.equal(tool?.kind === 'tool' && tool.state, 'done');
    assert.deepEqual(
      view.turns.map((t) => [t.model, t.usage.calls, t.usage.output, t.durationMs]),
      [['fake-model', 2, 50, 120]],
    );

    // turns=only: when the session worked, without the conversation itself (the flow view).
    const light = await openSocket(app.port, `/ws/conversation?id=${session.id}&turns=only`, headers);
    assert.ok(await waitFor(() => light.messages.some((m) => m.type === 'reset'), 3000));
    const copy = light.messages.find((m) => m.type === 'reset')!;
    assert.deepEqual([(copy.entries as unknown[]).length, (copy.turns as unknown[]).length], [0, 1], 'the turns, no entries');
    light.ws?.close();

    const detail = await request(app.port, 'GET', `/api/sessions/${session.id}/conversation/${encodeURIComponent(tool!.id)}`, { headers });
    assert.equal(detail.status, 200);
    assert.deepEqual([(detail.json as EntryDetail).text, ((detail.json as EntryDetail).input as { command?: string }).command], ['fake-tool-output', 'echo fake-tool-output']);
    assert.equal((await request(app.port, 'GET', `/api/sessions/${session.id}/conversation/nothing`, { headers })).status, 404);

    // /clear: a new transcript, shown after the old conversation.
    await compose('/clear');
    assert.equal((await eventually(now, (s) => s?.transcripts.length === 2, 8000))?.transcripts.length, 2, 'a second transcript');
    await compose('and now?');
    assert.ok(await waitFor(() => follow(socket.messages).entries.some((e) => e.kind === 'text' && e.text === 'fake answer: and now?'), 8000));
    const after = follow(socket.messages);
    assert.deepEqual(
      after.entries.map((e) => (e.kind === 'notice' ? e.notice : e.kind)),
      ['prompt', 'tool', 'text', 'cleared', 'command', 'prompt', 'text'],
    );
    assert.deepEqual(
      after.turns.map((t) => t.segment),
      [0, 1, 1],
    );
    socket.ws?.close();
    await request(app.port, 'DELETE', `/api/sessions/${session.id}`, { headers });
  });

  test('background sub-agents: the tree, their reports, and each one’s own conversation', async () => {
    const created = await request(app.port, 'POST', '/api/sessions', { headers, body: { vendor: 'fake', title: 'agents' } });
    const session = created.json as SessionInfo;
    const now = async () => ((await request(app.port, 'GET', '/api/sessions', { headers })).json as SessionInfo[]).find((s) => s.id === session.id);
    await eventually(now, (s) => s?.status.value === 'idle' && s.transcripts.length === 1, 8000);
    const socket = await openSocket(app.port, `/ws/conversation?id=${session.id}`, headers);
    await request(app.port, 'POST', `/api/sessions/${session.id}/compose`, { headers, body: { text: 'start agents please', enterDelayMs: 50, quietMs: 50 } });

    const settled = await eventually(now, (s) => s?.agents.length === 3 && s.agents.every((a) => a.state === 'stopped') && s.status.value === 'idle', 10_000);
    const agents = settled?.agents ?? [];
    assert.deepEqual(
      agents.map((a) => [a.agentType, a.description, a.parentId === null ? null : agents.findIndex((p) => p.id === a.parentId)]),
      [
        ['Explore', 'Look around', null],
        ['general-purpose', 'Plan the change', null],
        ['Explore', 'Check the tests', 1],
      ],
      'two in parallel, the third started by the second',
    );
    assert.deepEqual(
      agents.map((a) => [a.model, a.tokens, Boolean(a.transcriptPath)]),
      [
        ['fake-small', 1000, true],
        ['fake-small', 1001, true],
        ['fake-small', 1002, true],
      ],
    );

    const answeredBoth = () => follow(socket.messages).entries.some((e) => e.kind === 'text' && e.text === 'Plan the change: plan ready');
    assert.ok(await waitFor(answeredBoth, 8000), 'both reports arrive, and the answer to the last');
    const main = follow(socket.messages);
    assert.deepEqual(
      main.entries.map((e) => (e.kind === 'agent' || e.kind === 'task' ? `${e.kind}:${e.state}` : e.kind)),
      ['prompt', 'agent:done', 'agent:done', 'text', 'task:done', 'text', 'task:done', 'text'],
    );
    assert.equal(main.turns.length, 3, 'each report starts a turn');

    // A sub-agent's own conversation, with the agent it started and that one's report.
    const planner = agents[1]!;
    const own = await openSocket(app.port, `/ws/conversation?id=${session.id}&agent=${planner.id}`, headers);
    assert.equal(own.status, 101);
    assert.ok(await waitFor(() => follow(own.messages).entries.some((e) => e.kind === 'text' && e.text === 'plan ready'), 5000));
    const view = follow(own.messages);
    assert.deepEqual(
      view.entries.map((e) => (e.kind === 'agent' || e.kind === 'task' ? `${e.kind}:${e.state}` : e.kind)),
      ['prompt', 'agent:done', 'text', 'task:done', 'text'],
    );
    const nested = view.entries.find((e) => e.kind === 'agent')!;
    const detail = await request(app.port, 'GET', `/api/sessions/${session.id}/conversation/${encodeURIComponent(nested.id)}?agent=${planner.id}`, { headers });
    assert.equal((detail.json as EntryDetail).text, 'tests pass', "an agent block opens to what it reported");

    for (const bad of ['../x', 'unknown', '']) assert.equal((await openSocket(app.port, `/ws/conversation?id=${session.id}&agent=${encodeURIComponent(bad)}`, headers)).status, 404, bad);
    socket.ws?.close();
    own.ws?.close();
    await request(app.port, 'DELETE', `/api/sessions/${session.id}`, { headers });
  });

  test("a sub-agent's dialog makes the session wait while the main conversation is idle", async () => {
    const created = await request(app.port, 'POST', '/api/sessions', { headers, body: { vendor: 'fake', title: 'asks' } });
    const session = created.json as SessionInfo;
    const now = async () => ((await request(app.port, 'GET', '/api/sessions', { headers })).json as SessionInfo[]).find((s) => s.id === session.id);
    await eventually(now, (s) => s?.status.value === 'idle', 8000);
    await request(app.port, 'POST', `/api/sessions/${session.id}/compose`, { headers, body: { text: 'agentask now', enterDelayMs: 50, quietMs: 50 } });
    const waiting = await eventually(now, (s) => s?.status.value === 'awaiting_permission', 5000);
    assert.deepEqual([waiting?.status.value, waiting?.status.tool, waiting?.agents[0]?.asking], ['awaiting_permission', 'Write', true]);
    const refused = await request(app.port, 'POST', `/api/sessions/${session.id}/compose`, { headers, body: { text: 'hello' } });
    assert.equal((refused.json as { sent: boolean }).sent, false, 'nothing is typed into the dialog');
    const back = await eventually(now, (s) => s?.status.value === 'idle' && s.agents[0]?.state === 'stopped', 8000);
    assert.deepEqual([back?.status.value, back?.agents[0]?.asking], ['idle', false]);
    await request(app.port, 'DELETE', `/api/sessions/${session.id}`, { headers });
  });

  test('sessions without a transcript have no conversation socket', async () => {
    assert.equal((await openSocket(app.port, '/ws/conversation?id=missing', headers)).status, 404);
    assert.equal((await openSocket(app.port, '/ws/conversation?id=x', { ...headers, origin: 'http://evil.example' })).status, 403);
  });
});
