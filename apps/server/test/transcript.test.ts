import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { ConversationEntry } from '@agenthouse/protocol';
import { ConversationBuilder, entryDetail, toolSummary, type LineRange } from '../src/claude/transcript';
import { assistant, CWD, interrupt, noise, prompt, system, text, thinking, toolResult, toolUse, usage } from './fixtures/transcript';

function build(records: unknown[], builder = new ConversationBuilder()) {
  let offset = 0;
  for (const record of records) {
    const length = JSON.stringify(record).length;
    builder.add(record, [offset, offset + length]);
    offset += length + 1;
  }
  return builder;
}

const kinds = (entries: ConversationEntry[]) => entries.map((e) => (e.kind === 'notice' ? `notice:${e.notice}` : e.kind));

describe('conversation from a Claude Code transcript', () => {
  test('a turn: prompt, thinking, a tool call and its result, the answer; usage counted once per API call', () => {
    const records = [
      ...noise(),
      prompt('How many files are there?'),
      assistant('msg_1', thinking('Let me list them.'), usage(10, 1000, 200, 50)),
      assistant('msg_1', toolUse('toolu_1', 'Bash', { command: 'ls | wc -l', description: 'Count files' }), usage(10, 1000, 200, 50)),
      toolResult('toolu_1', '42'),
      assistant('msg_2', text('There are **42** files.'), usage(3, 1300, 0, 12)),
      system('turn_duration', { durationMs: 4200 }),
    ];
    const { turns, entries } = build(records).snapshot();
    assert.deepEqual(kinds(entries), ['prompt', 'thinking', 'tool', 'text']);
    assert.equal(turns.length, 1);
    const [turn] = turns;
    assert.deepEqual(turn?.usage, { input: 13, cacheRead: 2300, cacheWrite: 200, output: 62, calls: 2 }, 'msg_1 has two records but is one call');
    assert.deepEqual([turn?.model, turn?.effort, turn?.durationMs, turn?.interrupted], ['claude-haiku-5-5', 'low', 4200, false]);
    assert.ok(turn?.startedAt && turn.endedAt && turn.endedAt > turn.startedAt);
    const tool = entries.find((e) => e.kind === 'tool');
    assert.deepEqual(tool && tool.kind === 'tool' && [tool.name, tool.summary, tool.state], ['Bash', 'ls | wc -l', 'done']);
    const answer = entries.at(-1);
    assert.equal(answer?.kind === 'text' && answer.text, 'There are **42** files.');
    assert.equal(entries[0]?.kind === 'prompt' && entries[0].text, 'How many files are there?');
  });

  test('a denied tool, then the interrupt marker; a tool that failed', () => {
    const records = [
      prompt('Write a file'),
      assistant('msg_1', toolUse('toolu_1', 'Write', { file_path: path.join(CWD, 'src', 'a.txt'), content: 'x' })),
      toolResult('toolu_1', "The user doesn't want to proceed with this tool use.", { toolDenialKind: 'user-rejected', toolUseResult: 'User rejected tool use' }, true),
      interrupt(true),
      prompt('Run the tests'),
      assistant('msg_2', toolUse('toolu_2', 'Bash', { command: 'pnpm test\necho done' })),
      toolResult('toolu_2', 'Error: Exit code 1', { toolUseResult: 'Error: Exit code 1' }, true),
    ];
    const { turns, entries } = build(records).snapshot();
    assert.deepEqual(kinds(entries), ['prompt', 'tool', 'notice:interrupted', 'prompt', 'tool']);
    const [denied, failed] = entries.filter((e) => e.kind === 'tool');
    assert.deepEqual(denied?.kind === 'tool' && [denied.state, denied.summary], ['denied', 'src/a.txt'], 'paths inside the session folder are shown relative');
    assert.deepEqual(failed?.kind === 'tool' && [failed.state, failed.summary], ['error', 'pnpm test …'], 'a longer command shows its first line');
    assert.deepEqual(
      turns.map((t) => t.interrupted),
      [true, false],
    );
  });

  test('slash commands with their output; messages from other agents; API errors', () => {
    const records = [
      prompt('<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>', { origin: undefined }),
      system('local_command', { content: '<local-command-stdout>Set model to \x1b[1mOpus\x1b[22m</local-command-stdout>' }),
      prompt('Done: the files are sorted.', { origin: { kind: 'peer', name: 'general-purpose', from: 'agent-1' } }),
      assistant('msg_1', text('Login expired · Please run /login'), usage(0, 0, 0, 0), { isApiErrorMessage: true, error: 'authentication_failed' }),
    ];
    const { entries } = build(records).snapshot();
    assert.deepEqual(kinds(entries), ['command', 'prompt', 'notice:api_error']);
    const [command, peer, error] = entries;
    assert.deepEqual(command?.kind === 'command' && [command.name, command.args, command.output], ['/model', 'opus', 'Set model to Opus']);
    assert.equal(peer?.kind === 'prompt' && peer.from, 'general-purpose');
    assert.equal(error?.kind === 'notice' && error.text, 'Login expired · Please run /login');
  });

  test('a sub-agent call becomes its own block with its type and id', () => {
    const records = [
      prompt('Look around'),
      assistant('msg_1', toolUse('toolu_9', 'Agent', { subagent_type: 'Explore', description: 'Survey the code', prompt: 'Find…' })),
      toolResult('toolu_9', 'Report', { toolUseResult: { agentId: 'a74dfe', status: 'completed', description: 'Survey the code' } }),
    ];
    const agent = build(records).snapshot().entries.find((e) => e.kind === 'agent');
    assert.deepEqual(agent?.kind === 'agent' && [agent.agentType, agent.description, agent.state, agent.agentId], ['Explore', 'Survey the code', 'done', 'a74dfe']);
  });

  test('/clear starts the next transcript as a new conversation; a compaction is marked', () => {
    const builder = build([prompt('First'), assistant('msg_1', text('One'))]);
    builder.startSegment(1, Date.UTC(2026, 10, 11, 6));
    build(
      [
        prompt('<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>', { origin: undefined }),
        prompt('Second'),
        system('compact_boundary', { compactMetadata: { trigger: 'auto', preTokens: 150000 } }),
        prompt('This session is being continued from a previous conversation…', { isCompactSummary: true }),
        assistant('msg_2', text('Two')),
      ],
      builder,
    );
    const { turns, entries } = builder.snapshot();
    assert.deepEqual(kinds(entries), ['prompt', 'text', 'notice:cleared', 'command', 'prompt', 'notice:compacted', 'text']);
    assert.deepEqual(
      turns.map((t) => [t.index, t.segment]),
      [
        [0, 0],
        [1, 1],
        [2, 1],
      ],
    );
    assert.ok(entries.every((e, i) => entries.findIndex((other) => other.id === e.id) === i), 'ids stay unique across transcripts');
    const compacted = entries.find((e) => e.kind === 'notice' && e.notice === 'compacted');
    assert.ok(compacted && builder.sources.get(compacted.id), 'the summary can be opened');
  });

  test('only what changed is handed out after the first snapshot', () => {
    const builder = build([prompt('Go'), assistant('msg_1', toolUse('toolu_1', 'Read', { file_path: path.join(CWD, 'README.md') }))]);
    builder.takeChanges();
    assert.equal(builder.takeChanges(), null);
    build([toolResult('toolu_1', '# Shop')], builder);
    const changes = builder.takeChanges();
    assert.deepEqual(
      changes?.entries.map((e) => e.kind === 'tool' && [e.id, e.state]),
      [['s0-toolu_1', 'done']],
    );
    assert.deepEqual(
      changes?.turns.map((t) => t.index),
      [0],
    );
  });

  test('details come from the lines the entry was read from', () => {
    const use = assistant('msg_1', toolUse('toolu_1', 'Edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }));
    const result = toolResult('toolu_1', 'The file a.ts has been updated.', {
      toolUseResult: { filePath: 'a.ts', structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-a', '+b'] }] },
    });
    const builder = build([prompt('Fix it'), use, result, assistant('msg_2', thinking('Hmm.'))]);
    const tool = builder.entry('s0-toolu_1')!;
    assert.deepEqual(builder.sources.get(tool.id)?.lines.length, 2, 'the call and its result');
    const detail = entryDetail(tool, [use, result]);
    assert.deepEqual(detail.input, { file_path: 'a.ts', old_string: 'a', new_string: 'b' });
    assert.equal(detail.text, 'The file a.ts has been updated.');
    assert.deepEqual(detail.patch, [{ oldStart: 3, newStart: 3, lines: ['-a', '+b'] }]);
    const thought = builder.snapshot().entries.find((e) => e.kind === 'thinking')!;
    assert.equal(entryDetail(thought, [builder.sources.get(thought.id) && assistant('msg_2', thinking('Hmm.'))]).text, 'Hmm.');
    const big = entryDetail(tool, [assistant('msg_1', toolUse('toolu_1', 'Write', { file_path: 'b', content: 'x'.repeat(300_000) })), null]);
    assert.equal(big.truncated, true);
  });

  test('tool summaries', () => {
    assert.equal(toolSummary('Grep', { pattern: 'TODO', path: path.join(CWD, 'src') }, CWD), 'TODO  src');
    assert.equal(toolSummary('WebFetch', { url: 'https://example.com/a' }, CWD), 'https://example.com/a');
    assert.equal(toolSummary('Read', { file_path: '/elsewhere/x.md' }, CWD), '/elsewhere/x.md');
    assert.equal(toolSummary('mcp__docs__search', { query: 'hooks' }, CWD), 'hooks');
    assert.equal(toolSummary('Bash', { command: 'x'.repeat(400) }, CWD).length, 301);
  });

  test('records that are not objects, or of kinds it does not know, change nothing', () => {
    const builder = new ConversationBuilder();
    const range: LineRange = [0, 1];
    for (const record of [null, 3, 'text', [], { type: 'user' }, { type: 'assistant', message: 'x' }, { type: 'system', subtype: 'new-thing' }]) builder.add(record, range);
    assert.deepEqual(builder.snapshot().entries, []);
  });
});
