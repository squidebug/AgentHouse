import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { AgentInfo } from '@agenthouse/protocol';
import { AgentTracker, agentTranscript } from '../src/claude/agents';
import { isClaudeTranscript, type HookEvent } from '../src/claude/status';
import { ClaudeObserver } from '../src/host/observer';

// Event payloads shaped like Claude Code 2.1.322 sent them for parallel and nested background agents.
const config = path.join(os.tmpdir(), 'agenthouse-agents-config');
const session = path.join(config, 'projects', 'C--work', 'cli-session.jsonl');
const tracker = () =>
  new AgentTracker(
    (id) => agentTranscript(session, id, config),
    (file) => isClaudeTranscript(file, config),
  );

const callAgent = (toolUseId: string, type: string, description: string, by?: string): HookEvent => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'Agent',
  tool_use_id: toolUseId,
  tool_input: { description, prompt: '…', subagent_type: type },
  ...(by ? { agent_id: by, agent_type: 'general-purpose' } : {}),
});
const launched = (toolUseId: string, agentId: string, description: string, by?: string): HookEvent => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Agent',
  tool_use_id: toolUseId,
  tool_input: { description },
  tool_response: { isAsync: true, status: 'async_launched', agentId, description, resolvedModel: 'claude-haiku-5-5' },
  ...(by ? { agent_id: by, agent_type: 'general-purpose' } : {}),
});
const start = (id: string, type: string): HookEvent => ({ hook_event_name: 'SubagentStart', agent_id: id, agent_type: type });
const stop = (id: string, type: string, transcript?: string): HookEvent => ({ hook_event_name: 'SubagentStop', agent_id: id, agent_type: type, ...(transcript ? { agent_transcript_path: transcript } : {}) });
const byAgent = (name: string, id: string, extra: HookEvent = {}): HookEvent => ({ hook_event_name: name, agent_id: id, agent_type: 'Explore', ...extra });

function feed(t: AgentTracker, events: HookEvent[]): AgentTracker {
  events.forEach((event, i) => t.onHook(event, 100 + i));
  return t;
}
const tree = (agents: AgentInfo[]) => agents.map((a) => [a.id, a.parentId, a.agentType, a.description, a.state]);

describe('sub-agents from hook events', () => {
  test('two in parallel and one nested form a tree, whichever order the async hooks arrive in', () => {
    const inOrder = feed(tracker(), [
      callAgent('t1', 'Explore', 'Look around'),
      callAgent('t2', 'general-purpose', 'Plan the change'),
      start('a1', 'Explore'),
      launched('t1', 'a1', 'Look around'),
      start('a2', 'general-purpose'),
      launched('t2', 'a2', 'Plan the change'),
      callAgent('t3', 'Explore', 'Check the tests', 'a2'),
      start('a3', 'Explore'),
      launched('t3', 'a3', 'Check the tests', 'a2'),
    ]);
    const expected = [
      ['a1', null, 'Explore', 'Look around', 'running'],
      ['a2', null, 'general-purpose', 'Plan the change', 'running'],
      ['a3', 'a2', 'Explore', 'Check the tests', 'running'],
    ];
    assert.deepEqual(tree(inOrder.list()), expected);
    assert.equal(inOrder.list()[0]?.model, 'claude-haiku-5-5');
    assert.equal(inOrder.list()[2]?.transcriptPath, path.join(config, 'projects', 'C--work', 'cli-session', 'subagents', 'agent-a3.jsonl'));

    // The result naming an agent can come before its start, and a nested call's start before its result.
    const shuffled = feed(tracker(), [
      callAgent('t1', 'Explore', 'Look around'),
      callAgent('t2', 'general-purpose', 'Plan the change'),
      launched('t2', 'a2', 'Plan the change'),
      start('a1', 'Explore'),
      start('a2', 'general-purpose'),
      launched('t1', 'a1', 'Look around'),
      callAgent('t3', 'Explore', 'Check the tests', 'a2'),
      start('a3', 'Explore'),
      launched('t3', 'a3', 'Check the tests', 'a2'),
    ]);
    assert.deepEqual(tree(shuffled.list()), expected);
  });

  test("Claude's own helpers (no agent type) stay out, and so do their tool calls", () => {
    const t = feed(tracker(), [start('helper', ''), byAgent('PreToolUse', 'helper', { tool_name: 'Read' }), stop('helper', '')]);
    assert.deepEqual(t.list(), []);
    assert.equal(t.asking(), null);
  });

  test('a sub-agent shows the tool it runs; it stops, and a report from its own agent resumes it', () => {
    const own = agentTranscript(session, 'a1', config)!;
    const t = feed(tracker(), [callAgent('t1', 'Explore', 'Look around'), start('a1', 'Explore'), launched('t1', 'a1', 'Look around')]);
    t.onHook(byAgent('PreToolUse', 'a1', { tool_name: 'Read' }));
    assert.equal(t.list()[0]?.tool, 'Read');
    t.onHook(byAgent('PostToolUse', 'a1', { tool_name: 'Read' }));
    assert.equal(t.list()[0]?.tool, null);
    t.onHook(stop('a1', 'Explore', own), 500);
    assert.deepEqual([t.list()[0]?.state, t.list()[0]?.endedAt, t.list()[0]?.transcriptPath], ['stopped', 500, own]);
    t.onHook(start('a1', 'Explore'), 600);
    assert.deepEqual([t.list()[0]?.state, t.list()[0]?.endedAt], ['running', null]);
  });

  test('a dialog of a sub-agent is tracked until a later hook or a recheck closes it', () => {
    const t = feed(tracker(), [start('a1', 'Explore')]);
    t.onHook(byAgent('PreToolUse', 'a1', { tool_name: 'Write' }), 200);
    t.onHook(byAgent('PermissionRequest', 'a1', { tool_name: 'Write' }), 201);
    assert.deepEqual(t.asking() && [t.asking()!.agentId, t.asking()!.kind, t.asking()!.tool], ['a1', 'permission', 'Write']);
    assert.equal(t.list()[0]?.asking, true);
    t.onHook(byAgent('PostToolUse', 'a1', { tool_name: 'Write' }));
    assert.equal(t.asking(), null);
    assert.equal(t.list()[0]?.asking, false);
    t.onHook(byAgent('PermissionRequest', 'a1', { tool_name: 'Bash' }));
    assert.equal(t.clearAsks(), true);
    assert.equal(t.asking(), null);
  });

  test('the sub-agent status line adds model and tokens but never stops an agent; it fills in missed agents', () => {
    const t = feed(tracker(), [start('a1', 'Explore')]);
    t.onStatusLine([
      { id: 'a1', type: 'local_agent', agentType: 'Explore', status: 'completed', description: 'Look around', model: 'claude-haiku-5-5', tokenCount: 35278, startTime: 1 },
      { id: 'a9', type: 'local_agent', agentType: 'Plan', status: 'running', description: 'Plan', model: 'claude-opus-5-5', tokenCount: 10, startTime: 2 },
      { id: 'x1', type: 'local_agent', agentType: '', status: 'running' },
      { id: 'sh1', type: 'shell', agentType: 'Bash', status: 'running' },
    ]);
    const [first, missed] = t.list();
    assert.deepEqual([first?.state, first?.tokens, first?.model, first?.description], ['running', 35278, 'claude-haiku-5-5', 'Look around']);
    assert.deepEqual([missed?.id, missed?.state, missed?.startedAt, t.list().length], ['a9', 'running', 2, 2]);

    t.onHook({ hook_event_name: 'Stop', background_tasks: [{ id: 'a5', type: 'subagent', status: 'running', description: 'Survey', agent_type: 'Explore' }] });
    assert.deepEqual(t.list().at(-1) && [t.list().at(-1)!.id, t.list().at(-1)!.description], ['a5', 'Survey']);
  });

  test('ids and paths from payloads are checked before a path is built or kept', () => {
    const t = feed(tracker(), [start('../../evil', 'Explore'), start('a1', 'Explore'), stop('a1', 'Explore', 'C:\\Windows\\win.ini')]);
    assert.deepEqual(
      t.list().map((a) => a.id),
      ['a1'],
    );
    assert.equal(t.list()[0]?.transcriptPath, agentTranscript(session, 'a1', config), 'the path outside the projects folder is ignored');
    assert.equal(agentTranscript(session, '..', config), null);
    assert.equal(agentTranscript(undefined, 'a1', config), null);
  });

  test('when the session ends, whatever ran has stopped', () => {
    const t = feed(tracker(), [start('a1', 'Explore'), byAgent('PermissionRequest', 'a1', { tool_name: 'Write' })]);
    assert.equal(t.stopAll(900), true);
    assert.deepEqual([t.list()[0]?.state, t.list()[0]?.endedAt, t.list()[0]?.asking, t.asking()], ['stopped', 900, false, null]);
  });
});

describe('the session status with background sub-agents', () => {
  test("a sub-agent's tool calls leave the idle main conversation alone; its dialog makes the session wait", () => {
    const observer = new ClaudeObserver({ token: 't', vendorSessionId: 'cli-session', agentsCommand: null, env: { CLAUDE_CONFIG_DIR: config }, pid: 1 });
    const hook = (event: HookEvent) => observer.onHook({ session_id: 'cli-session', transcript_path: session, ...event });
    hook({ hook_event_name: 'SessionStart', source: 'startup' });
    hook({ hook_event_name: 'UserPromptSubmit' });
    hook(callAgent('t1', 'Explore', 'Look around'));
    hook(start('a1', 'Explore'));
    hook(launched('t1', 'a1', 'Look around'));
    hook({ hook_event_name: 'Stop' });
    assert.equal(observer.status.value, 'idle', 'the main turn ended; the agent works in the background');

    hook(byAgent('PreToolUse', 'a1', { tool_name: 'Read' }));
    hook(byAgent('PostToolUse', 'a1', { tool_name: 'Read' }));
    assert.equal(observer.status.value, 'idle');
    assert.equal(observer.agents[0]?.state, 'running');

    hook(byAgent('PreToolUse', 'a1', { tool_name: 'Write' }));
    hook(byAgent('PermissionRequest', 'a1', { tool_name: 'Write' }));
    assert.deepEqual([observer.status.value, observer.status.reason], ['awaiting_permission', 'Write']);
    hook(byAgent('PostToolUse', 'a1', { tool_name: 'Write' }));
    assert.equal(observer.status.value, 'idle', 'approved: back to what the main conversation does');

    hook(stop('a1', 'Explore'));
    hook({ hook_event_name: 'UserPromptSubmit' }); // the agent's report, as a prompt
    assert.equal(observer.status.value, 'working', 'the report starts a turn');
    hook({ hook_event_name: 'Stop' });
    assert.equal(observer.status.value, 'idle');

    hook(start('a2', 'Explore'));
    observer.exited(0, 1000);
    assert.deepEqual([observer.status.value, observer.agents[1]?.state], ['exited', 'stopped']);
  });

  test("`agents --json` waiting while a sub-agent asks is that agent's dialog: the main conversation stays as it was", async () => {
    // Stands in for `claude agents --json`: this session waits for a permission prompt.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'agenthouse-agents-cmd-'));
    const script = path.join(dir, 'agents.mjs');
    writeFileSync(script, `console.log(JSON.stringify([{ pid: 1, sessionId: 'cli-session', status: 'waiting', waitingFor: 'permission prompt' }]));\n`);
    const observer = new ClaudeObserver({
      token: 't',
      vendorSessionId: 'cli-session',
      agentsCommand: { file: process.execPath, args: [script] },
      env: { ...process.env, CLAUDE_CONFIG_DIR: config },
      pid: 1,
    });
    try {
      const hook = (event: HookEvent) => observer.onHook({ session_id: 'cli-session', transcript_path: session, ...event });
      hook({ hook_event_name: 'SessionStart', source: 'startup' });
      hook(callAgent('t1', 'Explore', 'Look around'));
      hook(start('a1', 'Explore'));
      hook(launched('t1', 'a1', 'Look around'));
      hook({ hook_event_name: 'Stop' });
      hook(byAgent('PreToolUse', 'a1', { tool_name: 'Write' }));
      hook(byAgent('PermissionRequest', 'a1', { tool_name: 'Write' }));
      assert.equal(observer.status.value, 'awaiting_permission');
      assert.equal(observer.acceptsInput(), false, 'nothing goes in while the agent asks');
      assert.equal(await observer.waiting(), 'awaiting_permission', 'the CLI itself says it waits');

      observer.typed('\x1b[B'); // an arrow key on the dialog: a recheck follows
      await new Promise((resolve) => setTimeout(resolve, 2000));
      hook(byAgent('PostToolUse', 'a1', { tool_name: 'Write' }));
      assert.equal(observer.status.value, 'idle', 'answered: the main conversation was idle all along');
      assert.equal(observer.acceptsInput(), true);
    } finally {
      observer.exited(0, Date.now());
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('before its first hook a Claude session takes no text: its folder trust question may be up', () => {
    const observer = new ClaudeObserver({ token: 't', vendorSessionId: null, agentsCommand: null, env: { CLAUDE_CONFIG_DIR: config }, pid: 1 });
    assert.deepEqual([observer.status.value, observer.acceptsInput()], ['starting', false]);
    observer.onHook({ hook_event_name: 'SessionStart', source: 'startup', session_id: 'cli-session' });
    assert.deepEqual([observer.status.value, observer.acceptsInput()], ['idle', true]);
    observer.onHook({ hook_event_name: 'UserPromptSubmit' });
    assert.equal(observer.acceptsInput(), true, 'a working session takes text: Claude queues it');
    observer.exited(0, Date.now());
  });
});
