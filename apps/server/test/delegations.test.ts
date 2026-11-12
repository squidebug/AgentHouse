import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { ComposeRequest, ConversationEntry, DelegationInfo, SessionInfo, StatusValue } from '@agenthouse/protocol';
import type { ComposeOutcome } from '../src/shared/host-protocol';
import { Delegations, delegationsFile } from '../src/web/delegations';
import type { SessionManager } from '../src/web/manager';
import { eventually, login, openSocket, request, startServer, waitFor, type Socket, type TestServer } from './helpers';

// The fake agent writes its transcript only under a CLAUDE_CONFIG_DIR, never into ~/.claude.
const config = mkdtempSync(path.join(os.tmpdir(), 'agenthouse-claude-config-'));
process.env.CLAUDE_CONFIG_DIR = config;

let app: TestServer;
let headers: Record<string, string>;

before(async () => {
  app = await startServer();
  headers = { cookie: await login(app.port, app.token), origin: `http://127.0.0.1:${app.port}` };
});

after(async () => {
  await app.close();
  rmSync(config, { recursive: true, force: true });
});

const sessions = async () => (await request(app.port, 'GET', '/api/sessions', { headers })).json as SessionInfo[];
async function start(title: string): Promise<string> {
  const id = ((await request(app.port, 'POST', '/api/sessions', { headers, body: { vendor: 'fake', title } })).json as SessionInfo).id;
  await eventually(sessions, (list) => list.find((s) => s.id === id)?.status.value === 'idle', 8000);
  return id;
}
const latest = (events: Socket, id: string) =>
  events.messages
    .filter((m) => m.type === 'delegations')
    .map((m) => (m.delegations as DelegationInfo[]).find((d) => d.id === id))
    .filter(Boolean)
    .at(-1);

describe('delegation', () => {
  test('work goes to the delegate, its answer comes back as a summary and, when asked, to the parent', async () => {
    const parent = await start('lead');
    const child = await start('helper');
    const events = await openSocket(app.port, '/ws/events', headers);
    const delegate = (body: object) => request(app.port, 'POST', `/api/sessions/${parent}/delegations`, { headers, body });

    assert.equal((await delegate({ childId: child, text: 'summarize the readme' })).status, 400, 'only to a session delegated under it');
    await request(app.port, 'PUT', `/api/sessions/${child}/link`, { headers, body: { parentId: parent, kind: 'delegate' } });
    assert.equal((await delegate({ childId: 'missing', text: 'x' })).status, 404);

    const sent = await delegate({ childId: child, text: 'summarize the readme' });
    assert.equal(sent.status, 201);
    const task = sent.json as DelegationInfo;
    assert.deepEqual([task.status, task.delivery, task.parentId, task.childId], ['running', 'none', parent, child]);

    assert.ok(await waitFor(() => latest(events, task.id)?.status === 'done', 8000), 'done once the delegate is idle again');
    assert.equal(latest(events, task.id)?.summary, 'fake answer: summarize the readme');
    const stored = readFileSync(delegationsFile(app.stateDir), 'utf8');
    assert.ok(stored.includes(task.id) && !stored.includes('fake answer'), 'where the answer is, not the answer');

    const conversation = await openSocket(app.port, `/ws/conversation?id=${parent}`, headers);
    const delivered = await request(app.port, 'POST', `/api/delegations/${task.id}/deliver`, { headers, body: { header: '[위임 결과 · helper]' } });
    assert.equal((delivered.json as DelegationInfo).delivery, 'sent', 'the parent was idle: sent at once');
    const prompts = () =>
      conversation.messages.flatMap((m) => (m.entries as ConversationEntry[]) ?? []).filter((e): e is Extract<ConversationEntry, { kind: 'prompt' }> => e.kind === 'prompt');
    assert.ok(
      await waitFor(() => prompts().some((p) => p.text.startsWith('[위임 결과 · helper]') && p.text.includes('fake answer: summarize the readme')), 8000),
      'the parent got the answer as a message',
    );
    const again = await request(app.port, 'POST', `/api/delegations/${task.id}/deliver`, { headers, body: { header: 'again' } });
    assert.equal((again.json as DelegationInfo).delivery, 'sent', 'delivered once');
    assert.equal((await request(app.port, 'POST', `/api/delegations/missing/deliver`, { headers, body: { header: 'x' } })).status, 404);
    assert.equal((await request(app.port, 'POST', `/api/delegations/${task.id}/deliver`, { headers, body: { header: 'two\nlines' } })).status, 400);
    conversation.ws?.close();
    events.ws?.close();
    for (const id of [child, parent]) await request(app.port, 'DELETE', `/api/sessions/${id}`, { headers });
  });

  test('a parent waiting on a dialog gets the answer only once it is idle again', async () => {
    const parent = await start('lead2');
    const child = await start('helper2');
    const events = await openSocket(app.port, '/ws/events', headers);
    await request(app.port, 'PUT', `/api/sessions/${child}/link`, { headers, body: { parentId: parent, kind: 'delegate' } });
    const task = (await request(app.port, 'POST', `/api/sessions/${parent}/delegations`, { headers, body: { childId: child, text: 'check the build' } })).json as DelegationInfo;
    assert.ok(await waitFor(() => latest(events, task.id)?.status === 'done', 8000));

    // A sub-agent of the parent asks for approval for a moment.
    await request(app.port, 'POST', `/api/sessions/${parent}/compose`, { headers, body: { text: 'agentask now', enterDelayMs: 50, quietMs: 50 } });
    await eventually(sessions, (list) => list.find((s) => s.id === parent)?.status.value === 'awaiting_permission', 5000);
    const queued = await request(app.port, 'POST', `/api/delegations/${task.id}/deliver`, { headers, body: { header: '[위임 결과 · helper2]' } });
    assert.equal((queued.json as DelegationInfo).delivery, 'queued', 'nothing is typed into a dialog');
    assert.ok(await waitFor(() => latest(events, task.id)?.delivery === 'sent', 10_000), 'sent once the parent is idle');

    // Removing the delegate takes its work off the list.
    await request(app.port, 'DELETE', `/api/sessions/${child}`, { headers });
    const listed = () => (events.messages.filter((m) => m.type === 'delegations').at(-1)?.delegations as DelegationInfo[] | undefined) ?? [];
    assert.ok(await waitFor(() => !listed().some((d) => d.id === task.id), 5000));
    events.ws?.close();
    await request(app.port, 'DELETE', `/api/sessions/${parent}`, { headers });
  });
});

describe('delegation, with the host stood in for', () => {
  test('text that went in but whose Enter was held back gets only its Enter later, never a second paste', async () => {
    const dir = path.join(config, 'projects', 'C--stub');
    mkdirSync(dir, { recursive: true });
    const transcript = path.join(dir, 'child.jsonl');
    writeFileSync(transcript, '');
    const at = (value: StatusValue, when = Date.now()) => ({ value, reason: null, tool: null, error: false, at: when });
    const sessions = new Map<string, SessionInfo>();
    const put = (id: string, value: StatusValue, when?: number) =>
      sessions.set(id, {
        id,
        vendor: 'claude',
        state: 'running',
        status: at(value, when),
        agents: [],
        transcripts: id === 'child' ? [{ vendorSessionId: 'c', path: transcript, since: 0 }] : [],
        exit: null,
      } as unknown as SessionInfo);
    put('parent', 'idle');
    put('child', 'idle');
    const calls: Array<{ id: string } & ComposeRequest> = [];
    const replies: ComposeOutcome[] = [];
    const manager = Object.assign(new EventEmitter(), {
      get: (id: string) => sessions.get(id),
      links: () => [{ childId: 'child', parentId: 'parent', kind: 'delegate' }],
      compose: async (id: string, request: ComposeRequest): Promise<ComposeOutcome> => {
        calls.push({ id, ...request });
        return replies.shift() ?? { sent: true, submitted: true };
      },
    });
    const state = mkdtempSync(path.join(os.tmpdir(), 'agenthouse-delegations-'));
    const delegations = new Delegations(manager as unknown as SessionManager, delegationsFile(state));
    const changed = () => manager.emit('change');
    try {
      replies.push({ sent: false, submitted: false, reason: 'starting' });
      await assert.rejects(delegations.delegate('parent', 'child', 'too early'), /시작 중/);

      // In the delegate's input, but a dialog opened before Enter: the work is there, Enter is left.
      replies.push({ sent: true, submitted: false, reason: 'awaiting_permission' });
      const task = await delegations.delegate('parent', 'child', 'check the build');
      assert.equal(task.status, 'running');
      put('child', 'idle', Date.now() + 1);
      changed();
      assert.ok(await waitFor(() => calls.length === 3, 3000), 'Enter, once the delegate is free again');
      assert.deepEqual(calls[2], { id: 'child', text: '', enterOnly: true, verify: true });

      appendFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'build is green' }] } })}\n`);
      put('child', 'idle', Date.now() + 1000);
      changed();
      assert.ok(await waitFor(() => delegations.list()[0]?.status === 'done', 3000));

      // The answer goes into the parent's input, then a dialog opens: only Enter follows.
      replies.push({ sent: true, submitted: false, reason: 'awaiting_input' });
      const queued = await delegations.deliver(task.id, '[위임 결과 · child]');
      assert.equal(queued.delivery, 'queued');
      assert.deepEqual(calls[3], { id: 'parent', text: '[위임 결과 · child]\nbuild is green', verify: true }, 'nobody may be watching: the CLI is asked too');
      changed();
      assert.ok(await waitFor(() => delegations.list()[0]?.delivery === 'sent', 3000));
      assert.deepEqual(calls[4], { id: 'parent', text: '', enterOnly: true, verify: true });
      assert.equal(calls.length, 5, 'the answer went in once');
    } finally {
      delegations.close();
      rmSync(state, { recursive: true, force: true });
    }
  });
});
