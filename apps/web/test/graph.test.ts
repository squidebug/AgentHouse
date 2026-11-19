import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentInfo, BackgroundTask, DelegationInfo, ScheduledPrompt, SessionInfo, SessionLink, StatusValue } from '@agenthouse/protocol';
import { forest, isBusy, layout, related, rowsOf, taskBars, toneOf, type GraphNode, type GraphOptions, type Sizes } from '../src/workspace/graph';

const agent = (id: string, extra: Partial<AgentInfo> = {}) => ({ id, parentId: null, agentType: 'Explore', description: id, state: 'running', asking: false, startedAt: 0, endedAt: null, ...extra }) as unknown as AgentInfo;
const done = (id: string, extra: Partial<AgentInfo> = {}) => agent(id, { state: 'stopped', endedAt: 5, ...extra });
const task = (id: string, state: BackgroundTask['state'] = 'running') => ({ id, state, startedAt: 10, endedAt: state === 'running' ? null : 40 }) as unknown as BackgroundTask;
const job = (id: string) => ({ id, schedule: '*/5 * * * *', recurring: true, prompt: id }) as unknown as ScheduledPrompt;
const session = (id: string, value: StatusValue = 'idle', extra: Partial<SessionInfo> = {}) =>
  ({ id, title: id, cwd: '/work/shop', state: value === 'exited' ? 'exited' : 'running', startedAt: 0, status: { value, reason: null, tool: null, error: false, at: 1 }, agents: [], tasks: [], schedules: [], ...extra }) as unknown as SessionInfo;
const link = (childId: string, parentId: string, kind: SessionLink['kind'] = 'group'): SessionLink => ({ childId, parentId, kind });
const work = (parentId: string, childId: string, sentAt: number, status: DelegationInfo['status']) => ({ id: `${parentId}>${childId}@${sentAt}`, parentId, childId, sentAt, status, delivery: 'none' }) as unknown as DelegationInfo;

const ALL: GraphOptions = { filter: 'all', allAgents: new Set(), ended: false };
/** A tree as its keys: `a(b c(d))`. */
const shape = (node: GraphNode): string => `${node.key}${node.children.length ? `(${node.children.map(shape).join(' ')})` : ''}`;
const shapes = (sessions: SessionInfo[], links: SessionLink[] = [], delegations: DelegationInfo[] = [], options: Partial<GraphOptions> = {}) =>
  forest(sessions, links, delegations, { ...ALL, ...options }).folders.map((folder) => `${folder.label}: ${folder.roots.map(shape).join(' ')}`);

test('a session with what is under it, in the order the tree lists it: sub-agents nested, what it runs by itself, the sessions placed under it', () => {
  const lead = session('lead', 'working', {
    agents: [agent('look'), agent('deeper', { parentId: 'look' }), agent('plan'), agent('lost', { parentId: 'nobody' })],
    tasks: [task('watch'), task('built', 'done')],
    schedules: [job('poll')],
  });
  const sessions = [lead, session('helper'), session('notes'), session('alone'), session('far', 'idle', { cwd: '/work/infra' })];
  assert.deepEqual(shapes(sessions, [link('helper', 'lead', 'delegate'), link('notes', 'lead')]), [
    'shop: lead(lead/look(lead/deeper) lead/plan lead/lost lead/task/watch lead/schedule/poll helper notes) alone',
    'infra: far',
  ]);
});

test('finished sub-agents fold as in the tree, into a node that says how many; opened, the node folds them again', () => {
  const agents = [agent('busy'), done('a'), done('b'), done('c'), done('d'), agent('under-done', { parentId: 'a' })];
  const one = session('one', 'working', { agents });
  assert.deepEqual(shapes([one]), ['shop: one(one/busy one/a(one/under-done) one#agents)'], 'the busy ones and what is above them stay');
  const folded = forest([one], [], [], ALL).folders[0]!.roots[0]!.children.at(-1)!;
  assert.deepEqual([folded.kind, folded.kind === 'fold' && folded.folded], ['fold', 3]);
  const opened = forest([one], [], [], { ...ALL, allAgents: new Set(['one']) }).folders[0]!.roots[0]!;
  assert.equal(shape(opened), 'one(one/busy one/a(one/under-done) one/b one/c one/d one#agents)');
  const fold = opened.children.at(-1)!;
  assert.equal(fold.kind === 'fold' && fold.folded, 0, 'nothing folded: it folds them again');
  assert.deepEqual(shapes([session('few', 'idle', { agents: [done('a'), done('b'), done('c')] })]), ['shop: few(few/a few/b few/c)'], 'three finished ones are simply listed');
});

test('ended sessions at the top with nothing under them fold away, and are counted', () => {
  const sessions = [session('runs'), session('over', 'exited'), session('kept', 'exited'), session('under'), session('gone', 'exited', { cwd: '/work/old' })];
  const links = [link('under', 'kept')];
  assert.deepEqual(forest(sessions, links, [], ALL).foldedEnded, 2);
  assert.deepEqual(shapes(sessions, links), ['shop: runs kept(under)'], 'one with a session under it stays; a folder left empty is not listed');
  assert.deepEqual(shapes(sessions, links, [], { ended: true }), ['shop: runs over kept(under)', 'old: gone']);
});

test('only what runs: what is busy now, with everything above it', () => {
  const lead = session('lead', 'idle', { agents: [done('was'), agent('is'), agent('asks', { state: 'stopped', asking: true })], tasks: [task('watch')], schedules: [job('poll')] });
  const sessions = [lead, session('helper', 'working'), session('idle'), session('asking', 'awaiting_permission'), session('loop', 'idle', { schedules: [job('tick')] }), session('quiet', 'idle', { agents: [done('x')] })];
  assert.deepEqual(shapes(sessions, [link('helper', 'lead', 'delegate')], [], { filter: 'running' }), ['shop: lead(lead/is lead/asks lead/task/watch lead/schedule/poll helper) asking loop(loop/schedule/tick)']);
  const nodes = rowsOf(forest(sessions, [link('helper', 'lead', 'delegate')], [], ALL).folders[0]!.roots).map(({ node }) => node);
  assert.deepEqual(nodes.filter(isBusy).map((node) => node.key), ['lead/is', 'lead/asks', 'lead/task/watch', 'lead/schedule/poll', 'helper', 'asking', 'loop/schedule/tick']);
});

test('the work a session was handed is on its line: the latest its parent sent it', () => {
  const sessions = [session('lead'), session('helper'), session('grouped')];
  const links = [link('helper', 'lead', 'delegate'), link('grouped', 'lead')];
  const delegations = [work('lead', 'helper', 10, 'done'), work('lead', 'helper', 30, 'running'), work('lead', 'helper', 20, 'failed'), work('other', 'helper', 99, 'done'), work('lead', 'grouped', 99, 'done')];
  const [helper, grouped] = forest(sessions, links, delegations, ALL).folders[0]!.roots[0]!.children;
  assert.deepEqual([helper?.kind === 'session' && helper.work?.sentAt, grouped?.kind === 'session' && grouped.work], [30, null], 'a session only grouped is handed nothing');
  assert.equal(toneOf(helper!), 'busy', 'idle itself, but on work it was handed');
});

test('what a line says of what it leads to', () => {
  const node = (one: SessionInfo) => forest([one], [], [], { ...ALL, ended: true }).folders[0]!.roots[0]!;
  assert.equal(toneOf(node(session('a', 'working'))), 'busy');
  assert.equal(toneOf(node(session('a', 'awaiting_input'))), 'asks');
  assert.equal(toneOf(node(session('a', 'idle'))), null);
  assert.equal(toneOf(node(session('a', 'idle', { agents: [agent('x')] }))), 'busy', 'through its sub-agents');
  assert.equal(toneOf(node(session('a', 'exited', { agents: [agent('x')] }))), null, 'nothing works in a session that ended');
  const under = node(session('a', 'idle', { agents: [agent('runs'), agent('asks', { asking: true }), done('over')], tasks: [task('watch')], schedules: [job('poll')] })).children;
  assert.deepEqual(under.map(toneOf), ['busy', 'asks', null, 'busy', null]);
});

test('where everything goes: to the right of what it is under, which stands at the middle of what is under it', () => {
  const sizes: Sizes = { width: 100, height: 40, gap: 10, across: 50, folder: 20, after: 30, between: 6 };
  const lead = session('lead', 'working', { agents: [agent('a'), agent('b', { parentId: 'a' }), agent('c', { parentId: 'a' }), agent('d')] });
  const { folders } = forest([lead, session('alone'), session('far', 'idle', { cwd: '/work/infra' })], [], [], ALL);
  const made = layout(folders, sizes);
  const at = Object.fromEntries(made.placed.map((one) => [one.node.key, [one.x, one.y, one.depth, one.parent?.node.key ?? null]]));
  assert.deepEqual(at, {
    // b and c are one above the other; a is at their middle; d comes after them; lead is at the middle of a and d.
    'lead/b': [300, 20, 2, 'lead/a'],
    'lead/c': [300, 70, 2, 'lead/a'],
    'lead/a': [150, 45, 1, 'lead'],
    'lead/d': [150, 120, 1, 'lead'],
    lead: [0, 82.5, 0, null],
    alone: [0, 176, 0, null],
    far: [0, 276, 0, null],
  });
  assert.deepEqual(made.folders, [{ cwd: '/work/shop', label: 'shop', y: 0 }, { cwd: '/work/infra', label: 'infra', y: 256 }]);
  assert.deepEqual([made.width, made.height], [400, 316], 'three columns, and down to the last node');
  assert.deepEqual(layout([], sizes), { placed: [], folders: [], width: 0, height: 0 });
});

test('a node pointed at is shown with what it is under and all that is under it', () => {
  const lead = session('lead', 'working', { agents: [agent('a'), agent('b', { parentId: 'a' }), agent('c')] });
  const { placed } = layout(forest([lead, session('helper'), session('other')], [link('helper', 'lead')], [], ALL).folders, { width: 1, height: 1, gap: 0, across: 0, folder: 0, after: 0, between: 0 });
  assert.deepEqual([...related(placed, 'lead/a')].sort(), ['lead', 'lead/a', 'lead/b']);
  assert.deepEqual([...related(placed, 'lead')].sort(), ['helper', 'lead', 'lead/a', 'lead/b', 'lead/c']);
  assert.deepEqual([...related(placed, 'other')], ['other']);
  assert.deepEqual([...related(placed, 'nobody')], []);
});

test('the rows of the lanes are the nodes in the order of the tree, with how deep each is; a command runs from its start', () => {
  const lead = session('lead', 'working', { agents: [agent('a'), agent('b', { parentId: 'a' })], tasks: [task('watch')] });
  const rows = rowsOf(forest([lead, session('helper')], [link('helper', 'lead')], [], ALL).folders[0]!.roots);
  assert.deepEqual(rows.map(({ node, depth }) => `${depth} ${node.key}`), ['0 lead', '1 lead/a', '2 lead/b', '1 lead/task/watch', '1 helper']);
  assert.deepEqual(taskBars(task('watch'), 100), [{ from: 10, to: 100, kind: 'working' }]);
  assert.deepEqual(taskBars(task('built', 'done'), 100), [{ from: 10, to: 40, kind: 'done' }]);
});
