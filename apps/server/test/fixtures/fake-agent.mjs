#!/usr/bin/env node
// Stand-in for an agent CLI so the bridge can be tested without a login or network.
// At startup it asks the terminal for the cursor position and the background
// color (as real TUIs do), starts a grandchild process (like an MCP server), and
// then echoes every input chunk in escaped form.
//
// Launched like Claude Code (--session-id, --settings with AgentHouse's relay
// hooks), it also reports like it: hook events to the session host, and, only
// when CLAUDE_CONFIG_DIR is set (tests point it at a temporary folder), a
// transcript in Claude's format. With --resume <id> it goes on with that
// conversation: the same id, the same transcript. An Enter on its own submits
// what was typed or pasted as a prompt; "tool" in it adds a tool call, "/clear"
// starts over.
// "agents" starts sub-agents the way Claude Code 2.1.322 does (two in the
// background, one of which starts a third, each reporting back), and
// "agentask" one whose tool waits for approval for a moment. "approval" makes
// the main conversation's own tool wait for approval until a key is pressed.
// "background" runs a shell command in the background, "monitor" a Monitor
// that reads two lines (either ends by itself unless the prompt says "keep"),
// "schedule" sets a prompt for every minute (with "run" it runs once), and
// "skill" starts one; the transcript lists three skills.
//
// Run as `agents --json` it stands in for Claude Code's list of its sessions
// instead: what a test or the UI check wrote to agents.json in CLAUDE_CONFIG_DIR
// (the entries, as Claude prints them), else none.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

if (process.argv[2] === 'agents') {
  let listed = '[]';
  try {
    if (process.env.CLAUDE_CONFIG_DIR) listed = readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'agents.json'), 'utf8');
  } catch {
    // nobody made any up
  }
  process.stdout.write(listed);
  process.exit(0);
}

const out = (text) => process.stdout.write(text);
const flag = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};

let relay = null;
try {
  relay = JSON.parse(readFileSync(path.join(path.dirname(flag('--settings')), 'relay.json'), 'utf8'));
} catch {
  // not launched with AgentHouse's hooks
}
const resumed = flag('--resume');
let sessionId = resumed ?? flag('--session-id') ?? randomUUID();
const projects = process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^A-Za-z0-9]/g, '-')) : null;
const transcript = () => (projects ? path.join(projects, `${sessionId}.jsonl`) : null);

// One at a time, in order: real hooks fire at moments far enough apart to arrive in order.
let sent = Promise.resolve();
function post(route, body) {
  if (!relay) return sent;
  const data = Buffer.from(JSON.stringify(body));
  sent = sent.then(
    () =>
      new Promise((resolve) => {
        const req = http.request(
          { host: '127.0.0.1', port: relay.port, path: route, method: 'POST', headers: { authorization: `Bearer ${relay.token}`, 'content-type': 'application/json', 'content-length': data.length } },
          (res) => res.resume().on('end', resolve),
        );
        req.on('error', resolve);
        req.end(data);
      }),
  );
  return sent;
}
const hook = (name, extra = {}) => post('/hook', { hook_event_name: name, session_id: sessionId, cwd: process.cwd(), ...(transcript() ? { transcript_path: transcript() } : {}), ...extra });

let parent = null;
if (resumed && transcript()) {
  // The next record follows the last one of the conversation it goes on with.
  try {
    parent = JSON.parse(readFileSync(transcript(), 'utf8').trimEnd().split('\n').at(-1)).uuid ?? null;
  } catch {
    // nothing written before: Claude Code would refuse to resume it; the double just starts it
  }
}
// The skills a conversation is given, as Claude Code lists them near the start of its transcript.
const SKILLS = [
  ['ping-pong', 'Replies with the word pong.'],
  ['loop', 'Run a prompt on a recurring interval.'],
  ['fake-plugin:review', 'Review the current diff.'],
];
function write(record) {
  const file = transcript();
  if (!file) return;
  mkdirSync(path.dirname(file), { recursive: true });
  const fresh = !existsSync(file);
  const uuid = randomUUID();
  const line = (fields) => `${JSON.stringify({ parentUuid: parent, isSidechain: false, cwd: process.cwd(), sessionId, version: 'fake', timestamp: new Date().toISOString(), ...fields })}\n`;
  appendFileSync(file, line({ uuid, ...record }));
  parent = uuid;
  if (fresh) {
    const attachment = { type: 'skill_listing', content: SKILLS.map(([name, about]) => `- ${name}: ${about}`).join('\n'), skillCount: SKILLS.length, isInitial: true, names: SKILLS.map(([name]) => name) };
    appendFileSync(file, line({ uuid: randomUUID(), type: 'attachment', attachment }));
  }
}
const usage = { input_tokens: 3, cache_read_input_tokens: 1200, cache_creation_input_tokens: 40, output_tokens: 25 };
const reply = (content, id = `msg_${randomUUID()}`) =>
  write({ type: 'assistant', effort: 'low', message: { id, model: 'fake-model', role: 'assistant', type: 'message', content: [content], usage } });

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shortId = () => randomUUID().replace(/-/g, '').slice(0, 16);
const agentFile = (id) => (projects ? path.join(projects, sessionId, 'subagents', `agent-${id}.jsonl`) : null);
const agentParents = new Map();
/** Writes a record to a sub-agent's own transcript, or the session's for null. */
function writeTo(agent, record) {
  if (!agent) return write(record);
  const file = agentFile(agent.id);
  if (!file) return;
  mkdirSync(path.dirname(file), { recursive: true });
  const uuid = randomUUID();
  const line = { parentUuid: agentParents.get(agent.id) ?? null, isSidechain: true, agentId: agent.id, cwd: process.cwd(), sessionId, version: 'fake', uuid, timestamp: new Date().toISOString(), ...record };
  appendFileSync(file, JSON.stringify(line) + '\n');
  agentParents.set(agent.id, uuid);
}
const replyIn = (agent, content) =>
  writeTo(agent, { type: 'assistant', effort: 'low', message: { id: 'msg_' + randomUUID(), model: 'fake-small', role: 'assistant', type: 'message', content: [content], usage } });
const as = (agent) => (agent ? { agent_id: agent.id, agent_type: agent.type } : {});

/** The Agent tool, called by the main conversation (null) or by a sub-agent: it starts one in the background. */
function launch(caller, type, description, report) {
  const agent = { id: 'a' + shortId(), type, description, report, toolUseId: 'toolu_' + shortId(), startedAt: Date.now() };
  const input = { description, prompt: description + ', briefly.', subagent_type: type };
  hook('PreToolUse', { tool_name: 'Agent', tool_use_id: agent.toolUseId, tool_input: input, ...as(caller) });
  replyIn(caller, { type: 'tool_use', id: agent.toolUseId, name: 'Agent', input });
  hook('SubagentStart', { agent_id: agent.id, agent_type: type });
  const response = { isAsync: true, status: 'async_launched', agentId: agent.id, description, resolvedModel: 'fake-small', prompt: input.prompt };
  hook('PostToolUse', { tool_name: 'Agent', tool_use_id: agent.toolUseId, tool_input: input, tool_response: response, ...as(caller) });
  const launched = [{ type: 'tool_result', tool_use_id: agent.toolUseId, content: [{ type: 'text', text: 'Async agent launched successfully.' }] }];
  writeTo(caller, { type: 'user', message: { role: 'user', content: launched }, toolUseResult: response });
  writeTo(agent, { type: 'user', message: { role: 'user', content: input.prompt } });
  return agent;
}

const notification = (agent) =>
  [
    '<task-notification>',
    '<task-id>' + agent.id + '</task-id>',
    '<tool-use-id>' + agent.toolUseId + '</tool-use-id>',
    '<status>completed</status>',
    '<summary>Agent "' + agent.description + '" finished</summary>',
    '<result>' + agent.report + '</result>',
    '<usage><subagent_tokens>1234</subagent_tokens><tool_uses>1</tool_uses><duration_ms>420</duration_ms></usage>',
    '</task-notification>',
  ].join('\n');

/** The agent ends its turn with its report, which its caller gets as a task notification. */
function finish(agent, caller) {
  replyIn(agent, { type: 'text', text: agent.report });
  hook('SubagentStop', { agent_id: agent.id, agent_type: agent.type, agent_transcript_path: agentFile(agent.id), last_assistant_message: agent.report });
  const origin = { kind: 'task-notification', producer: 'session-task' };
  if (caller) {
    writeTo(caller, { type: 'user', isMeta: true, origin, message: { role: 'user', content: '[SYSTEM NOTIFICATION - NOT USER INPUT]\n\n' + notification(agent) } });
    return;
  }
  const text = notification(agent);
  hook('UserPromptSubmit', { prompt: text });
  write({ type: 'user', message: { role: 'user', content: text }, origin });
  reply({ type: 'text', text: agent.description + ': ' + agent.report });
  write({ type: 'system', subtype: 'turn_duration', durationMs: 60 });
  stop();
}

/** The sub-agent status line: what Claude passes it for each sub-agent. */
const tasks = (list, status) =>
  post('/subagents', {
    tasks: list.map((a, i) => ({ id: a.id, type: 'local_agent', agentType: a.type, status: status[i], description: a.description, label: a.description, startTime: a.startedAt, model: 'fake-small', contextWindowSize: 200000, tokenCount: 1000 + i, tokenSamples: [1000 + i] })),
  });

const running = (list) => list.map((a) => ({ id: a.id, type: 'subagent', status: 'running', description: a.description, agent_type: a.type }));

// What runs in the background and what is scheduled: every Stop lists both, as Claude Code's does.
const shells = new Map();
const crons = new Map();
const stop = (agents = []) => hook('Stop', { background_tasks: [...running(agents), ...shells.values()], session_crons: [...crons.values()] });
const endTurn = (answer, agents) => {
  reply({ type: 'text', text: answer });
  write({ type: 'system', subtype: 'turn_duration', durationMs: 120 });
  stop(agents);
};
const asked = (prompt) => {
  hook('UserPromptSubmit', { prompt });
  write({ type: 'user', message: { role: 'user', content: prompt }, origin: { kind: 'human' } });
};
/** A tool call that needs no approval: its hooks and its records. */
function call(name, input, response, result) {
  const use = 'toolu_' + shortId();
  hook('PreToolUse', { tool_name: name, tool_use_id: use, tool_input: input });
  reply({ type: 'tool_use', id: use, name, input });
  write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: use, content: result }] }, toolUseResult: response });
  hook('PostToolUse', { tool_name: name, tool_use_id: use, tool_input: input, tool_response: response });
  return use;
}
/** What a background task tells the session: a turn of its own, started by the notification. */
function notify(lines, answer) {
  const text = ['<task-notification>', ...lines, '</task-notification>'].join('\n');
  hook('UserPromptSubmit', { prompt: text });
  write({ type: 'user', message: { role: 'user', content: text }, origin: { kind: 'task-notification', producer: 'session-task' } });
  endTurn(answer);
}

/** A shell command in the background: the turn ends at once; its end starts a turn. With "keep" it runs on. */
async function runBackground(prompt) {
  asked(prompt);
  await pause(60);
  const task = 'b' + shortId().slice(0, 8);
  const input = prompt.includes('tests')
    ? { command: 'pnpm test', description: 'Run the tests', run_in_background: true }
    : { command: 'sleep 20; echo done', description: 'Wait for the build', run_in_background: true };
  const use = call('Bash', input, { stdout: '', stderr: '', interrupted: false, backgroundTaskId: task }, `Command running in background with ID: ${task}.`);
  shells.set(task, { id: task, type: 'shell', status: 'running', description: input.description, command: input.command });
  endTurn('started');
  if (prompt.includes('keep')) return;
  await pause(700);
  shells.delete(task);
  const failed = prompt.includes('fail');
  notify(
    [`<task-id>${task}</task-id>`, `<tool-use-id>${use}</tool-use-id>`, `<status>${failed ? 'failed' : 'completed'}</status>`, `<summary>Background command "${input.description}" ${failed ? 'failed with exit code 1' : 'completed (exit code 0)'}</summary>`],
    'The background command ended.',
  );
}

/** A Monitor: listed as a shell, and every line it reads starts a turn. With "keep" it runs on after two lines. */
async function runMonitor(prompt) {
  asked(prompt);
  await pause(60);
  const task = 'b' + shortId().slice(0, 8);
  const input = { description: 'deploy status', timeout_ms: 60000, command: 'tail -f deploy.log' };
  const use = call('Monitor', input, { taskId: task, timeoutMs: 60000, persistent: false }, `Monitor started (task ${task}).`);
  shells.set(task, { id: task, type: 'shell', status: 'running', description: input.description, command: input.command });
  endTurn('watching');
  for (const line of ['building', 'deployed 3 of 5']) {
    await pause(300);
    notify([`<task-id>${task}</task-id>`, `<summary>Monitor event: "${input.description}"</summary>`, `<event>${line}</event>`], 'ok');
  }
  if (prompt.includes('keep')) return;
  await pause(300);
  shells.delete(task);
  notify([`<task-id>${task}</task-id>`, `<tool-use-id>${use}</tool-use-id>`, '<status>completed</status>', `<summary>Monitor "${input.description}" stream ended</summary>`], 'ok');
}

/** A prompt scheduled for every minute (CronCreate, as /loop 1m does). With "run" it runs once, shortly after. */
async function runSchedule(prompt) {
  asked(prompt);
  await pause(60);
  const id = shortId().slice(0, 8);
  const input = { cron: '*/1 * * * *', prompt: 'check the deploy', recurring: true };
  call('CronCreate', input, { id, humanSchedule: 'Every minute', recurring: true, durable: false, nextFireAt: Date.now() + 45_000 }, `Scheduled recurring job ${id} (Every minute).`);
  crons.set(id, { id, schedule: input.cron, recurring: true, prompt: input.prompt });
  endTurn('scheduled');
  if (!prompt.includes('run')) return;
  await pause(500);
  // A scheduled prompt is the CLI's own record (isMeta), after a line that says so.
  hook('UserPromptSubmit', { prompt: input.prompt });
  write({ type: 'system', subtype: 'scheduled_task_fire', content: 'Running scheduled task', taskId: id, cron: input.cron });
  write({ type: 'user', isMeta: true, promptSource: 'system', scheduledTaskId: id, message: { role: 'user', content: input.prompt } });
  endTurn('the deploy is fine');
}

/** The model starts a skill by name. */
async function runSkill(prompt) {
  asked(prompt);
  await pause(60);
  call('Skill', { skill: 'ping-pong' }, { success: true, commandName: 'ping-pong' }, 'Launching skill: ping-pong');
  endTurn('pong');
}

async function runAgents(prompt) {
  hook('UserPromptSubmit', { prompt });
  write({ type: 'user', message: { role: 'user', content: prompt }, origin: { kind: 'human' } });
  await pause(60);
  const explore = launch(null, 'Explore', 'Look around', 'explore report');
  const planner = launch(null, 'general-purpose', 'Plan the change', 'plan ready');
  reply({ type: 'text', text: 'Two agents are running.' });
  write({ type: 'system', subtype: 'turn_duration', durationMs: 90 });
  stop([explore, planner]);
  tasks([explore, planner], ['running', 'running']);
  await pause(300);
  // While the main conversation waits, the explorer reads and the planner starts an agent of its own.
  const read = 'toolu_' + shortId();
  hook('PreToolUse', { tool_name: 'Read', tool_use_id: read, ...as(explore) });
  replyIn(explore, { type: 'tool_use', id: read, name: 'Read', input: { file_path: path.join(process.cwd(), 'README.md') } });
  writeTo(explore, { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: read, content: '# readme' }] }, toolUseResult: { type: 'text' } });
  hook('PostToolUse', { tool_name: 'Read', tool_use_id: read, ...as(explore) });
  const checker = launch(planner, 'Explore', 'Check the tests', 'tests pass');
  replyIn(planner, { type: 'text', text: 'Waiting for the check.' });
  hook('SubagentStop', { agent_id: planner.id, agent_type: planner.type, agent_transcript_path: agentFile(planner.id), last_assistant_message: 'Waiting for the check.' });
  tasks([explore, planner, checker], ['running', 'running', 'running']);
  await pause(300);
  finish(explore, null);
  await pause(300);
  finish(checker, planner);
  hook('SubagentStart', { agent_id: planner.id, agent_type: planner.type });
  await pause(150);
  finish(planner, null);
  tasks([explore, planner, checker], ['completed', 'completed', 'completed']);
}

async function runAgentAsks(prompt) {
  hook('UserPromptSubmit', { prompt });
  write({ type: 'user', message: { role: 'user', content: prompt }, origin: { kind: 'human' } });
  await pause(60);
  const writer = launch(null, 'general-purpose', 'Write a file', 'file written');
  reply({ type: 'text', text: 'The agent is on it.' });
  stop([writer]);
  await pause(200);
  const use = 'toolu_' + shortId();
  hook('PreToolUse', { tool_name: 'Write', tool_use_id: use, ...as(writer) });
  hook('PermissionRequest', { tool_name: 'Write', ...as(writer) });
  await pause(1500);
  hook('PostToolUse', { tool_name: 'Write', tool_use_id: use, ...as(writer) });
  await pause(100);
  finish(writer, null);
}

// The dialog that is up: whatever is typed next answers it.
let answered = null;

async function runAsks(prompt) {
  hook('UserPromptSubmit', { prompt });
  write({ type: 'user', message: { role: 'user', content: prompt }, origin: { kind: 'human' } });
  await pause(60);
  const use = 'toolu_' + shortId();
  const input = { file_path: path.join(process.cwd(), 'notes.txt'), content: 'fake notes' };
  hook('PreToolUse', { tool_name: 'Write', tool_use_id: use });
  reply({ type: 'tool_use', id: use, name: 'Write', input });
  hook('PermissionRequest', { tool_name: 'Write' });
  await new Promise((resolve) => {
    answered = resolve;
  });
  write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: use, content: 'File created', is_error: false }] }, toolUseResult: { type: 'create', filePath: input.file_path, content: input.content } });
  hook('PostToolUse', { tool_name: 'Write', tool_use_id: use });
  reply({ type: 'text', text: `fake answer: ${prompt}` });
  write({ type: 'system', subtype: 'turn_duration', durationMs: 120 });
  stop();
}

function submit(prompt) {
  if (prompt.includes('agentask')) return void runAgentAsks(prompt);
  if (prompt.includes('agents')) return void runAgents(prompt);
  if (prompt.includes('approval')) return void runAsks(prompt);
  if (prompt.includes('background')) return void runBackground(prompt);
  if (prompt.includes('monitor')) return void runMonitor(prompt);
  if (prompt.includes('schedule')) return void runSchedule(prompt);
  if (prompt.includes('skill')) return void runSkill(prompt);
  if (prompt === '/clear') {
    hook('SessionEnd', { reason: 'clear' });
    sessionId = randomUUID();
    parent = null;
    write({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>' } });
    hook('SessionStart', { source: 'clear' });
    return;
  }
  hook('UserPromptSubmit', { prompt });
  write({ type: 'user', message: { role: 'user', content: prompt }, origin: { kind: 'human' } });
  setTimeout(() => {
    if (prompt.includes('tool')) {
      const id = `toolu_${randomUUID().slice(0, 8)}`;
      hook('PreToolUse', { tool_name: 'Bash', tool_use_id: id });
      reply({ type: 'tool_use', id, name: 'Bash', input: { command: 'echo fake-tool-output', description: 'Print a line' } });
      write({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'fake-tool-output', is_error: false }] }, toolUseResult: { stdout: 'fake-tool-output', stderr: '', interrupted: false } });
      hook('PostToolUse', { tool_name: 'Bash', tool_use_id: id });
    }
    reply({ type: 'text', text: `fake answer: ${prompt}` });
    write({ type: 'system', subtype: 'turn_duration', durationMs: 120 });
    post('/status', { model: { id: 'fake-model', display_name: 'Fake' }, effort: { level: 'low' }, context_window: { used_percentage: 3, context_window_size: 200000 } });
    stop();
  }, 100);
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');

const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });

out('fake-agent ready\r\n');
out(`REPORT child=${grandchild.pid}\r\n`);
if (resumed) out(`REPORT resumed=${resumed}\r\n`);
out('\x1b[?2004h'); // ask for bracketed paste, like Claude Code and Codex do
hook('SessionStart', { source: resumed ? 'resume' : 'startup' });

const waiting = { cpr: true, osc11: true };
out('\x1b[6n');
out('\x1b]11;?\x1b\\');
setTimeout(() => {
  if (waiting.cpr) out('REPORT cpr=timeout\r\n');
  if (waiting.osc11) out('REPORT osc11=timeout\r\n');
  waiting.cpr = false;
  waiting.osc11 = false;
}, 1500);

let typed = '';
process.stdin.on('data', (chunk) => {
  let rest = chunk;
  // Only the first reply to each startup query counts; any later one is echoed
  // as input, which is how a leaked duplicate reply would show up.
  rest = rest.replace(/\x1b\[(\d+);(\d+)R/, (whole, row, col) => {
    if (!waiting.cpr) return whole;
    waiting.cpr = false;
    out(`REPORT cpr=${row};${col}\r\n`);
    return '';
  });
  rest = rest.replace(/\x1b\]11;(rgb:[0-9a-fA-F/]+)(?:\x07|\x1b\\)/, (whole, rgb) => {
    if (!waiting.osc11) return whole;
    waiting.osc11 = false;
    out(`REPORT osc11=${rgb}\r\n`);
    return '';
  });
  if (!rest) return;
  out(`IN ${JSON.stringify(rest)}\r\n`);
  if (answered) {
    // A dialog takes the keys: they answer it, and are no prompt.
    const go = answered;
    answered = null;
    go();
  } else {
    // Enter is a \r outside a paste: a pasted line break arrives as \r too. A long paste may reach us
    // in pieces, its end marker split between two reads, and the Enter after it in the same read.
    typed += rest;
    const pasting = typed.lastIndexOf('\x1b[200~') > typed.lastIndexOf('\x1b[201~');
    if (!pasting && typed.endsWith('\r')) {
      // Claude Code keeps a pasted line break as \n.
      const prompt = typed.slice(0, -1).replace(/\x1b\[20[01]~/g, '').replace(/\r/g, '\n').trim();
      typed = '';
      if (prompt) submit(prompt);
    }
  }
  // A burst far larger than any viewer may fall behind by.
  if (rest.includes('flood')) {
    const line = `${'x'.repeat(150)}\r\n`;
    for (let i = 0; i < 40_000; i += 1) out(line);
    out('flood done\r\n');
  }
  // Stands in for a turn in progress: output keeps coming for two seconds.
  if (rest.includes('stream')) {
    let tick = 0;
    const timer = setInterval(() => {
      tick += 1;
      out(`tick ${tick}\r\n`);
      if (tick === 40) {
        clearInterval(timer);
        out('stream done\r\n');
      }
    }, 50);
  }
  if (rest.includes('exit') || rest.includes('\x03')) {
    grandchild.kill();
    out('bye\r\n');
    process.exit(0);
  }
});
