import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  accepts,
  initialWorkspace,
  isModeShortcut,
  loadWorkspace,
  MAX_STACKS,
  paneModes,
  reducer,
  sameDrop,
  saveWorkspace,
  shownMode,
  stacksIn,
  switchedMode,
  type Action,
  type DropTarget,
  type Layout,
  type WorkspaceState,
} from '../src/workspace/state';

const ctx = { runningIds: ['a', 'b', 'c', 'd', 'e'] };
const run = (state: WorkspaceState, ...actions: Action[]) => actions.reduce((s, a) => reducer(s, a, ctx), state);
/** A session dragged from the tree and let go there. */
const dropped = (state: WorkspaceState, sessionId: string, target: DropTarget) => run(state, { type: 'dragStart', drag: { kind: 'session', id: sessionId } }, { type: 'drop', target });
/** A pane dragged by its tab and let go there. */
const moved = (state: WorkspaceState, paneId: string, target: DropTarget) => run(state, { type: 'dragStart', drag: { kind: 'pane', id: paneId } }, { type: 'drop', target });
/** The layout in a line: a stack as its panes (the one on top marked), a split as its direction around its parts. */
const lies = (s: WorkspaceState): string => {
  const stack = (id: string) => {
    const one = s.stacks.find((candidate) => candidate.id === id)!;
    return `[${one.panes.map((pane) => (pane === one.top ? `${pane}*` : pane)).join(' ')}]`;
  };
  const node = (part: Layout): string => (part.type === 'stack' ? stack(part.id) : `${part.dir}(${part.children.map(node).join(' ')})`);
  return s.layout ? node(s.layout) : '';
};
const sizes = (s: WorkspaceState) => (s.layout?.type === 'split' ? s.layout.sizes.map((size) => Math.round(size * 1000) / 1000) : []);
const sessions = (s: WorkspaceState) => s.panes.map((p) => p.sessionId);

test('opening the first session creates a pane and focuses it', () => {
  const s = run(initialWorkspace, { type: 'open', sessionId: 'a' });
  assert.deepEqual(s.panes, [{ id: 'p1', sessionId: 'a' }]);
  assert.equal(s.active, 'p1');
  assert.equal(lies(s), '[p1*]');
});

test('a session opened anew is a new tab of the stack in use; opening another replaces the active pane; a shown one is just focused', () => {
  let s = run(initialWorkspace, { type: 'open', sessionId: 'a' }, { type: 'openNew', sessionId: 'b' });
  assert.equal(s.active, 'p2');
  assert.equal(lies(s), '[p1 p2*]', 'no other pane changes its size for it');
  s = run(s, { type: 'open', sessionId: 'c' });
  assert.deepEqual(sessions(s), ['a', 'c']);
  s = run(s, { type: 'open', sessionId: 'a' });
  assert.equal(s.active, 'p1', 'focus the pane already showing it');
  assert.equal(lies(s), '[p1* p2]', 'which comes to the top of its stack');
  assert.equal(s.panes.length, 2);
  s = run(s, { type: 'openNew', sessionId: 'd' });
  assert.equal(lies(s), '[p1 p3* p2]', 'a new tab comes after the one that was on top');
  assert.equal(lies(run(s, { type: 'openNew', sessionId: 'a' })), '[p1* p3 p2]', 'one already open is not opened twice');
});

test('dropping a session on a pane opens it there', () => {
  const s = dropped(run(initialWorkspace, { type: 'open', sessionId: 'a' }, { type: 'openNew', sessionId: 'b' }), 'c', { type: 'pane', id: 'p1' });
  assert.deepEqual(sessions(s), ['c', 'b']);
  assert.equal(s.active, 'p1');
  assert.equal(s.drag, null);
  // Already a tab of that stack: it comes to the top, and nothing is shown twice.
  const again = dropped(s, 'b', { type: 'pane', id: 'p1' });
  assert.deepEqual([sessions(again), again.active, lies(again)], [['c', 'b'], 'p2', '[p1 p2*]']);
});

test('a side of a stack takes what is dropped there as a new stack; the two share its room', () => {
  let s = run(initialWorkspace, { type: 'open', sessionId: 'a' });
  s = dropped(s, 'b', { type: 'edge', id: 's1', side: 'right' });
  assert.deepEqual([lies(s), sizes(s), s.active], ['row([p1*] [p2*])', [0.5, 0.5], 'p2']);
  s = dropped(s, 'c', { type: 'edge', id: 's2', side: 'right' });
  assert.deepEqual([lies(s), sizes(s)], ['row([p1*] [p2*] [p3*])', [0.5, 0.25, 0.25]], 'in the row it is already in');
  s = dropped(s, 'd', { type: 'edge', id: 's1', side: 'bottom' });
  assert.equal(lies(s), 'row(column([p1*] [p4*]) [p2*] [p3*])', 'the other way: a column in its place');
  s = dropped(s, 'e', { type: 'edge', id: 's2', side: 'left' });
  assert.equal(lies(s), 'row(column([p1*] [p4*]) [p5*] [p2*] [p3*])');
  assert.deepEqual(stacksIn(s.layout), s.stacks.map((stack) => stack.id).sort((x, y) => stacksIn(s.layout).indexOf(x) - stacksIn(s.layout).indexOf(y)), 'every stack is in the layout once');
  // The stack a closed pane was alone in goes with it, and a split left with one part is that part.
  s = run(s, { type: 'closePane', paneId: 'p4' });
  assert.deepEqual([lies(s), sizes(s)], ['row([p1*] [p5*] [p2*] [p3*])', [0.5, 0.125, 0.125, 0.25]]);
});

test('the tabs of a stack take what is dropped there as a tab; a session already open moves instead of opening twice', () => {
  let s = dropped(run(initialWorkspace, { type: 'open', sessionId: 'a' }), 'b', { type: 'edge', id: 's1', side: 'right' });
  s = dropped(s, 'c', { type: 'tabs', id: 's1' });
  assert.deepEqual([lies(s), s.active], ['row([p1 p3*] [p2*])', 'p3']);
  s = dropped(s, 'b', { type: 'tabs', id: 's1' });
  assert.deepEqual([lies(s), sessions(s), s.active], ['[p1 p3 p2*]', ['a', 'b', 'c'], 'p2'], 'its pane comes over, and the stack it left closes');
  s = dropped(s, 'a', { type: 'edge', id: 's1', side: 'left' });
  assert.equal(lies(s), 'row([p1*] [p3 p2*])', 'out of the tabs, to a side; what was on top stays on top');
});

test('a pane dragged by its tab joins another stack, or makes one at a side', () => {
  let s = dropped(run(initialWorkspace, { type: 'open', sessionId: 'a' }, { type: 'openNew', sessionId: 'b' }), 'c', { type: 'edge', id: 's1', side: 'right' });
  assert.equal(lies(s), 'row([p1 p2*] [p3*])');
  s = moved(s, 'p1', { type: 'pane', id: 'p3' });
  assert.deepEqual([lies(s), s.active], ['row([p2*] [p3 p1*])', 'p1'], 'dropped in the middle of a stack: among its tabs');
  s = moved(s, 'p2', { type: 'tabs', id: 's2' });
  assert.equal(lies(s), '[p3 p1 p2*]', 'the last pane of a stack takes the stack with it');
  s = moved(s, 'p3', { type: 'edge', id: 's2', side: 'top' });
  assert.equal(lies(s), 'column([p3*] [p1 p2*])');

  // Where a pane has nowhere to go: its own stack, and a side of the stack it is alone in.
  const drag = (paneId: string): WorkspaceState => ({ ...s, drag: { kind: 'pane', id: paneId } });
  const top = s.stacks.find((stack) => stack.panes.includes('p3'))!.id;
  assert.equal(accepts(drag('p3'), { type: 'edge', id: top, side: 'left' }, ctx), false);
  assert.equal(accepts(drag('p3'), { type: 'tabs', id: top }, ctx), false);
  assert.equal(accepts(drag('p3'), { type: 'pane', id: 'p3' }, ctx), false);
  assert.equal(accepts(drag('p1'), { type: 'pane', id: 'p2' }, ctx), false, 'a tab of the same stack');
  assert.equal(accepts(drag('p1'), { type: 'edge', id: 's2', side: 'right' }, ctx), true, 'one of two tabs: out to a side of its own stack');
  assert.equal(accepts(drag('p3'), { type: 'edge', id: 's2', side: 'right' }, ctx), true);
  assert.equal(accepts(drag('p3'), { type: 'slot' }, ctx), false);
  assert.equal(accepts(drag('p3'), { type: 'composer' }, ctx), false);
});

test('there are six stacks at most; tabs have no such limit', () => {
  let s = run(initialWorkspace, { type: 'open', sessionId: 's1' });
  for (let n = 2; n <= MAX_STACKS + 2; n += 1) s = dropped(s, `s${n}`, { type: 'edge', id: s.stacks.at(-1)!.id, side: 'right' });
  assert.equal(s.stacks.length, MAX_STACKS);
  assert.equal(s.panes.length, MAX_STACKS, 'what found no room was not opened');
  const last = s.stacks.at(-1)!;
  assert.equal(dropped(s, 'more', { type: 'tabs', id: last.id }).panes.length, MAX_STACKS + 1);
  // A pane alone in its stack can still go to another side: the number of stacks stays.
  const alone = s.stacks[0]!.top;
  assert.equal(accepts({ ...s, drag: { kind: 'pane', id: alone } }, { type: 'edge', id: last.id, side: 'bottom' }, ctx), true);
  assert.equal(moved(s, alone, { type: 'edge', id: last.id, side: 'bottom' }).stacks.length, MAX_STACKS);
});

test('the tab that takes the typing is on top; a closed tab gives its place to the one next to it', () => {
  let s = run(initialWorkspace, { type: 'open', sessionId: 'a' }, { type: 'openNew', sessionId: 'b' }, { type: 'openNew', sessionId: 'c' });
  assert.equal(lies(s), '[p1 p2 p3*]');
  s = run(s, { type: 'focus', paneId: 'p1' });
  assert.deepEqual([lies(s), s.active], ['[p1* p2 p3]', 'p1']);
  s = run(s, { type: 'closePane', paneId: 'p1' });
  assert.deepEqual([lies(s), s.active], ['[p2* p3]', 'p2'], 'the one after it');
  s = run(s, { type: 'focus', paneId: 'p3' }, { type: 'closePane', paneId: 'p3' });
  assert.deepEqual([lies(s), s.active], ['[p2*]', 'p2'], 'else the one before it');
  // A tab that is not on top closes without changing what shows.
  s = run(s, { type: 'openNew', sessionId: 'd' }, { type: 'closePane', paneId: 'p2' });
  assert.deepEqual([lies(s), s.active], ['[p4*]', 'p4']);
  s = run(s, { type: 'closePane', paneId: 'p4' });
  assert.deepEqual([lies(s), s.active, s.stacks, s.layout], ['', null, [], null]);
});

test('the parts of a split take the shares they are given', () => {
  let s = dropped(run(initialWorkspace, { type: 'open', sessionId: 'a' }), 'b', { type: 'edge', id: 's1', side: 'right' });
  s = dropped(s, 'c', { type: 'edge', id: 's2', side: 'right' });
  const split = s.layout!.id;
  s = run(s, { type: 'resize', splitId: split, sizes: [2, 1, 1] });
  assert.deepEqual(sizes(s), [0.5, 0.25, 0.25]);
  for (const bad of [[1, 1], [1, 0, 1], [1, -1, 2]]) assert.equal(run(s, { type: 'resize', splitId: split, sizes: bad }), s, `${bad} is no way to share it`);
  assert.equal(run(s, { type: 'resize', splitId: 'nothing', sizes: [1, 1, 1] }).layout, s.layout);
});

test('the workspace takes a first pane while it is empty', () => {
  let s = initialWorkspace;
  for (const id of ['a', 'b']) s = dropped(s, id, { type: 'slot' });
  assert.deepEqual(sessions(s), ['a'], 'once there is a pane, the stacks take what is dropped');
});

test('the composer takes each running session once', () => {
  const s = run(
    initialWorkspace,
    { type: 'dragStart', drag: { kind: 'session', id: 'a' } },
    { type: 'drop', target: { type: 'composer' } },
    { type: 'dragStart', drag: { kind: 'session', id: 'a' } },
    { type: 'drop', target: { type: 'composer' } },
    { type: 'dragStart', drag: { kind: 'session', id: 'zz' } },
    { type: 'drop', target: { type: 'composer' } },
  );
  assert.deepEqual(s.targets, ['a']);
});

test('sync drops panes and targets of sessions that are gone or ended', () => {
  let s = run(
    initialWorkspace,
    { type: 'open', sessionId: 'a' },
    { type: 'openNew', sessionId: 'b' },
    { type: 'dragStart', drag: { kind: 'session', id: 'b' } },
    { type: 'drop', target: { type: 'composer' } },
  );
  s = dropped(s, 'c', { type: 'edge', id: 's1', side: 'right' });
  s = reducer(s, { type: 'sync', sessionIds: ['a', 'b', 'c'], runningIds: ['a'] });
  assert.deepEqual(s.targets, [], 'ended session no longer receives input');
  assert.equal(s.panes.length, 3, 'its pane stays so the last screen can be read');
  assert.equal(reducer(s, { type: 'sync', sessionIds: ['a', 'b', 'c'], runningIds: ['a'] }), s, 'nothing gone: nothing changes');
  s = reducer(s, { type: 'sync', sessionIds: ['a', 'b'], runningIds: ['a'] });
  assert.deepEqual([sessions(s), lies(s), s.active], [['a', 'b'], '[p1 p2*]', 'p2'], 'a stack whose panes all went goes with them');
  s = reducer(s, { type: 'sync', sessionIds: ['a'], runningIds: ['a'] });
  assert.deepEqual([sessions(s), lies(s), s.active], [['a'], '[p1*]', 'p1']);
});

test('the layout survives a reload; bad or missing storage falls back to empty', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, val: string) => void store.set(k, val) };
  let s = run(initialWorkspace, { type: 'open', sessionId: 'a' }, { type: 'openNew', sessionId: 'b' });
  s = dropped(s, 'c', { type: 'edge', id: 's1', side: 'bottom' });
  s = run(s, { type: 'resize', splitId: s.layout!.id, sizes: [3, 1] }, { type: 'focus', paneId: 'p1' });
  saveWorkspace(s, storage);
  const restored = loadWorkspace(storage);
  assert.deepEqual(restored.panes, s.panes);
  assert.deepEqual([lies(restored), sizes(restored), restored.active], ['column([p1* p2] [p3*])', [0.75, 0.25], 'p1']);
  assert.deepEqual([restored.nextPane, restored.nextNode], [4, s.nextNode]);
  assert.equal(lies(dropped(restored, 'd', { type: 'edge', id: 's1', side: 'right' })), 'column(row([p1* p2] [p4*]) [p3*])', 'and goes on from there');
  store.set('ah-layout', '{not json');
  assert.deepEqual(loadWorkspace(storage), initialWorkspace);
  assert.deepEqual(loadWorkspace(undefined), initialWorkspace);
});

test('a layout saved before panes could share a place comes back as the grid it was: two to a row', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null };
  const pane = (n: number) => ({ id: `p${n}`, sessionId: `s${n}` });
  const saved = (count: number) => store.set('ah-layout', JSON.stringify({ panes: [1, 2, 3, 4].slice(0, count).map(pane), active: 'p2', nextPane: 5, paneMode: { p2: 'conversation' } }));
  const grids = ['[p1*]', 'row([p1*] [p2*])', 'column(row([p1*] [p2*]) [p3*])', 'column(row([p1*] [p2*]) row([p3*] [p4*]))'];
  grids.forEach((grid, i) => {
    saved(i + 1);
    assert.equal(lies(loadWorkspace(storage)), grid);
  });
  const restored = loadWorkspace(storage);
  assert.deepEqual([restored.active, restored.paneMode, restored.nextPane], ['p2', { p2: 'conversation' }, 5]);
  assert.equal(lies(dropped(restored, 'new', { type: 'edge', id: 's4', side: 'right' })), 'column(row([p1*] [p2*]) row([p3*] [p4*] [p5*]))', 'new stacks and splits get names of their own');
});

test('a saved layout that does not fit its panes is put right', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null };
  const panes = [1, 2, 3].map((n) => ({ id: `p${n}`, sessionId: `s${n}` }));
  const load = (rest: object) => {
    store.set('ah-layout', JSON.stringify({ panes, active: 'p3', nextPane: 4, ...rest }));
    return loadWorkspace(storage);
  };
  // A pane no stack has, a stack naming a pane that is gone, a pane named twice, a stack the layout does not have.
  const odd = load({ stacks: [{ id: 's1', panes: ['p1', 'gone', 'p1'], top: 'gone' }, { id: 's2', panes: ['p2', 'p1'], top: 'p2' }, { id: 's3', panes: [], top: 'p9' }], layout: { type: 'stack', id: 's1' } });
  assert.deepEqual([lies(odd), odd.active], ['row([p1 p3*] [p2*])', 'p3']);
  // A layout that is not one, and one that names a stack twice and another that is not there.
  assert.equal(lies(load({ stacks: [{ id: 's1', panes: ['p1', 'p2', 'p3'], top: 'p2' }], layout: { type: 'split', id: 'x1', dir: 'sideways', children: [], sizes: [] } })), '[p1 p2 p3*]');
  const twice = { type: 'split', id: 'x1', dir: 'row', children: [{ type: 'stack', id: 's1' }, { type: 'stack', id: 's1' }, { type: 'stack', id: 's7' }, { type: 'stack', id: 's2' }], sizes: [1, 1, 1, 0] };
  const fixed = load({ stacks: [{ id: 's1', panes: ['p1'], top: 'p1' }, { id: 's2', panes: ['p2', 'p3'], top: 'p2' }], layout: twice });
  assert.deepEqual([lies(fixed), sizes(fixed)], ['row([p1*] [p2 p3*])', [0.5, 0.5]], 'a part without a share is put at the end');
  assert.ok(fixed.nextNode > 7, 'a name is not given twice');
});

test('a pane remembers whether it shows the terminal or the conversation, across a reload', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, val: string) => void store.set(k, val) };
  let s = run(initialWorkspace, { type: 'open', sessionId: 'a' }, { type: 'openNew', sessionId: 'b' }, { type: 'setMode', paneId: 'p2', mode: 'conversation' });
  assert.deepEqual(s.paneMode, { p2: 'conversation' });
  saveWorkspace(s, storage);
  assert.deepEqual(loadWorkspace(storage).paneMode, { p2: 'conversation' });
  s = run(s, { type: 'closePane', paneId: 'p2' });
  saveWorkspace(s, storage);
  assert.deepEqual(loadWorkspace(storage).paneMode, {}, 'a closed pane is forgotten');
});

test('Ctrl+` takes a pane from its terminal to its conversation and back; from the flow, the terminal first', () => {
  const live = { screen: true, transcripts: ['t1'] };
  const modes = paneModes({}, live);
  assert.deepEqual(modes, ['terminal', 'conversation', 'flow']);
  assert.deepEqual(
    (['terminal', 'conversation', 'flow'] as const).map((mode) => switchedMode(mode, modes)),
    ['conversation', 'terminal', 'terminal'],
  );
  assert.equal(switchedMode('terminal', paneModes({}, { screen: true, transcripts: [] })), null, 'no transcript yet: nowhere to go');
  assert.equal(switchedMode('flow', paneModes({}, { screen: false, transcripts: ['t1'] })), 'conversation', 'an ended session: its conversation');
  assert.deepEqual(paneModes({ agentId: 'a1' }, live), ['conversation'], 'a sub-agent has its conversation only');
  // A session started elsewhere has no terminal here: its conversation, where Claude will write it, and its flow.
  assert.deepEqual(paneModes({}, { screen: false, transcripts: ['expected'] }), ['conversation', 'flow']);
  assert.equal(shownMode(undefined, modes), 'terminal');
  assert.equal(shownMode('conversation', ['terminal', 'flow']), 'terminal', 'a mode the pane no longer has falls back to its first');

  const key = { code: 'Backquote', ctrlKey: true, altKey: false, metaKey: false, shiftKey: false };
  assert.equal(isModeShortcut(key), true);
  assert.equal(isModeShortcut({ ...key, shiftKey: true }), false);
  assert.equal(isModeShortcut({ ...key, ctrlKey: false }), false);
  assert.equal(isModeShortcut({ ...key, isComposing: true }), false, 'not while the IME composes');
});

test('hovering the same target twice keeps the same state object; another side of a stack is another target', () => {
  const s1 = run(initialWorkspace, { type: 'dragStart', drag: { kind: 'session', id: 'a' } }, { type: 'dragOver', over: { type: 'slot' } });
  const s2 = reducer(s1, { type: 'dragOver', over: { type: 'slot' } }, ctx);
  assert.equal(s1, s2);
  const left: DropTarget = { type: 'edge', id: 's1', side: 'left' };
  const over = reducer(s1, { type: 'dragOver', over: left }, ctx);
  assert.equal(reducer(over, { type: 'dragOver', over: { ...left } }, ctx), over);
  assert.notEqual(reducer(over, { type: 'dragOver', over: { ...left, side: 'top' } }, ctx), over);
  assert.deepEqual([sameDrop(left, { ...left }), sameDrop(left, { ...left, side: 'right' }), sameDrop(left, { type: 'tabs', id: 's1' }), sameDrop(left, { ...left, id: 's2' })], [true, false, false, false]);
});
