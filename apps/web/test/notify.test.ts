import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentInfo, SessionInfo, StatusValue } from '@agenthouse/protocol';
import { finished, loadNotifyDone, saveNotifyDone, statusesOf } from '../src/workspace/notify';

const agent = (state: AgentInfo['state'], asking = false) => ({ id: `agent-${state}-${asking}`, parentId: null, state, asking }) as unknown as AgentInfo;
const session = (id: string, value: StatusValue, extra: Partial<SessionInfo> = {}) =>
  ({ id, title: id, state: 'running', status: { value, reason: null, tool: null, error: false, at: 1 }, agents: [], ...extra }) as unknown as SessionInfo;
const ids = (list: SessionInfo[]) => list.map((s) => s.id);

test('a session is done when its turn ends: in a turn before, idle now', () => {
  const before = statusesOf([session('a', 'working'), session('b', 'working'), session('c', 'idle'), session('d', 'awaiting_permission'), session('e', 'starting'), session('f', 'awaiting_input')]);
  const now = [session('a', 'idle'), session('b', 'awaiting_permission'), session('c', 'idle'), session('d', 'idle'), session('e', 'idle'), session('f', 'working'), session('new', 'idle')];
  // d: its dialog was answered and the turn ended before the host reported again.
  assert.deepEqual(ids(finished(before, now)), ['a', 'd'], 'not one that asks or goes on, was idle already, has just started or is new to the list');
  assert.deepEqual(ids(finished(statusesOf(now), now)), [], 'and only once');
});

test('idle while its sub-agents work in the background is not done; the turn after the last report is', () => {
  const before = statusesOf([session('a', 'working')]);
  assert.deepEqual(ids(finished(before, [session('a', 'idle', { agents: [agent('running')] })])), [], 'an agent still runs');
  assert.deepEqual(ids(finished(before, [session('a', 'idle', { agents: [agent('stopped', true)] })])), [], 'an agent waits for the user');
  assert.deepEqual(ids(finished(before, [session('a', 'idle', { agents: [agent('stopped')] })])), ['a']);
});

test('a session that ended is not announced as done', () => {
  const before = statusesOf([session('a', 'working')]);
  assert.deepEqual(ids(finished(before, [session('a', 'exited', { state: 'exited' })])), []);
});

test('finished work is announced only once the user asked for it, and the choice is kept', () => {
  const kept = new Map<string, string>();
  const storage = { getItem: (key: string) => kept.get(key) ?? null, setItem: (key: string, value: string) => void kept.set(key, value), removeItem: (key: string) => void kept.delete(key) };
  assert.equal(loadNotifyDone(storage), false, 'off until turned on');
  saveNotifyDone(true, storage);
  assert.equal(loadNotifyDone(storage), true);
  saveNotifyDone(false, storage);
  assert.equal(loadNotifyDone(storage), false);
  assert.equal(kept.size, 0, 'off leaves nothing behind');
  const blocked = {
    getItem: () => {
      throw new Error('blocked');
    },
  };
  assert.equal(loadNotifyDone(blocked), false, 'storage that cannot be read: off');
});
