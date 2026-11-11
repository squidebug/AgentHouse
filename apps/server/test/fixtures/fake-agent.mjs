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

function submit(prompt) {
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
  // A paste arrives in one piece (its line breaks included); the composer's Enter comes alone.
  if (rest === '\r') {
    const prompt = typed.replace(/\x1b\[20[01]~/g, '').trim();
    typed = '';
    if (prompt) submit(prompt);
  } else typed += rest;
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
