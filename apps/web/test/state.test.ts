import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  initialWorkspace,
  isModeShortcut,
  loadWorkspace,
  MAX_PANES,
  paneModes,
  reducer,
  saveWorkspace,
  shownMode,
  switchedMode,
  type Action,
  type WorkspaceState,
} from '../src/workspace/state';

const ctx = { runningIds: ['a', 'b', 'c', 'd', 'e'] };
const run = (state: WorkspaceState, ...actions: Action[]) => actions.reduce((s, a) => reducer(s, a, ctx), state);

test('opening the first session creates a pane and focuses it', () => {
  const s = run(initialWorkspace, { type: 'open', sessionId: 'a' });
  assert.deepEqual(s.panes, [{ id: 'p1', sessionId: 'a' }]);
  assert.equal(s.active, 'p1');
});

test('opening another session replaces the active pane; a shown one is just focused', () => {
  let s = run(initialWorkspace, { type: 'open', sessionId: 'a' }, { type: 'openNew', sessionId: 'b' });
  assert.equal(s.active, 'p2');
  s = run(s, { type: 'open', sessionId: 'c' });
  assert.deepEqual(s.panes.map((p) => p.sessionId), ['a', 'c']);
  s = run(s, { type: 'open', sessionId: 'a' });
  assert.equal(s.active, 'p1', 'focus the pane already showing it');
  assert.equal(s.panes.length, 2);
});

test('dropping a session on a pane opens it there', () => {
  const s = run(
    initialWorkspace,
    { type: 'open', sessionId: 'a' },
    { type: 'openNew', sessionId: 'b' },
    { type: 'dragStart', drag: { kind: 'session', id: 'c' } },
    { type: 'drop', target: { type: 'pane', id: 'p1' } },
  );
  assert.deepEqual(s.panes.map((p) => p.sessionId), ['c', 'b']);
  assert.equal(s.active, 'p1');
  assert.equal(s.drag, null);
});

test('dropping a pane header on another pane swaps them', () => {
  const s = run(
    initialWorkspace,
    { type: 'open', sessionId: 'a' },
    { type: 'openNew', sessionId: 'b' },
    { type: 'dragStart', drag: { kind: 'pane', id: 'p1' } },
    { type: 'drop', target: { type: 'pane', id: 'p2' } },
  );
  assert.deepEqual(s.panes.map((p) => p.id), ['p2', 'p1']);
});

test('the empty slot adds panes up to the maximum', () => {
  let s = initialWorkspace;
  for (const id of ['a', 'b', 'c', 'd', 'e']) {
    s = run(s, { type: 'dragStart', drag: { kind: 'session', id } }, { type: 'drop', target: { type: 'slot' } });
  }
  assert.equal(s.panes.length, MAX_PANES);
  assert.deepEqual(s.panes.map((p) => p.sessionId), ['a', 'b', 'c', 'd']);
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

test('a pane cannot be dropped on the composer or the slot', () => {
  const s = run(
    initialWorkspace,
    { type: 'open', sessionId: 'a' },
    { type: 'dragStart', drag: { kind: 'pane', id: 'p1' } },
    { type: 'drop', target: { type: 'slot' } },
  );
  assert.equal(s.panes.length, 1);
});

test('sync drops panes and targets of sessions that are gone or ended', () => {
  let s = run(
    initialWorkspace,
    { type: 'open', sessionId: 'a' },
    { type: 'openNew', sessionId: 'b' },
    { type: 'dragStart', drag: { kind: 'session', id: 'b' } },
    { type: 'drop', target: { type: 'composer' } },
  );
  s = reducer(s, { type: 'sync', sessionIds: ['a', 'b'], runningIds: ['a'] });
  assert.deepEqual(s.targets, [], 'ended session no longer receives input');
  assert.equal(s.panes.length, 2, 'its pane stays so the last screen can be read');
  s = reducer(s, { type: 'sync', sessionIds: ['a'], runningIds: ['a'] });
  assert.deepEqual(s.panes.map((p) => p.sessionId), ['a']);
  assert.equal(s.active, 'p1');
});

test('the pane layout survives a reload; bad or missing storage falls back to empty', () => {
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, val: string) => void store.set(k, val) };
  const s = run(initialWorkspace, { type: 'open', sessionId: 'a' }, { type: 'openNew', sessionId: 'b' });
  saveWorkspace(s, storage);
  const restored = loadWorkspace(storage);
  assert.deepEqual(restored.panes, s.panes);
  assert.equal(restored.active, 'p2');
  assert.equal(restored.nextPane, 3);
  store.set('ah-layout', '{not json');
  assert.deepEqual(loadWorkspace(storage), initialWorkspace);
  assert.deepEqual(loadWorkspace(undefined), initialWorkspace);
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

test('hovering the same target twice keeps the same state object', () => {
  const s1 = run(initialWorkspace, { type: 'dragStart', drag: { kind: 'session', id: 'a' } }, { type: 'dragOver', over: { type: 'slot' } });
  const s2 = reducer(s1, { type: 'dragOver', over: { type: 'slot' } }, ctx);
  assert.equal(s1, s2);
});
