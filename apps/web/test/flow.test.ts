import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentInfo, ConversationTurn, SessionInfo, SessionLink, SessionStatus } from '@agenthouse/protocol';
import { agentBars, ago, flowRows, labelPlace, place, sessionBars, ticks, timeWindow } from '../src/workspace/flow';
import { initialWorkspace, loadWorkspace, reducer, saveWorkspace, type Action, type WorkspaceState } from '../src/workspace/state';

const status = (value: SessionStatus['value'], at = 0): SessionStatus => ({ value, reason: null, tool: null, error: false, at });
const session = (id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({ id, title: id, cwd: '/w', startedAt: 0, status: status('idle'), agents: [], transcripts: [], exit: null, ...extra }) as SessionInfo;
const agent = (id: string, parentId: string | null, state: AgentInfo['state'], startedAt: number, endedAt: number | null = null): AgentInfo => ({
  id,
  parentId,
  agentType: 'general-purpose',
  description: id,
  state,
  tool: null,
  asking: false,
  model: null,
  tokens: null,
  startedAt,
  endedAt,
  transcriptPath: null,
});
const keys = (rows: ReturnType<typeof flowRows>) => rows.map((r) => `${'.'.repeat(r.depth)}${r.kind === 'agent' ? r.agent.id : r.session.id}`);

test('the flow: the session, its agents nested as they started one another, then the sessions placed under it', () => {
  const lead = session('lead', { agents: [agent('a1', null, 'stopped', 10, 20), agent('a2', null, 'running', 15), agent('a3', 'a2', 'running', 30)] });
  const helper = session('helper', { agents: [agent('h1', null, 'stopped', 5, 9)] });
  const links: SessionLink[] = [{ childId: 'helper', parentId: 'lead', kind: 'delegate' }];
  assert.deepEqual(keys(flowRows(lead, [helper], links)), ['lead', '.a1', '.a2', '..a3', '.helper', '..h1']);
  assert.deepEqual(keys(flowRows(lead, [helper], links, 'running')), ['lead', '.a2', '..a3'], 'only what runs, with the rows above it');
});

test('bars: an agent from its start to its end or now; a session per turn, the one going on until now', () => {
  assert.deepEqual(agentBars(agent('a', null, 'running', 100), 500), [{ from: 100, to: 500, kind: 'working' }]);
  assert.deepEqual(agentBars({ ...agent('a', null, 'running', 100), asking: true }, 500), [{ from: 100, to: 500, kind: 'waiting' }]);
  assert.deepEqual(agentBars(agent('a', null, 'stopped', 100, 300), 500), [{ from: 100, to: 300, kind: 'done' }]);
  const turn = (index: number, startedAt: number | null, endedAt: number | null) => ({ index, startedAt, endedAt }) as ConversationTurn;
  const working = session('s', { status: status('working', 400) });
  assert.deepEqual(sessionBars(working, [turn(1, 300, 350), turn(0, 100, 200), turn(2, null, null)], 500), [
    { from: 100, to: 200, kind: 'done' },
    { from: 300, to: 500, kind: 'working' },
  ]);
  assert.deepEqual(sessionBars(working, null, 500), [{ from: 400, to: 500, kind: 'working' }], 'without turns: since its status changed');
  assert.deepEqual(sessionBars(session('i', { startedAt: 100, status: status('idle', 300) }), [], 500), [], 'idle without turns: nothing known to show');
});

test('the window runs from the earliest bar to now, between two minutes and an hour; marks and short times', () => {
  const now = 10 * 3_600_000;
  assert.deepEqual(timeWindow([{ from: now - 30 * 60_000, to: now, kind: 'working' }], now), { from: now - 30 * 60_000, to: now });
  assert.deepEqual(timeWindow([{ from: now - 5 * 3_600_000, to: now, kind: 'working' }], now), { from: now - 3_600_000, to: now });
  assert.deepEqual(timeWindow([{ from: now - 1000, to: now, kind: 'working' }], now), { from: now - 120_000, to: now });
  const window = { from: 0, to: 1000 };
  assert.deepEqual(place({ from: 250, to: 500, kind: 'done' }, window), { left: 25, width: 25 });
  assert.deepEqual(place({ from: -500, to: 100, kind: 'done' }, window), { left: 0, width: 10 }, 'cut at the window');
  assert.equal(place({ from: -500, to: -100, kind: 'done' }, window), null);
  assert.equal(place({ from: 500, to: 500, kind: 'done' }, window)?.width, 0.8, 'a moment still shows');
  assert.deepEqual(labelPlace([{ from: 250, to: 500, kind: 'done' }], window), { left: 25 }, 'a name starts where its first bar starts');
  assert.deepEqual(
    labelPlace(
      [
        { from: 800, to: 900, kind: 'done' },
        { from: 950, to: 1000, kind: 'working' },
      ],
      window,
    ),
    { right: 10 },
    'in the right half, it ends where that bar ends',
  );
  assert.deepEqual(labelPlace([{ from: -500, to: -100, kind: 'done' }], window), { left: 0 }, 'no bar in the window: at the start');
  assert.deepEqual(
    ticks({ from: 0, to: 600_000 }).map((m) => [m.pct, ago(m.ago)]),
    [
      [0, '10분'],
      [25, '7분 30초'],
      [50, '5분'],
      [75, '2분 30초'],
      [100, '0초'],
    ],
  );
  assert.deepEqual([ago(90_000), ago(120_000), ago(1_500_000), ago(3_900_000)], ['1분 30초', '2분', '25분', '1시간 5분']);
});

const run = (state: WorkspaceState, ...actions: Action[]) => actions.reduce((s, a) => reducer(s, a), state);

test('a sub-agent picked in the tree shows its session’s flow; from there a lane opens in the pane, and back returns to it', () => {
  let s = run(initialWorkspace, { type: 'open', sessionId: 'lead' });
  assert.equal(s.paneMode.p1, undefined, 'the terminal first');
  s = run(s, { type: 'open', sessionId: 'lead', mode: 'flow', focusAgent: 'a2' });
  assert.deepEqual([s.panes.length, s.paneMode.p1, s.flowFocus], [1, 'flow', { paneId: 'p1', agentId: 'a2' }]);
  s = run(s, { type: 'drill', paneId: 'p1', sessionId: 'lead', agentId: 'a2' });
  assert.deepEqual([s.panes[0]?.agentId, s.paneMode.p1, s.flowFocus], ['a2', undefined, null]);
  s = run(s, { type: 'drill', paneId: 'p1', sessionId: 'lead', agentId: 'a3' });
  s = run(s, { type: 'back', paneId: 'p1' });
  assert.equal(s.panes[0]?.agentId, 'a2', 'one step back');
  s = run(s, { type: 'back', paneId: 'p1' });
  assert.deepEqual([s.panes[0]?.agentId, s.paneMode.p1, s.flowFocus], [undefined, 'flow', { paneId: 'p1', agentId: 'a2' }], 'and back at the flow, the agent it came from pointed out');
  s = run(s, { type: 'back', paneId: 'p1' });
  assert.deepEqual([s.panes[0]?.sessionId, s.paneMode.p1, s.panes[0]?.history, s.flowFocus], ['lead', undefined, [], null], 'and the terminal it showed first');

  // Another pane's pointed-out agent stays while this one moves.
  const two = run(initialWorkspace, { type: 'open', sessionId: 'lead', mode: 'flow', focusAgent: 'a1' }, { type: 'openNew', sessionId: 'other' });
  assert.deepEqual(run(two, { type: 'drill', paneId: 'p2', sessionId: 'other', agentId: 'b1' }).flowFocus, { paneId: 'p1', agentId: 'a1' });
  assert.equal(run(s, { type: 'back', paneId: 'p1' }), s, 'nothing further back');

  const drilled = run(s, { type: 'drill', paneId: 'p1', sessionId: 'lead', mode: 'terminal' }, { type: 'drill', paneId: 'p1', sessionId: 'gone' });
  const synced = run(drilled, { type: 'sync', sessionIds: ['lead'], runningIds: ['lead'] });
  assert.deepEqual(synced.panes, [], 'a pane on a removed session goes');
  const kept = run(drilled, { type: 'sync', sessionIds: ['lead', 'gone'], runningIds: [] });
  assert.equal(kept, drilled, 'nothing changed, nothing new');
});

test('the history is not kept across a reload; a flow pane is', () => {
  const saved = new Map<string, string>();
  const storage = { getItem: (k: string) => saved.get(k) ?? null, setItem: (k: string, v: string) => void saved.set(k, v) };
  const s = run(initialWorkspace, { type: 'open', sessionId: 'lead' }, { type: 'drill', paneId: 'p1', sessionId: 'lead', mode: 'flow' });
  saveWorkspace(s, storage);
  const loaded = loadWorkspace(storage);
  assert.deepEqual([loaded.panes, loaded.paneMode], [[{ id: 'p1', sessionId: 'lead' }], { p1: 'flow' }]);
});
