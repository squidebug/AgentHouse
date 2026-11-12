import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConversationEntry, ConversationTurn } from '@agenthouse/protocol';
import { arrange, compactCount, duration, modelName, summarize, type WorkEntry } from '../src/workspace/conversation';

const turn = (index: number): ConversationTurn => ({
  index,
  segment: 0,
  startedAt: null,
  endedAt: null,
  model: null,
  effort: null,
  usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 },
  durationMs: null,
  interrupted: false,
});
const base = (id: string, t: number) => ({ id, turn: t, at: null });
const promptEntry = (id: string, t: number): ConversationEntry => ({ ...base(id, t), kind: 'prompt', text: id, images: 0, from: null, truncated: false });
const textEntry = (id: string, t: number): ConversationEntry => ({ ...base(id, t), kind: 'text', text: id, truncated: false });
const tool = (id: string, t: number, state: 'running' | 'done' | 'error' = 'done'): WorkEntry => ({ ...base(id, t), kind: 'tool', name: 'Bash', summary: id, state });
const thought = (id: string, t: number): WorkEntry => ({ ...base(id, t), kind: 'thinking', chars: 10 });

test('runs of tool calls and thinking fold into one row; text, prompts, sub-agents and their reports stand alone', () => {
  const entries: ConversationEntry[] = [
    promptEntry('p1', 0),
    thought('k1', 0),
    tool('t1', 0),
    tool('t2', 0),
    textEntry('x1', 0),
    tool('t3', 0),
    { ...base('a1', 0), kind: 'agent', agentType: 'Explore', description: 'look', state: 'running', agentId: null },
    tool('t4', 0),
    { ...base('r1', 0), kind: 'task', agentId: 'a1', description: 'look', state: 'done', tokens: 10, durationMs: 5 },
    tool('t6', 0),
    promptEntry('p2', 1),
    tool('t5', 9),
  ];
  const views = arrange([turn(1), turn(0)], entries);
  assert.deepEqual(
    views.map((v) => v.turn.index),
    [0, 1],
  );
  assert.deepEqual(
    views[0]?.blocks.map((b) => (b.kind === 'work' ? b.entries.map((e) => e.id).join('+') : b.entry.id)),
    ['p1', 'k1+t1+t2', 'x1', 't3', 'a1', 't4', 'r1', 't6'],
  );
  assert.deepEqual(
    views[1]?.blocks.map((b) => (b.kind === 'entry' ? b.entry.id : 'work')),
    ['p2'],
    'an entry of an unknown turn is left out',
  );
});

test('a work row counts its tools, thoughts, running and failed calls', () => {
  assert.deepEqual(summarize([thought('k', 0), tool('a', 0), tool('b', 0, 'running'), tool('c', 0, 'error')]), { tools: 3, thinking: 1, running: 1, failed: 1 });
});

test('numbers, durations and model names read short', () => {
  assert.deepEqual([0, 950, 1000, 1250, 12_400, 999_999, 1_250_000, 23_000_000].map(compactCount), ['0', '950', '1K', '1.3K', '12K', '1M', '1.3M', '23M']);
  assert.deepEqual([400, 45_000, 83_000, 120_000, 3_900_000].map(duration), ['1초 미만', '45초', '1분 23초', '2분', '1시간 5분']);
  assert.equal(modelName('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(modelName('claude-sonnet-4-20250514'), 'Sonnet 4');
  assert.equal(modelName('claude-sonnet-4-5-20250929'), 'Sonnet 4.5');
  assert.equal(modelName('fake-model'), 'fake-model');
});
