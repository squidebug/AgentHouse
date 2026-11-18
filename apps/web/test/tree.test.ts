import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionInfo, SessionLink } from '@agenthouse/protocol';
import { makeDnd, type Dnd } from '../src/workspace/dnd';
import { accepts, dropEffect, initialWorkspace, reducer, type Action, type DropContext, type WorkspaceState } from '../src/workspace/state';
import { delegatesOf, parentsOf, sessionTree } from '../src/workspace/tree';

const session = (id: string, cwd = '/work/shop'): SessionInfo => ({ id, cwd }) as SessionInfo;
const group = (childId: string, parentId: string): SessionLink => ({ childId, parentId, kind: 'group' });
const shape = (sessions: SessionInfo[], links: SessionLink[]) =>
  sessionTree(sessions, links).map((g) => `${g.label}: ${g.nodes.map((n) => (n.children.length ? `${n.session.id}(${n.children.map((c) => c.session.id).join(',')})` : n.session.id)).join(' ')}`);

test('placed sessions show under their parent, whatever their folder; the rest by folder', () => {
  const sessions = [session('a'), session('b', '/work/docs'), session('c'), session('d', '/work/docs')];
  assert.deepEqual(shape(sessions, [group('b', 'a'), group('d', 'a')]), ['shop: a(b,d) c']);
  assert.deepEqual(shape(sessions, []), ['shop: a c', 'docs: b d']);
});

test('links that cannot hold are ignored: missing sessions, a parent placed under another, itself', () => {
  const sessions = [session('a'), session('b'), session('c')];
  assert.deepEqual(shape(sessions, [group('b', 'gone'), group('c', 'c')]), ['shop: a b c']);
  assert.deepEqual(shape(sessions, [group('b', 'a'), group('c', 'b')]), ['shop: a(b) c'], 'one level');
  assert.deepEqual(parentsOf(sessions, [group('b', 'a'), group('c', 'b')]), { b: 'a' });
});

const ctx: DropContext = { runningIds: ['a', 'b', 'c'], parents: { b: 'a' } };
const run = (state: WorkspaceState, ...actions: Action[]) => actions.reduce((s, a) => reducer(s, a, ctx), state);
const drag = (id: string): Action => ({ type: 'dragStart', drag: { kind: 'session', id } });

test('a session dropped on another at the top waits for the choice; it can go back to the top', () => {
  const asked = run(initialWorkspace, drag('c'), { type: 'drop', target: { type: 'nest', id: 'a' } });
  assert.deepEqual(asked.pending, { childId: 'c', parentId: 'a' });
  assert.equal(asked.drag, null);
  assert.equal(run(asked, { type: 'settleLink' }).pending, null);
  assert.equal(run(asked, drag('b')).pending, null, 'a new drag forgets it');

  const refused = (id: string, target: string) => run(initialWorkspace, drag(id), { type: 'drop', target: { type: 'nest', id: target } }).pending;
  assert.equal(refused('c', 'b'), null, 'not under a session that is under another');
  assert.equal(refused('a', 'c'), null, 'not a session with sessions under it');
  assert.equal(refused('b', 'a'), null, 'already there');
  assert.equal(refused('c', 'c'), null);

  const toTop = (id: string) => accepts(run(initialWorkspace, drag(id)), { type: 'root' }, ctx);
  assert.equal(toTop('b'), true);
  assert.equal(toTop('c'), false, 'only a placed session goes back to the top');
  assert.equal(accepts(run(initialWorkspace, drag('c')), { type: 'composer' }, ctx), true, 'the other drops still work');

  // What a drop asks of the server. Going back to the top is asked at once; under another session, once the user chose how.
  const asks = (id: string, target: Parameters<typeof dropEffect>[1]) => dropEffect(run(initialWorkspace, drag(id)), target, ctx);
  assert.deepEqual(asks('b', { type: 'root' }), { type: 'unlink', childId: 'b' });
  assert.equal(asks('c', { type: 'root' }), null, 'not taken: nothing is asked');
  assert.equal(asks('c', { type: 'nest', id: 'a' }), null);
  for (const target of [{ type: 'slot' }, { type: 'composer' }] as const) assert.equal(asks('c', target), null, `${target.type}: the layout alone`);
  assert.equal(dropEffect(initialWorkspace, { type: 'root' }, ctx), null, 'nothing is dragged');
});

test('a piece of a conversation goes only to a session delegated under the one it comes from', () => {
  const sessions = [session('lead'), session('helper'), session('other'), session('grouped')];
  const links = [
    { childId: 'helper', parentId: 'lead', kind: 'delegate' as const },
    { childId: 'grouped', parentId: 'lead', kind: 'group' as const },
  ];
  const delegating: DropContext = { runningIds: ['lead', 'helper', 'other', 'grouped'], parents: parentsOf(sessions, links), delegates: delegatesOf(sessions, links) };
  assert.deepEqual(delegating.delegates, { helper: 'lead' });
  const panes = reducer(reducer(initialWorkspace, { type: 'open', sessionId: 'helper' }, delegating), { type: 'openNew', sessionId: 'other' }, delegating);
  const dragging = reducer(panes, { type: 'dragStart', drag: { kind: 'item', id: 'e1', sessionId: 'lead', text: 'do this' } }, delegating);
  const can = (target: Parameters<typeof accepts>[1]) => accepts(dragging, target, delegating);
  assert.equal(can({ type: 'delegate', id: 'helper' }), true);
  assert.equal(can({ type: 'delegate', id: 'grouped' }), false, 'grouped is not delegated');
  assert.equal(can({ type: 'pane', id: 'p1' }), true, "the delegate's pane");
  assert.equal(can({ type: 'pane', id: 'p2' }), false);
  for (const target of [{ type: 'slot' }, { type: 'composer' }, { type: 'root' }, { type: 'nest', id: 'other' }] as const) assert.equal(can(target), false, target.type);
  const dropped = reducer(dragging, { type: 'drop', target: { type: 'pane', id: 'p1' } }, delegating);
  assert.deepEqual(dropped.panes, panes.panes, 'the layout stays: the work is asked of the server');
  // On the delegate's chip or on its pane, the same is asked: work for it, from the session the piece comes from.
  const work = { type: 'delegate', parentId: 'lead', childId: 'helper', text: 'do this' };
  assert.deepEqual(dropEffect(dragging, { type: 'delegate', id: 'helper' }, delegating), work);
  assert.deepEqual(dropEffect(dragging, { type: 'pane', id: 'p1' }, delegating), work);
  assert.equal(dropEffect(dragging, { type: 'pane', id: 'p2' }, delegating), null, 'not taken: nothing is asked');
  assert.equal(dropEffect(dropped, { type: 'pane', id: 'p1' }, delegating), null, 'the drop ended the drag');
  const fromHelper = reducer(panes, { type: 'dragStart', drag: { kind: 'item', id: 'e2', sessionId: 'helper', text: 'x' } }, delegating);
  assert.equal(accepts(fromHelper, { type: 'delegate', id: 'helper' }, delegating), false, 'not back to itself');
  // A session or a pane dropped on a pane changes the layout and asks nothing.
  const session2 = reducer(panes, { type: 'dragStart', drag: { kind: 'session', id: 'lead' } }, delegating);
  assert.equal(dropEffect(session2, { type: 'pane', id: 'p1' }, delegating), null);
  const swapping = reducer(panes, { type: 'dragStart', drag: { kind: 'pane', id: 'p2' } }, delegating);
  assert.equal(dropEffect(swapping, { type: 'pane', id: 'p1' }, delegating), null);
});

test('a drop does both of its parts at the place it is handled: the layout, then what it asks of the server', () => {
  const sessions = [session('lead'), session('helper')];
  const links = [{ childId: 'helper', parentId: 'lead', kind: 'delegate' as const }];
  const delegating: DropContext = { runningIds: ['lead', 'helper'], parents: parentsOf(sessions, links), delegates: delegatesOf(sessions, links) };
  const done: unknown[][] = [];
  const event = { preventDefault: () => {}, stopPropagation: () => {} } as unknown as Parameters<ReturnType<Dnd['drop']>>[0];
  const drop = (state: WorkspaceState, target: Parameters<Dnd['drop']>[0]) => {
    done.length = 0;
    const dnd = makeDnd(state, (action) => done.push(['layout', action.type]), delegating, {
      onUnlink: (childId) => done.push(['unlink', childId]),
      onDelegate: (parentId, childId, text) => done.push(['delegate', parentId, childId, text]),
    });
    dnd.drop(target)(event);
    return done;
  };
  const dragging = (drag: Extract<Action, { type: 'dragStart' }>['drag']) => reducer(initialWorkspace, { type: 'dragStart', drag }, delegating);
  assert.deepEqual(drop(dragging({ kind: 'session', id: 'helper' }), { type: 'root' }), [['layout', 'drop'], ['unlink', 'helper']]);
  assert.deepEqual(drop(dragging({ kind: 'item', id: 'e1', sessionId: 'lead', text: 'do this' }), { type: 'delegate', id: 'helper' }), [['layout', 'drop'], ['delegate', 'lead', 'helper', 'do this']]);
  assert.deepEqual(drop(dragging({ kind: 'session', id: 'lead' }), { type: 'slot' }), [['layout', 'drop']], 'the layout alone');
  assert.deepEqual(drop(dragging({ kind: 'session', id: 'lead' }), { type: 'root' }), [['layout', 'drop']], 'not taken: the drag still ends, and nothing is asked');
});

test('a session started outside AgentHouse is in its folder with the others; it opens in a pane and goes nowhere else', () => {
  const outside = { ...session('x'), external: true } as SessionInfo;
  assert.deepEqual(shape([session('a'), outside, session('c')], []), ['shop: a x c']);

  // It takes no messages, so it is not among the running ones.
  const watching: DropContext = { runningIds: ['a', 'c'], parents: {}, externalIds: ['x'] };
  const dragging = (id: string) => reducer(initialWorkspace, drag(id), watching);
  const can = (id: string, target: Parameters<typeof accepts>[1]) => accepts(dragging(id), target, watching);
  assert.equal(can('x', { type: 'slot' }), true, 'into a new pane');
  assert.equal(can('x', { type: 'composer' }), false, 'not a recipient');
  assert.equal(can('x', { type: 'nest', id: 'a' }), false, 'not under a session');
  assert.equal(can('c', { type: 'nest', id: 'x' }), false, 'and none under it');
  assert.equal(can('c', { type: 'nest', id: 'a' }), true, 'the others as before');
  assert.equal(reducer(dragging('x'), { type: 'drop', target: { type: 'nest', id: 'a' } }, watching).pending, null);
});
