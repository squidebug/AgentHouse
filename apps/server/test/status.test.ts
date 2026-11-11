import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { SessionStatus } from '@agenthouse/protocol';
import {
  applyAgents,
  applyHook,
  applyStatusLine,
  endsWithInterrupt,
  exitedStatus,
  initialStatus,
  initialTelemetry,
  limitsFrom,
  type HookEvent,
} from '../src/sessions/status';

// Event sequences as Claude Code 2.1.322 sent them (see facts §2.2).
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

describe('interrupt marker', () => {
  const user = (content: unknown) => JSON.stringify({ type: 'user', message: { role: 'user', content } });
  const assistant = JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '1 2 3' }] } });

  test('the newest user entry decides', () => {
    assert.equal(endsWithInterrupt([user('count to 1500'), assistant, user([{ type: 'text', text: '[Request interrupted by user]' }])].join('\n')), true);
    assert.equal(endsWithInterrupt([user([{ type: 'text', text: '[Request interrupted by user]' }]), user('next question'), assistant].join('\n')), false);
    assert.equal(endsWithInterrupt('{"type":"user","message":{"rol'), false, 'a cut-off line is skipped');
  });
});
