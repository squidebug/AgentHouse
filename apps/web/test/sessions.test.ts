import assert from 'node:assert/strict';
import { test } from 'node:test';
import { takesInput, type SessionInfo } from '@agenthouse/protocol';
import { canResume, keepUnchanged } from '../src/workspace/sessions';

const session = (id: string, extra: object = {}) =>
  ({ id, title: id, state: 'running', status: { value: 'idle', reason: null, tool: null, error: false, at: 1 }, telemetry: { costUsd: 0.1 }, agents: [], ...extra }) as unknown as SessionInfo;
// As it arrives: parsed anew, so equal sessions are other objects.
const arrived = (list: SessionInfo[]) => JSON.parse(JSON.stringify(list)) as SessionInfo[];

test('a list that says the same keeps the list and every session as they were', () => {
  const before = [session('a'), session('b')];
  assert.equal(keepUnchanged(before, arrived(before)), before);
});

test('only the session that changed is a new object', () => {
  const before = [session('a'), session('b'), session('c')];
  const next = keepUnchanged(before, arrived([before[0]!, session('b', { telemetry: { costUsd: 0.2 } }), before[2]!]));
  assert.notEqual(next, before);
  assert.equal(next[0], before[0]);
  assert.notEqual(next[1], before[1]);
  assert.equal(next[1]?.telemetry.costUsd, 0.2);
  assert.equal(next[2], before[2]);
});

test('an ended Claude session with a conversation can be started again; a running one, Codex or one without cannot', () => {
  const talk = [{ vendorSessionId: 'first', path: 'a.jsonl', since: 1 }, { vendorSessionId: 'after-clear', path: 'b.jsonl', since: 2 }];
  assert.equal(canResume({ state: 'exited', vendor: 'claude', transcripts: talk }), true);
  assert.equal(canResume({ state: 'running', vendor: 'claude', transcripts: talk }), false);
  assert.equal(canResume({ state: 'exited', vendor: 'codex', transcripts: talk }), false);
  assert.equal(canResume({ state: 'exited', vendor: 'claude', transcripts: [] }), false);
  // The conversation it ended in is the one that counts.
  assert.equal(canResume({ state: 'exited', vendor: 'claude', transcripts: [...talk, { vendorSessionId: null, path: 'c.jsonl', since: 3 }] }), false);
});

test('sessions added, removed or in another order make a new list of the same objects', () => {
  const before = [session('a'), session('b')];
  const added = keepUnchanged(before, arrived([...before, session('c')]));
  assert.deepEqual([added.length, added[0] === before[0], added[1] === before[1]], [3, true, true]);
  const removed = keepUnchanged(before, arrived([before[1]!]));
  assert.deepEqual([removed.length, removed[0] === before[1]], [1, true]);
  const swapped = keepUnchanged(before, arrived([before[1]!, before[0]!]));
  assert.notEqual(swapped, before);
  assert.deepEqual([swapped[0] === before[1], swapped[1] === before[0]], [true, true]);
});

test("a session takes messages while it runs and is AgentHouse's own; one only watched is read", () => {
  assert.equal(takesInput({ state: 'running' }), true);
  assert.equal(takesInput({ state: 'exited' }), false);
  assert.equal(takesInput({ state: 'running', external: true }), false);
  // It runs, so there is nothing to start again either.
  assert.equal(canResume({ state: 'running', vendor: 'claude', transcripts: [{ vendorSessionId: 'c1', path: 'a.jsonl', since: 1 }] }), false);
});
