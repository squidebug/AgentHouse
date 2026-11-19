import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentInfo } from '@agenthouse/protocol';
import { agentRows, childAgents, elapsedMs, SHOWN_FINISHED } from '../src/workspace/agents';
import { initialWorkspace, loadWorkspace, reducer, saveWorkspace, type Action, type WorkspaceState } from '../src/workspace/state';

const agent = (id: string, parentId: string | null, state: AgentInfo['state'] = 'stopped', extra: Partial<AgentInfo> = {}): AgentInfo => ({
  id,
  parentId,
  agentType: 'Explore',
  description: id,
  state,
  tool: null,
  asking: false,
  model: null,
  tokens: null,
  startedAt: 1000,
  endedAt: state === 'stopped' ? 4000 : null,
  transcriptPath: null,
  ...extra,
});
const rows = (agents: AgentInfo[], all = false) => agentRows(agents, all).rows.map((r) => `${'.'.repeat(r.depth)}${r.agent.id}`);

test('sub-agents nest under the agent that started them, in the order they started', () => {
  const agents = [agent('a1', null), agent('a2', null, 'running'), agent('a3', 'a2', 'running'), agent('a4', 'gone')];
  assert.deepEqual(rows(agents), ['.a1', '.a2', '..a3', '.a4'], 'an agent whose parent is not listed shows at the top');
  assert.deepEqual(
    childAgents(agents, 'a2').map((a) => a.id),
    ['a3'],
  );
});

test('many finished agents fold away; busy ones stay, with the agents above them', () => {
  const finished = Array.from({ length: SHOWN_FINISHED + 1 }, (_, i) => agent(`f${i}`, null));
  const agents = [...finished, agent('p', 'f1'), agent('busy', 'p', 'running'), agent('asks', null, 'stopped', { asking: true })];
  const folded = agentRows(agents, false);
  assert.deepEqual(rows(agents), ['.f1', '..p', '...busy', '.asks']);
  assert.equal(folded.folded, agents.length - 4);
  assert.equal(rows(agents, true).length, agents.length, 'opened, all of them');
  assert.equal(agentRows(finished.slice(0, SHOWN_FINISHED), false).folded, 0, 'a few finished ones are not folded');
});

test('how long an agent ran, or has been running', () => {
  assert.equal(elapsedMs(agent('a', null), 9000), 3000);
  assert.equal(elapsedMs(agent('b', null, 'running'), 9000), 8000);
});

const ctx = { runningIds: ['s1', 's2'] };
const run = (state: WorkspaceState, ...actions: Action[]) => actions.reduce((s, a) => reducer(s, a, ctx), state);

test('a sub-agent opens in a pane of its own, apart from its session; dropped on the composer, nothing happens', () => {
  let s = run(initialWorkspace, { type: 'open', sessionId: 's1' }, { type: 'openNew', sessionId: 's1', agentId: 'a1' });
  assert.deepEqual(s.panes, [
    { id: 'p1', sessionId: 's1' },
    { id: 'p2', sessionId: 's1', agentId: 'a1' },
  ]);
  s = run(s, { type: 'open', sessionId: 's1' });
  assert.equal(s.active, 'p1', 'the session pane is the one showing the session');
  s = run(s, { type: 'openNew', sessionId: 's1', agentId: 'a1' });
  assert.equal(s.active, 'p2', 'and the agent pane the one showing the agent');

  s = run(s, { type: 'dragStart', drag: { kind: 'agent', id: 'a2', sessionId: 's1' } }, { type: 'drop', target: { type: 'composer' } });
  assert.deepEqual(s.targets, []);
  s = run(s, { type: 'dragStart', drag: { kind: 'agent', id: 'a2', sessionId: 's1' } }, { type: 'drop', target: { type: 'edge', id: 's1', side: 'right' } });
  assert.deepEqual(s.panes.at(-1), { id: 'p3', sessionId: 's1', agentId: 'a2' });
  assert.deepEqual(s.stacks.map((stack) => stack.panes), [['p1', 'p2'], ['p3']], 'dropped at a side of the stack: a stack of its own there');
  s = run(s, { type: 'dragStart', drag: { kind: 'session', id: 's2' } }, { type: 'drop', target: { type: 'pane', id: 'p3' } });
  assert.deepEqual(
    s.panes.at(-1),
    { id: 'p3', sessionId: 's2', history: [{ sessionId: 's1', agentId: 'a2', mode: null }] },
    'a session dropped on an agent pane replaces it, and the agent is a step back',
  );
});

test('agent panes survive a reload', () => {
  const saved = new Map<string, string>();
  const storage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) };
  const s = run(initialWorkspace, { type: 'open', sessionId: 's1', agentId: 'a1' });
  saveWorkspace(s, storage);
  assert.deepEqual(loadWorkspace(storage).panes, [{ id: 'p1', sessionId: 's1', agentId: 'a1' }]);
  saved.set('ah-layout', JSON.stringify({ panes: [{ id: 'p1', sessionId: 's1', agentId: 7 }, { id: 'p2', sessionId: 's2' }] }));
  assert.deepEqual(loadWorkspace(storage).panes, [{ id: 'p2', sessionId: 's2' }], 'a malformed pane is dropped');
});
