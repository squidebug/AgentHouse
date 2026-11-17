import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BackgroundTracker, slashName } from '../src/claude/background';

// Payloads as Claude Code 2.1.325 sent them (a probe with logging hooks), cut to what is read.
const bash = (taskId: string, input: object = {}) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'sleep 20; echo probe-done', description: 'Run sleep probe in background', run_in_background: true, ...input },
  tool_response: { stdout: '', stderr: '', interrupted: false, isImage: false, noOutputExpected: false, backgroundTaskId: taskId },
});
const stop = (tasks: object[] = [], crons: object[] = []) => ({ hook_event_name: 'Stop', background_tasks: tasks, session_crons: crons });
const shell = (id: string, extra: object = {}) => ({ id, type: 'shell', status: 'running', description: 'Run sleep probe in background', command: 'sleep 20; echo probe-done', ...extra });
const notice = (lines: string[]) => ({ hook_event_name: 'UserPromptSubmit', prompt: ['<task-notification>', ...lines, '</task-notification>'].join('\n') });
const ended = (id: string, summary: string, status = 'completed') => notice([`<task-id>${id}</task-id>`, '<tool-use-id>toolu_01</tool-use-id>', `<status>${status}</status>`, `<summary>${summary}</summary>`]);
const prompt = (text: string) => ({ hook_event_name: 'UserPromptSubmit', prompt: text });

test('a shell command in the background runs past its turn, until its end is reported', () => {
  const tracker = new BackgroundTracker();
  assert.equal(tracker.onHook(bash('b0021ba2l'), 1000), true);
  assert.deepEqual(tracker.list(), [
    { id: 'b0021ba2l', type: 'shell', description: 'Run sleep probe in background', command: 'sleep 20; echo probe-done', state: 'running', exitCode: null, lastEvent: null, startedAt: 1000, endedAt: null },
  ]);
  assert.equal(tracker.onHook(stop([shell('b0021ba2l')]), 2000), false, 'the end of the turn lists it: nothing new');
  assert.equal(tracker.onHook(ended('b0021ba2l', 'Background command "Run sleep probe in background" completed (exit code 0)'), 21_000), true);
  const [task] = tracker.list();
  assert.deepEqual([task?.state, task?.exitCode, task?.endedAt], ['done', 0, 21_000]);
  assert.equal(tracker.onHook(stop(), 23_000), false, 'ended tasks stay listed');
  assert.equal(tracker.list().length, 1);
});

test('a task notification is a prompt that begins with it: the same block inside what was typed or pasted is text', () => {
  const tracker = new BackgroundTracker();
  tracker.onHook(bash('b1'), 1);
  const report = ended('b1', 'Background command "x" completed (exit code 0)').prompt;
  assert.equal(tracker.onHook(prompt(`look at this log:\n${report}`), 2), false);
  assert.equal(tracker.list()[0]?.state, 'running', 'a quoted report ends nothing');
  const line = ['<task-notification>', '<task-id>m9</task-id>', '<summary>Monitor event: "deploy status"</summary>', '<event>deployed 3 of 5</event>', '</task-notification>'].join('\n');
  assert.equal(tracker.onHook(prompt(`the other session said:\n${line}`), 3), false);
  assert.equal(tracker.list().length, 1, 'and a quoted line of a monitor adds none');
  assert.equal(tracker.onHook(prompt(`\n${report}`), 4), true, "Claude's own, whatever space comes before it");
  assert.equal(tracker.list()[0]?.state, 'done');
});

test('a command that ends with another exit code, or is reported as failed, has failed', () => {
  const tracker = new BackgroundTracker();
  tracker.onHook(bash('one'), 1);
  tracker.onHook(bash('two'), 1);
  tracker.onHook(ended('one', 'Background command "x" completed (exit code 2)'), 2);
  tracker.onHook(ended('two', 'Background command "x" failed', 'failed'), 2);
  assert.deepEqual(
    tracker.list().map((t) => [t.state, t.exitCode]),
    [
      ['failed', 2],
      ['failed', null],
    ],
  );
});

test('a monitor is known by what started it though Stop lists it as a shell; its lines show, then its end', () => {
  const tracker = new BackgroundTracker();
  tracker.onHook({ hook_event_name: 'PostToolUse', tool_name: 'Monitor', tool_input: { description: 'probe ticks', timeout_ms: 60000, command: 'for i in 1 2 3; do echo tick-$i; sleep 5; done' }, tool_response: { taskId: 'b4hy5iyck', timeoutMs: 60000, persistent: false } }, 1);
  tracker.onHook(stop([shell('b4hy5iyck', { description: 'probe ticks' })]), 2);
  assert.equal(tracker.list()[0]?.type, 'monitor');
  assert.equal(tracker.onHook(notice(['<task-id>b4hy5iyck</task-id>', '<summary>Monitor event: "probe ticks"</summary>', '<event>tick-2</event>']), 3), true);
  assert.deepEqual([tracker.list()[0]?.lastEvent, tracker.list()[0]?.state], ['tick-2', 'running']);
  tracker.onHook(ended('b4hy5iyck', 'Monitor "probe ticks" stream ended'), 4);
  assert.deepEqual([tracker.list()[0]?.state, tracker.list()[0]?.exitCode, tracker.list()[0]?.lastEvent], ['done', null, 'tick-2']);
});

test('what a hook missed is taken from the lists: a task first seen at Stop, one no longer listed, a monitor known by its line', () => {
  const tracker = new BackgroundTracker();
  assert.equal(tracker.onHook(stop([shell('late'), { id: 'a73bd1faebf40e0c7', type: 'subagent', status: 'running', description: 'an agent', agent_type: 'Explore' }]), 10), true);
  assert.deepEqual(tracker.list().map((t) => [t.id, t.type, t.state]), [['late', 'shell', 'running']], "a sub-agent is the agent tree's, not a task");
  // Its notice came in the middle of a turn, where no hook tells: the next list is without it.
  assert.equal(tracker.onHook(stop(), 20), true);
  assert.deepEqual([tracker.list()[0]?.state, tracker.list()[0]?.endedAt], ['done', 20]);
  tracker.onHook(notice(['<task-id>watcher</task-id>', '<summary>Monitor event: "queue depth"</summary>', '<event>12 waiting</event>']), 30);
  assert.deepEqual(tracker.list().map((t) => [t.id, t.type, t.description, t.lastEvent])[1], ['watcher', 'monitor', 'queue depth', '12 waiting']);
  // A sub-agent's report is the same block with the agent's id: no task of that name, nothing happens.
  assert.equal(tracker.onHook(ended('a73bd1faebf40e0c7', 'Agent "an agent" finished'), 40), false);
});

test('TaskStop stops a task, and the end of the session whatever still ran', () => {
  const tracker = new BackgroundTracker();
  tracker.onHook(bash('one'), 1);
  tracker.onHook(bash('two'), 1);
  assert.equal(tracker.onHook({ hook_event_name: 'PostToolUse', tool_name: 'TaskStop', tool_input: { task_id: 'one' }, tool_response: { message: 'stopped', task_id: 'one', task_type: 'local_bash' } }, 5), true);
  assert.equal(tracker.stopAll(9), true);
  assert.deepEqual(
    tracker.list().map((t) => [t.state, t.endedAt]),
    [
      ['stopped', 5],
      ['stopped', 9],
    ],
  );
});

const cronCreate = { hook_event_name: 'PostToolUse', tool_name: 'CronCreate', tool_input: { cron: '*/1 * * * *', prompt: 'Reply with exactly the word: tick', recurring: true }, tool_response: { id: '6308609e', humanSchedule: 'Every minute', recurring: true, durable: false, nextFireAt: 1794809531605.3975 } };
const cron = { id: '6308609e', schedule: '*/1 * * * *', recurring: true, prompt: 'Reply with exactly the word: tick' };

test('a scheduled prompt is listed with its next run; a run counts, and deleting it takes it off', () => {
  const tracker = new BackgroundTracker();
  assert.equal(tracker.onHook(cronCreate, 1794809486000), true);
  assert.deepEqual(tracker.schedules(), [{ ...cron, nextAt: 1794809531605, lastAt: null, runs: 0, since: 1794809486000 }]);
  assert.equal(tracker.onHook(stop([], [cron]), 1794809490000), false, 'Stop lists it without its next run: what is known stays');
  // It runs: the prompt is its own text, and nothing else says so.
  assert.equal(tracker.onHook(prompt('Reply with exactly the word: tick'), 1794809532000), true);
  assert.deepEqual([tracker.schedules()[0]?.runs, tracker.schedules()[0]?.lastAt, tracker.schedules()[0]?.nextAt], [1, 1794809532000, null], 'the time it was set for has passed');
  const listed = { hook_event_name: 'PostToolUse', tool_name: 'CronList', tool_input: {}, tool_response: { jobs: [{ id: '6308609e', cron: '*/1 * * * *', humanSchedule: 'Every minute', prompt: cron.prompt, recurring: true, durable: false, nextFireAt: 1794809591605.3975 }] } };
  assert.equal(tracker.onHook(listed, 1794809540000), true);
  assert.equal(tracker.schedules()[0]?.nextAt, 1794809591605, 'CronList says when it runs next');
  assert.equal(tracker.onHook({ hook_event_name: 'PostToolUse', tool_name: 'CronDelete', tool_input: { id: '6308609e' }, tool_response: { id: '6308609e' } }, 1794809550000), true);
  assert.deepEqual(tracker.schedules(), []);
});

test('a wakeup has no id until Stop lists it as a job that runs once; when it runs it is gone', () => {
  const tracker = new BackgroundTracker();
  const text = '/loop Reply with exactly the word: beat.';
  const wake = { hook_event_name: 'PostToolUse', tool_name: 'ScheduleWakeup', tool_input: { delaySeconds: 60, reason: 'shortest', prompt: text, noop: false }, tool_response: { scheduledFor: 1794809640000, clampedDelaySeconds: 60, wasClamped: false } };
  assert.equal(tracker.onHook(wake, 1000), false, 'nothing to list yet');
  const once = { id: '7ba0d780', schedule: '14 15 * * *', recurring: false, prompt: text };
  assert.equal(tracker.onHook(stop([], [once]), 2000), true);
  assert.deepEqual(tracker.schedules(), [{ ...once, nextAt: 1794809640000, lastAt: null, runs: 0, since: 2000 }]);
  assert.equal(tracker.onHook(prompt(text), 1794809640900), true);
  assert.deepEqual(tracker.schedules(), [], 'run once, it is no longer scheduled');
  assert.deepEqual(tracker.invoked(), ['loop'], 'and the prompt it ran is a slash command');
  // Set again in that turn, then stopped: Stop no longer lists it.
  tracker.onHook(wake, 1794809645000);
  tracker.onHook(stop([], [{ ...once, id: '70c1c2ca', schedule: '16 15 * * *' }]), 1794809648000);
  assert.equal(tracker.schedules()[0]?.id, '70c1c2ca');
  tracker.onHook({ hook_event_name: 'PostToolUse', tool_name: 'ScheduleWakeup', tool_input: { stop: true }, tool_response: { scheduledFor: 0, stopped: true, cancelledWakeups: 1 } }, 1794809650000);
  assert.equal(tracker.onHook(stop(), 1794809652000), true);
  assert.deepEqual(tracker.schedules(), []);
});

test('the listing of scheduled prompts wins over what was tracked, and the end of the session clears them', () => {
  const tracker = new BackgroundTracker();
  tracker.onHook(cronCreate, 1);
  tracker.onHook(stop([], [cron, { id: 'other', schedule: '0 9 * * *', recurring: true, prompt: 'morning check' }]), 2);
  assert.deepEqual(tracker.schedules().map((s) => [s.id, s.nextAt]), [['6308609e', 1794809531605], ['other', null]]);
  tracker.onHook(stop([], [{ id: 'other', schedule: '0 9 * * *', recurring: true, prompt: 'morning check' }]), 3);
  assert.deepEqual(tracker.schedules().map((s) => s.id), ['other'], 'one it no longer lists is gone');
  assert.equal(tracker.stopAll(4), true);
  assert.deepEqual(tracker.schedules(), []);
});

test('skills the model starts and slash commands the user types are remembered by name, once each', () => {
  const tracker = new BackgroundTracker();
  const skill = { hook_event_name: 'PostToolUse', tool_name: 'Skill', tool_input: { skill: 'ping-pong' }, tool_response: { success: true, commandName: 'ping-pong' } };
  assert.equal(tracker.onHook(skill, 1), true);
  assert.equal(tracker.onHook(skill, 2), false);
  assert.equal(tracker.onHook(prompt('/anthropic-skills:docx make a report'), 3), true);
  assert.equal(tracker.onHook(prompt('what does /loop do?'), 4), false, 'only a prompt that starts with one');
  assert.deepEqual(tracker.invoked(), ['ping-pong', 'anthropic-skills:docx']);
  assert.equal(slashName('/loop 1m check'), 'loop');
  assert.equal(slashName('/'), null);
  assert.equal(slashName('/../etc'), null);
});

test('ids that are not ids, and payloads of other shapes, change nothing', () => {
  const tracker = new BackgroundTracker();
  assert.equal(tracker.onHook(bash('../../etc/passwd'), 1), false);
  assert.equal(tracker.onHook({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'a', stderr: '', interrupted: false } }, 1), false, 'a command that ran in the foreground');
  assert.equal(tracker.onHook(stop([{ id: 'x y', type: 'shell', status: 'running' }, 'junk' as unknown as object, { id: 'done1', type: 'shell', status: 'completed' }], ['junk' as unknown as object, { id: 'c1', schedule: 7, prompt: 'p' }]), 1), false);
  assert.equal(tracker.onHook({ hook_event_name: 'Stop' }, 1), false, 'a Stop without the lists says nothing about them');
  assert.equal(tracker.onHook(prompt(''), 1), false);
  assert.deepEqual([tracker.list(), tracker.schedules(), tracker.invoked()], [[], [], []]);
});
