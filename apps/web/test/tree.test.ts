import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionInfo, SessionLink } from '@agenthouse/protocol';
import { accepts, initialWorkspace, reducer, type Action, type DropContext, type WorkspaceState } from '../src/workspace/state';
import { parentsOf, sessionTree } from '../src/workspace/tree';

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
});
