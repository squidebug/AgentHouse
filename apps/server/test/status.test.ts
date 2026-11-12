import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { SessionStatus } from '@agenthouse/protocol';
import {
  applyAgents,
  applyHook,
  applyStatusLine,
  Dialogs,
  endsWithInterrupt,
  exitedStatus,
  initialStatus,
  initialTelemetry,
  isClaudeTranscript,
  limitsFrom,
  type HookEvent,
} from '../src/claude/status';

// Event sequences as Claude Code 2.1.322 sent them in a recorded session.
function run(events: HookEvent[], from: SessionStatus = initialStatus(0)): SessionStatus {
  return events.reduce((status, event, i) => applyHook(status, event, i + 1), from);
}

describe('status from hook events', () => {
  test('a turn without tools: idle → working → idle', () => {
    assert.equal(run([{ hook_event_name: 'SessionStart', source: 'startup' }]).value, 'idle');
    const working = run([{ hook_event_name: 'SessionStart', source: 'startup' }, { hook_event_name: 'UserPromptSubmit' }]);
    assert.equal(working.value, 'working');
    assert.equal(applyHook(working, { hook_event_name: 'Stop' }).value, 'idle');
  });

  test('a tool that needs permission: working(tool) → awaiting_permission → working → idle', () => {
    const tool = run([{ hook_event_name: 'UserPromptSubmit' }, { hook_event_name: 'PreToolUse', tool_name: 'Write' }]);
    assert.deepEqual([tool.value, tool.tool], ['working', 'Write']);
    const asking = applyHook(tool, { hook_event_name: 'PermissionRequest', tool_name: 'Write' });
    assert.deepEqual([asking.value, asking.reason], ['awaiting_permission', 'Write']);
    // The notification for the same dialog arrives too; it changes nothing.
    assert.equal(applyHook(asking, { hook_event_name: 'Notification', notification_type: 'permission_prompt' }), asking);
    const resumed = applyHook(asking, { hook_event_name: 'PostToolUse', tool_name: 'Write' });
    assert.deepEqual([resumed.value, resumed.tool], ['working', null]);
    assert.equal(applyHook(resumed, { hook_event_name: 'Stop' }).value, 'idle');
  });

  test('a permission notification alone also means waiting for approval', () => {
    const tool = run([{ hook_event_name: 'UserPromptSubmit' }, { hook_event_name: 'PreToolUse', tool_name: 'Bash' }]);
    const asking = applyHook(tool, { hook_event_name: 'Notification', notification_type: 'permission_prompt' });
    assert.deepEqual([asking.value, asking.reason], ['awaiting_permission', 'Bash']);
  });

  test('questions and plan approval wait for input', () => {
    const question = run([{ hook_event_name: 'UserPromptSubmit' }, { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }]);
    assert.deepEqual([question.value, question.reason], ['awaiting_input', 'question']);
    const plan = run([{ hook_event_name: 'UserPromptSubmit' }, { hook_event_name: 'PreToolUse', tool_name: 'ExitPlanMode' }]);
    assert.deepEqual([plan.value, plan.reason], ['awaiting_input', 'plan']);
  });

  test('/clear starts over as idle; a failed turn is idle with an error', () => {
    const cleared = run([{ hook_event_name: 'UserPromptSubmit' }, { hook_event_name: 'SessionEnd', reason: 'clear' } as HookEvent, { hook_event_name: 'SessionStart', source: 'clear' }]);
    assert.deepEqual([cleared.value, cleared.reason], ['idle', 'cleared']);
    const failed = run([{ hook_event_name: 'UserPromptSubmit' }, { hook_event_name: 'StopFailure', error_type: 'rate_limit' }]);
    assert.deepEqual([failed.value, failed.error, failed.reason], ['idle', true, 'rate_limit']);
  });

  test('compacting on its own mid-turn leaves the turn working', () => {
    const compacted = run([{ hook_event_name: 'UserPromptSubmit' }, { hook_event_name: 'PreToolUse', tool_name: 'Read' }, { hook_event_name: 'SessionStart', source: 'compact' }]);
    assert.deepEqual([compacted.value, compacted.tool], ['working', 'Read']);
  });

  test('a failed or auto-denied tool resumes the turn; an MCP elicitation waits for input', () => {
    const asking = run([{ hook_event_name: 'UserPromptSubmit' }, { hook_event_name: 'PermissionRequest', tool_name: 'Bash' }]);
    assert.equal(applyHook(asking, { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash' }).value, 'working');
    assert.equal(applyHook(asking, { hook_event_name: 'PermissionDenied', tool_name: 'Bash' }).value, 'working');
    const elicited = applyHook(run([{ hook_event_name: 'UserPromptSubmit' }]), { hook_event_name: 'Elicitation' });
    assert.deepEqual([elicited.value, elicited.reason], ['awaiting_input', 'elicitation']);
    assert.equal(applyHook(elicited, { hook_event_name: 'ElicitationResult' }).value, 'working');
  });

  test('unknown events and events after exit change nothing', () => {
    const working = run([{ hook_event_name: 'UserPromptSubmit' }]);
    assert.equal(applyHook(working, { hook_event_name: 'SubagentStop' }), working);
    assert.equal(applyHook(working, { hook_event_name: 'SomethingNew' }), working);
    const exited = exitedStatus(0, 5);
    assert.equal(applyHook(exited, { hook_event_name: 'UserPromptSubmit' }), exited);
    assert.equal(exitedStatus(1).error, true);
  });
});

describe('status line', () => {
  const line = {
    model: { id: 'claude-haiku-5-5', display_name: 'Haiku 5.5' },
    effort: { level: 'low' },
    context_window: { used_percentage: 12.5, context_window_size: 1_000_000 },
    cost: { total_cost_usd: 0.03 },
    rate_limits: { five_hour: { used_percentage: 13, resets_at: 1794388800 }, seven_day: { used_percentage: 23, resets_at: 1794758400 } },
  };

  test('telemetry takes model, effort, context and cost', () => {
    const telemetry = applyStatusLine(initialTelemetry(), line);
    assert.deepEqual(telemetry, { level: 'minimal', model: 'Haiku 5.5', effort: 'low', contextPct: 12.5, contextWindow: 1_000_000, costUsd: 0.03 });
    // Right after /clear the percentage is null: unknown, not the old value.
    const cleared = applyStatusLine(telemetry, { ...line, context_window: { used_percentage: null, context_window_size: 1_000_000 } });
    assert.equal(cleared.contextPct, null);
  });

  test('plan limits are read with reset times in milliseconds', () => {
    assert.deepEqual(limitsFrom(line, 7), {
      fiveHour: { usedPct: 13, resetsAt: 1794388800000 },
      sevenDay: { usedPct: 23, resetsAt: 1794758400000 },
      at: 7,
    });
    assert.equal(limitsFrom({ model: line.model }), null, 'API key sessions report no plan limits');
  });
});

describe('claude agents --json', () => {
  test('idle, busy and waiting map to the status when no hook can tell', () => {
    const asking = run([{ hook_event_name: 'UserPromptSubmit' }, { hook_event_name: 'PreToolUse', tool_name: 'Write' }, { hook_event_name: 'PermissionRequest', tool_name: 'Write' }]);
    // Denying with Esc fires no hook; the CLI then lists the session as idle.
    assert.equal(applyAgents(asking, { status: 'idle' }, 9).value, 'idle');
    assert.equal(applyAgents(asking, { status: 'busy' }, 9).value, 'working');
    const working = run([{ hook_event_name: 'UserPromptSubmit' }]);
    const waiting = applyAgents(working, { status: 'waiting', waitingFor: 'permission prompt' }, 9);
    assert.equal(waiting.value, 'awaiting_permission');
    assert.equal(applyAgents(waiting, { status: 'waiting', waitingFor: 'permission prompt' }), waiting, 'unchanged');
    assert.equal(applyAgents(working, { status: 'waiting', waitingFor: 'question' }).value, 'awaiting_input');
    assert.equal(applyAgents(working, { status: 'something new' }), working);
  });
});

describe('transcript paths from hook payloads', () => {
  const config = path.join(os.tmpdir(), 'claude-config');
  test('only .jsonl files under the projects folder are opened', () => {
    assert.equal(isClaudeTranscript(path.join(config, 'projects', 'C--work', 'abc.jsonl'), config), true);
    assert.equal(isClaudeTranscript(path.join(config, 'projects', '..', 'settings.jsonl'), config), false, 'no climbing out');
    assert.equal(isClaudeTranscript(path.join(os.tmpdir(), 'elsewhere.jsonl'), config), false);
    assert.equal(isClaudeTranscript(path.join(config, 'projects', 'C--work', 'abc.json'), config), false);
    assert.equal(isClaudeTranscript('\\\\attacker\\share\\abc.jsonl', config), false, 'UNC: Windows would send credentials');
    assert.equal(isClaudeTranscript('//attacker/share/abc.jsonl', config), false);
    assert.equal(isClaudeTranscript('projects/abc.jsonl', config), false, 'relative');
  });
});

describe('interrupt marker', () => {
  const user = (content: unknown) => JSON.stringify({ type: 'user', message: { role: 'user', content } });
  const assistant = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '1 2 3' }] } });

  test('the newest user entry decides', () => {
    assert.equal(endsWithInterrupt([user('count to 1500'), assistant, user([{ type: 'text', text: '[Request interrupted by user]' }])].join('\n')), true);
    assert.equal(endsWithInterrupt([user([{ type: 'text', text: '[Request interrupted by user]' }]), user('next question'), assistant].join('\n')), false);
    assert.equal(endsWithInterrupt('{"type":"user","message":{"rol'), false, 'a cut-off line is skipped');
  });

  test('the same words inside a tool result (a file Claude just read) are not the marker', () => {
    const read = user([{ type: 'tool_result', tool_use_id: 't1', content: "const marker = '[Request interrupted by user]';" }]);
    assert.equal(endsWithInterrupt([user('read status.ts'), assistant, read].join('\n')), false);
    assert.equal(endsWithInterrupt(user('[Request interrupted by user for tool use]')), true, 'a plain-text marker');
  });
});

describe('dialogs of the main conversation', () => {
  const bash = (command: string) => ({ tool_name: 'Bash', tool_input: { command, description: command } });

  test('a call that ends next to one that asks does not hide its dialog', () => {
    const dialogs = new Dialogs();
    dialogs.onHook({ hook_event_name: 'PreToolUse', tool_use_id: 'r1', tool_name: 'Read', tool_input: { file_path: '/a' } }, 1);
    dialogs.onHook({ hook_event_name: 'PreToolUse', tool_use_id: 'b1', ...bash('rm -rf build') }, 2);
    dialogs.onHook({ hook_event_name: 'PreToolUse', tool_use_id: 'b2', ...bash('ls') }, 3);
    dialogs.onHook({ hook_event_name: 'PermissionRequest', ...bash('rm -rf build') }, 4);
    assert.equal(dialogs.current()?.value, 'awaiting_permission');
    dialogs.onHook({ hook_event_name: 'PostToolUse', tool_use_id: 'r1', tool_name: 'Read', tool_input: { file_path: '/a' } }, 5);
    dialogs.onHook({ hook_event_name: 'PostToolUse', tool_use_id: 'b2', ...bash('ls') }, 6);
    assert.deepEqual([dialogs.current()?.value, dialogs.current()?.tool], ['awaiting_permission', 'Bash'], 'another Bash call ended; this one still asks');
    dialogs.onHook({ hook_event_name: 'PostToolUse', tool_use_id: 'b1', ...bash('rm -rf build') }, 7);
    assert.equal(dialogs.current(), null, 'answered');
  });

  test('a permission asked before its PreToolUse arrived (async hooks) still closes; a new turn clears what is left', () => {
    const dialogs = new Dialogs();
    dialogs.onHook({ hook_event_name: 'PermissionRequest', tool_name: 'Write', tool_input: { file_path: '/x', content: 'a' } }, 1);
    dialogs.onHook({ hook_event_name: 'PreToolUse', tool_use_id: 'w1', tool_name: 'Write', tool_input: { content: 'a', file_path: '/x' } }, 2);
    assert.equal(dialogs.current()?.value, 'awaiting_permission');
    dialogs.onHook({ hook_event_name: 'PostToolUseFailure', tool_use_id: 'w1', tool_name: 'Write', tool_input: { file_path: '/x', content: 'a' } }, 3);
    assert.equal(dialogs.current(), null, 'the same input in another key order is the same call');

    dialogs.onHook({ hook_event_name: 'PreToolUse', tool_use_id: 'q1', tool_name: 'AskUserQuestion', tool_input: { questions: [] } }, 4);
    assert.deepEqual([dialogs.current()?.value, dialogs.current()?.reason], ['awaiting_input', 'question']);
    dialogs.onHook({ hook_event_name: 'Stop' }, 5);
    assert.equal(dialogs.current(), null);
    dialogs.onHook({ hook_event_name: 'PreToolUse', tool_use_id: 'p1', tool_name: '__proto__' }, 6);
    assert.equal(dialogs.current(), null, 'only the asking tools ask');
  });
});
