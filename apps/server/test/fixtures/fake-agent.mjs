#!/usr/bin/env node
// Stand-in for an agent CLI so the bridge can be tested without a login or network.
// At startup it asks the terminal for the cursor position and the background
// color (as real TUIs do), starts a grandchild process (like an MCP server), and
// then echoes every input chunk in escaped form.
//
// Launched like Claude Code (--session-id, --settings with AgentHouse's relay
// hooks), it also reports like it: hook events to the session host, and, only
// when CLAUDE_CONFIG_DIR is set (tests point it at a temporary folder), a
// transcript in Claude's format. An Enter on its own submits what was typed or
// pasted as a prompt; "tool" in it adds a tool call, "/clear" starts over.
// "agents" starts sub-agents the way Claude Code 2.1.322 does (two in the
// background, one of which starts a third, each reporting back), and
// "agentask" one whose tool waits for approval for a moment.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';

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
let sessionId = flag('--session-id') ?? randomUUID();
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
function write(record) {
  const file = transcript();
  if (!file) return;
  mkdirSync(path.dirname(file), { recursive: true });
  const uuid = randomUUID();
  appendFileSync(file, `${JSON.stringify({ parentUuid: parent, isSidechain: false, cwd: process.cwd(), sessionId, version: 'fake', uuid, timestamp: new Date().toISOString(), ...record })}\n`);
  parent = uuid;
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
  hook('Stop', { background_tasks: [] });
}

/** The sub-agent status line: what Claude passes it for each sub-agent. */
const tasks = (list, status) =>
  post('/subagents', {
    tasks: list.map((a, i) => ({ id: a.id, type: 'local_agent', agentType: a.type, status: status[i], description: a.description, label: a.description, startTime: a.startedAt, model: 'fake-small', contextWindowSize: 200000, tokenCount: 1000 + i, tokenSamples: [1000 + i] })),
  });

const running = (list) => list.map((a) => ({ id: a.id, type: 'subagent', status: 'running', description: a.description, agent_type: a.type }));

async function runAgents(prompt) {
  hook('UserPromptSubmit', { prompt });
  write({ type: 'user', message: { role: 'user', content: prompt }, origin: { kind: 'human' } });
  await pause(60);
  const explore = launch(null, 'Explore', 'Look around', 'explore report');
  const planner = launch(null, 'general-purpose', 'Plan the change', 'plan ready');
  reply({ type: 'text', text: 'Two agents are running.' });
  write({ type: 'system', subtype: 'turn_duration', durationMs: 90 });
  hook('Stop', { background_tasks: running([explore, planner]) });
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
  hook('Stop', { background_tasks: running([writer]) });
  await pause(200);
  const use = 'toolu_' + shortId();
  hook('PreToolUse', { tool_name: 'Write', tool_use_id: use, ...as(writer) });
  hook('PermissionRequest', { tool_name: 'Write', ...as(writer) });
  await pause(1500);
  hook('PostToolUse', { tool_name: 'Write', tool_use_id: use, ...as(writer) });
  await pause(100);
  finish(writer, null);
}

function submit(prompt) {
  if (prompt.includes('agentask')) return void runAgentAsks(prompt);
  if (prompt.includes('agents')) return void runAgents(prompt);
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
    hook('Stop');
  }, 100);
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');

const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });

out('fake-agent ready\r\n');
out(`REPORT child=${grandchild.pid}\r\n`);
out('\x1b[?2004h'); // ask for bracketed paste, like Claude Code and Codex do
hook('SessionStart', { source: 'startup' });

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
