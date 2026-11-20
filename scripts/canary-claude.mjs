#!/usr/bin/env node
// Checks the built AgentHouse against the real Claude Code installed on this
// machine: a session starts, its hooks and status line report in, the screen
// renders, and it ends cleanly. Uses a throwaway state folder, so it never
// touches running sessions. Without --turn, --resume, --scenario or --background no prompt is sent.
//   pnpm build && pnpm canary:claude              start, observe, end
//   pnpm canary:claude -- --turn                  also one short prompt (haiku, low effort)
//   pnpm canary:claude -- --resume                that prompt, then the session is ended and started
//       again where it stopped (`claude --resume`), and a second prompt asks for what the first got
//   pnpm canary:claude -- --scenario              short prompts (haiku, low effort): a reply,
//       a permission approved, a permission denied with Esc, a turn cut short with Esc, three
//       sub-agents (two in parallel, one nested), /clear, then work delegated to a second session
//       and its answer handed back; the status and agent tree after each, and the conversation
//       views read from the real transcripts.
//   pnpm canary:claude -- --background            short prompts (haiku, low effort): a shell command in
//       the background until its end is reported, a prompt scheduled with /loop until it has run once
//       and is deleted, the skills listed in the transcript, the scheduled prompt in the conversation.
//   pnpm canary:claude -- --external              no prompt: a second Claude Code, started directly in a
//       terminal of its own as the user would in another window, shows as a session started outside
//       AgentHouse (by its name, idle, read-only), AgentHouse's own session is not listed a second
//       time, and it is gone once it ends.
//       These run in a folder of their own in the temp folder; the first run tells Claude to trust it.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = path.join(root, 'apps/server/dist/main.js');
const serverRequire = createRequire(path.join(root, 'apps/server/package.json'));
const WebSocket = serverRequire('ws');
const { Terminal } = serverRequire('@xterm/headless');
const scenario = process.argv.includes('--scenario');
const withResume = !scenario && process.argv.includes('--resume');
const background = !scenario && !withResume && process.argv.includes('--background');
const external = !scenario && !withResume && !background && process.argv.includes('--external');
const withTurn = scenario || withResume || background || (!external && process.argv.includes('--turn'));
// The long form of the temp folder (Windows may give 8.3 names), as a user's folder would be.
const tmp = realpathSync.native(os.tmpdir());
const home = mkdtempSync(path.join(tmp, 'agenthouse-canary-'));
// One fixed folder for the scenario's files: Claude asks to trust a new folder
// once and remembers it, so reusing it keeps that list from growing.
const work = path.join(tmp, 'agenthouse-canary-work');
const env = { ...process.env, AGENTHOUSE_HOME: home };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
  return ok;
};

const server = spawn(process.execPath, [main, '--port', '0', '--json', '--cwd', root], { env, stdio: ['ignore', 'pipe', 'inherit'] });
const { port, key } = JSON.parse(await new Promise((resolve) => createInterface({ input: server.stdout }).once('line', resolve)));
const origin = `http://127.0.0.1:${port}`;
const headers = { authorization: `Bearer ${key}`, origin, 'content-type': 'application/json' };
const api = async (method, route, body) => {
  const res = await fetch(origin + route, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const sessionNow = async (id) => (await api('GET', '/api/sessions')).json.find((s) => s.id === id);
/** Polls a condition on what the events socket brought. */
const until = async (predicate, ms) => {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await sleep(300);
  return predicate();
};
let delegations = [];
const waitFor = async (id, predicate, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const session = await sessionNow(id);
    if (session && predicate(session)) return session;
    await sleep(300);
  }
  return sessionNow(id);
};
const describe = (s) => (s ? `${s.status.value}${s.status.reason ? ` · ${s.status.reason}` : ''}` : 'no session');
const socket = (route, onMessage) => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${route}`, { headers: { authorization: headers.authorization, origin } });
  let closing = false;
  ws.on('message', (raw) => onMessage(JSON.parse(raw.toString())));
  // A refused or broken socket is a failed check, not a crash that skips the cleanup.
  ws.on('error', (error) => closing || check(false, `socket ${route.split('?')[0]}`, error.message));
  return {
    ws,
    close: () => {
      closing = true;
      ws.close();
    },
  };
};

/** What the user sees and types: the session's terminal, drawn the way a terminal draws it. */
function terminal(id) {
  const screen = new Terminal({ cols: 120, rows: 32, allowProposedApi: true });
  const { ws, close } = socket(`/ws/session?id=${id}`, (message) => {
    if (message.type === 'snapshot') {
      screen.reset();
      screen.resize(message.cols, message.rows);
      screen.write(message.data);
    } else if (message.type === 'size') screen.resize(message.cols, message.rows);
    else if (message.type === 'output') screen.write(message.data);
  });
  return {
    /** The visible screen as text, once everything received so far is drawn. */
    text: () =>
      new Promise((resolve) =>
        screen.write('', () => {
          const buffer = screen.buffer.active;
          const lines = [];
          for (let row = 0; row < screen.rows; row += 1) lines.push(buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? '');
          resolve(lines.join('\n'));
        }),
      ),
    type: (data) => {
      const text = JSON.stringify({ type: 'input', data });
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
      else ws.once('open', () => ws.send(text));
    },
    close,
  };
}

/** The highlighted answer of a dialog on the screen (`❯ 1. Yes` → `Yes`), or null. */
const highlighted = (screen) =>
  screen
    .split('\n')
    .map((line) => line.match(/^\s*❯\s*(?:\d+\.\s*)?((?:Yes|No)\b.*?)\s*$/)?.[1])
    .filter(Boolean)
    .at(-1) ?? null;

async function untilScreen(term, predicate, ms) {
  const deadline = Date.now() + ms;
  let text = await term.text();
  while (!predicate(text) && Date.now() < deadline) {
    await sleep(200);
    text = await term.text();
  }
  return text;
}

/** The conversation view as a browser builds it from /ws/conversation: a session's, or a sub-agent's. */
function conversation(id, agentId = null) {
  const turns = new Map();
  const entries = new Map();
  let ready = false;
  const { close } = socket(`/ws/conversation?id=${id}${agentId ? `&agent=${agentId}` : ''}`, (message) => {
    if (message.type === 'reset') {
      turns.clear();
      entries.clear();
    }
    ready = true;
    for (const turn of message.turns) turns.set(turn.index, turn);
    for (const entry of message.entries) entries.set(entry.id, entry);
  });
  return { ready: () => ready, turns: () => [...turns.values()], entries: () => [...entries.values()], close };
}

/** Sends a prompt through the composer and waits for a status after it that `until` accepts. */
async function turn(id, label, text, until, ms = 60_000) {
  const before = (await sessionNow(id))?.status.at;
  const sent = await compose(id, text);
  if (sent.json?.submitted !== true) {
    check(false, label, `not sent: ${JSON.stringify(sent.json)}`);
    return null;
  }
  const session = await waitFor(id, (s) => s.status.at !== before && until(s), ms);
  return check(Boolean(session && session.status.at !== before && until(session)), label, describe(session)) ? session : null;
}
const compose = (id, text) => api('POST', `/api/sessions/${id}/compose`, { text });

/** A key typed in the terminal, then the status it leads to; no hook reports some of these. */
async function press(id, term, key, label, until, ms) {
  const before = (await sessionNow(id))?.status.at;
  term.type(key);
  const session = await waitFor(id, (s) => s.status.at !== before && until(s), ms);
  return check(Boolean(session && session.status.at !== before && until(session)), label, describe(session)) ? session : null;
}

/**
 * Claude asks whether to trust a folder it has not seen before, and runs
 * nothing (hooks included) until it is answered. Its highlighted answer is
 * "No, exit" (2.1.322), so the canary moves to "Yes" before pressing Enter.
 */
async function trustFolder(id, term) {
  const asked = (text) => /trust this folder/i.test(text);
  const deadline = Date.now() + 15_000;
  let screen = await term.text();
  while (!asked(screen) && Date.now() < deadline) {
    if ((await sessionNow(id))?.status.value !== 'starting') return; // trusted on an earlier run
    await sleep(300);
    screen = await term.text();
  }
  if (!asked(screen)) return; // the readiness check reports it
  for (let tries = 0; tries < 3; tries += 1) {
    if (/^Yes, I trust/.test(highlighted(screen) ?? '')) {
      console.log('INFO  telling Claude to trust the canary folder (asked once)');
      term.type('\r');
      return;
    }
    term.type('\x1b[B'); // the next answer
    screen = await untilScreen(term, (text) => /^Yes, I trust/.test(highlighted(text) ?? ''), 2000);
  }
  throw new Error(`the folder trust question has no "Yes" to pick (highlighted: ${highlighted(screen)})`);
}

async function runScenario(id, term) {
  const idle = (s) => s.status.value === 'idle';
  const asking = (s) => s.status.value === 'awaiting_permission';
  const dialog = () => untilScreen(term, (text) => highlighted(text) !== null, 5000);

  await turn(id, 'a reply: working, then idle', 'Reply with exactly the word: pong', idle);

  if (await turn(id, 'a tool that needs permission waits for approval', 'Use the Write tool to create a.txt containing the word hello. Do not use any other tool.', asking)) {
    const answer = highlighted(await dialog());
    if (!check(answer === 'Yes', 'the dialog highlights Yes', answer ?? 'no dialog on the screen')) throw new Error('not approving: Enter would not pick Yes');
    await press(id, term, '\r', 'approved in the terminal: the turn goes on and ends', idle, 60_000);
    check(existsSync(path.join(work, 'a.txt')), 'approved: a.txt written');
  }

  if (await turn(id, 'another permission request', 'Use the Write tool to create b.txt containing the word bye. Do not use any other tool.', asking)) {
    await dialog();
    await press(id, term, '\x1b', 'denied with Esc: idle, found without a hook', idle, 10_000);
    check(!existsSync(path.join(work, 'b.txt')), 'denied: b.txt not written');
  }

  if (await turn(id, 'a long reply is working', 'Count from 1 to 400, one number per line, nothing else.', (s) => s.status.value === 'working', 15_000)) {
    await sleep(1200);
    if ((await sessionNow(id))?.status.value !== 'working') console.log('INFO  the reply ended before Esc; nothing to cut short');
    else await press(id, term, '\x1b', 'Esc during a reply: idle, interrupted', (s) => idle(s) && s.status.reason === 'interrupted', 10_000);
  }

  const agents = await runAgents(id);

  const before = (await sessionNow(id))?.vendorSessionId;
  await turn(id, '/clear: a new conversation in a new transcript', '/clear', (s) => s.transcripts.length === 2 && s.vendorSessionId !== before && idle(s), 20_000);
  await runDelegation(id);
  return agents ?? [];
}

const HEADER = '[위임 결과 · canary-helper]';

/**
 * Work handed from this session to a second one delegated under it (haiku):
 * done once that one is idle, its answer found in its transcript, then
 * handed back to this session as a message.
 */
async function runDelegation(parentId) {
  const created = await api('POST', '/api/sessions', { vendor: 'claude', title: 'canary-helper', model: 'haiku', effort: 'low', permissionMode: 'manual', cwd: work, theme: 'dark' });
  if (!check(created.status === 201, 'delegation: a second session starts', `HTTP ${created.status}`)) return;
  const childId = created.json.id;
  try {
    const ready = await waitFor(childId, (s) => s.status.value === 'idle', 30_000);
    if (!check(ready?.status.value === 'idle', 'delegation: the second session reports in', describe(ready))) return;
    const linked = await api('PUT', `/api/sessions/${childId}/link`, { parentId, kind: 'delegate' });
    check(linked.status === 200, 'delegation: it is placed under the first, delegated', `HTTP ${linked.status}`);
    const sent = await api('POST', `/api/sessions/${parentId}/delegations`, { childId, text: 'Reply with exactly the word: gamma' });
    if (!check(sent.status === 201, 'delegation: the work is sent', `HTTP ${sent.status}`)) return;
    const task = () => delegations.find((d) => d.id === sent.json.id);
    await until(() => task()?.status !== undefined && task().status !== 'running', 90_000);
    check(task()?.status === 'done' && /gamma/i.test(task()?.summary ?? ''), 'delegation: done when the second session is idle, its answer found', `${task()?.status} · ${task()?.summary}`);
    const before = (await sessionNow(parentId))?.status.at;
    await api('POST', `/api/delegations/${sent.json.id}/deliver`, { header: HEADER });
    await until(() => task()?.delivery === 'sent', 30_000);
    check(task()?.delivery === 'sent', 'delegation: handed back to the first session', task()?.delivery);
    const answered = await waitFor(parentId, (s) => s.status.at !== before && s.status.value === 'idle' && Date.now() - s.status.at > 2000, 90_000);
    check(answered?.status.value === 'idle', 'delegation: the first session took it as a turn', describe(answered));

    // Review 2, M4-6: a delegate working through a background sub-agent. Between the agent's
    // SubagentStop and the turn its report starts, the delegate is idle with no agent running for a
    // moment; the result must be the answer after the report, not the one that started the agent.
    const withAgent = await api('POST', `/api/sessions/${parentId}/delegations`, {
      childId,
      text: 'Use the Agent tool once (subagent_type general-purpose, model haiku) to start one agent that replies with exactly the word delta, using no tools. When it has reported back, reply with exactly: final delta',
    });
    if (check(withAgent.status === 201, 'delegation with a sub-agent: the work is sent', `HTTP ${withAgent.status}`)) {
      const second = () => delegations.find((d) => d.id === withAgent.json.id);
      await until(() => second()?.status !== undefined && second().status !== 'running', 180_000);
      // The answer before the report may well say "final delta" too ("I'll reply final delta once…"): only the reply itself counts.
      check(second()?.status === 'done' && /^\W*final delta\W*$/i.test(second()?.summary ?? ''), 'delegation with a sub-agent: done after its report, with the last answer', `${second()?.status} · ${second()?.summary}`);
      const child = await sessionNow(childId);
      console.log(`INFO  the delegate after the work: ${describe(child)}, agents ${child?.agents.map((a) => a.state).join(',') || 'none'}`);
    }
  } finally {
    await api('DELETE', `/api/sessions/${childId}`);
  }
}

/**
 * Two sub-agents in parallel, the second starting a third (haiku). Claude runs
 * them in the background: the main turn ends at once, and each report starts
 * a turn of its own.
 */
async function runAgents(id) {
  const ask = [
    'Use the Agent tool twice in a single message so the two run in parallel, both with subagent_type general-purpose and model haiku.',
    'First agent: reply with exactly the word alpha, using no tools.',
    'Second agent: use the Agent tool yourself (subagent_type general-purpose, model haiku) to start one agent that replies with exactly the word beta; then reply with exactly what it said, using no other tools.',
    'When both have reported back, reply with the two words and nothing else.',
  ].join(' ');
  const before = (await sessionNow(id))?.status.at;
  const sent = await compose(id, ask);
  if (!check(sent.json?.submitted === true, 'sub-agents: the prompt is sent', JSON.stringify(sent.json))) return;
  // While they work, the main conversation may already be idle: their tool calls must not make it look busy.
  let quiet = false;
  const done = await waitFor(
    id,
    (s) => {
      if (s.status.value === 'idle' && s.agents.some((a) => a.state === 'running')) quiet = true;
      // Each report starts a turn: settled once idle for a few seconds with every agent stopped.
      return s.status.at !== before && s.status.value === 'idle' && Date.now() - s.status.at > 4000 && s.agents.length >= 3 && s.agents.every((a) => a.state === 'stopped');
    },
    180_000,
  );
  const agents = done?.agents ?? [];
  const top = agents.filter((a) => a.parentId === null);
  const nested = agents.filter((a) => a.parentId !== null && top.some((p) => p.id === a.parentId));
  check(agents.length === 3 && top.length === 2 && nested.length === 1, 'sub-agents: two in parallel, one nested under the second', agents.map((a) => `${a.agentType}:${a.parentId ? 'nested' : 'top'}:${a.state}`).join(' '));
  check(done?.status.value === 'idle', 'sub-agents: idle once all have reported', describe(done));
  check(agents.every((a) => a.transcriptPath && a.model), 'sub-agents: each has its transcript and model', agents.map((a) => `${a.model ?? '-'}/${a.tokens ?? '-'}`).join(' '));
  console.log(quiet ? 'INFO  the main conversation stayed idle while an agent worked' : 'INFO  no moment seen where the main conversation was idle while an agent worked');
  return agents;
}

/**
 * What a session leaves running and sets for later (haiku): a shell command in the background until
 * its end is reported, a prompt scheduled with /loop until it has run once and is deleted, the skills
 * its transcript lists, and the scheduled prompt in the conversation view.
 */
async function runBackground(id) {
  const idle = (s) => s.status.value === 'idle';
  // Each of these turns is followed by one nobody typed: settled once idle for a moment.
  const rested = (s) => idle(s) && Date.now() - s.status.at > 2000;
  const view = conversation(id);
  try {
    await turn(id, 'background: a command is started in the background and the turn ends', 'Run this exact command with the Bash tool, with run_in_background set to true: sleep 8; echo canary-done    Then reply with exactly: started', idle);
    let now = await waitFor(id, (s) => s.tasks.length === 1, 5000);
    const started = now?.tasks[0];
    check(started?.type === 'shell' && /sleep 8/.test(started.command ?? ''), 'background: it is listed under the session', JSON.stringify(now?.tasks));
    now = await waitFor(id, (s) => s.tasks.length === 1 && s.tasks[0].state !== 'running' && rested(s), 60_000);
    check(now?.tasks[0]?.state === 'done' && now.tasks[0].exitCode === 0, 'background: done once its end is reported, with its exit code', JSON.stringify(now?.tasks[0]));

    await turn(id, 'schedule: /loop 1m sets a prompt for every minute', '/loop 1m Reply with exactly the word: tick', idle);
    now = await waitFor(id, (s) => s.schedules.length === 1, 5000);
    const job = now?.schedules[0];
    check(job?.schedule === '*/1 * * * *' && job.recurring === true && job.nextAt > Date.now(), 'schedule: listed with its schedule and its next run', JSON.stringify(job));
    check(now?.invoked.includes('loop') === true, 'schedule: /loop is remembered as a command the session ran', JSON.stringify(now?.invoked));
    now = await waitFor(id, (s) => s.schedules[0]?.runs >= 1 && rested(s), 120_000);
    check(now?.schedules[0]?.runs >= 1 && now.schedules[0].lastAt !== null, 'schedule: its run is counted', JSON.stringify(now?.schedules[0]));
    await turn(id, 'schedule: a turn that deletes it', `Delete the scheduled job with CronDelete (its id is ${job?.id}), then reply with exactly: deleted`, idle);
    now = await waitFor(id, (s) => s.schedules.length === 0, 10_000);
    check(now?.schedules.length === 0, 'schedule: gone once deleted', JSON.stringify(now?.schedules));

    const skills = (await api('GET', `/api/sessions/${id}/skills`)).json?.skills ?? [];
    const sources = [...new Set(skills.map((skill) => skill.source))].join(', ');
    check(skills.some((skill) => skill.name === 'loop' && skill.used), 'skills: listed from the transcript, with /loop marked as used', `${skills.length} skills (${sources})`);

    await sleep(2000);
    const prompts = view.entries().filter((e) => e.kind === 'prompt');
    check(prompts.some((e) => e.scheduled === true && /tick/.test(e.text)), 'conversation: the scheduled prompt shows as what its turn answers', prompts.map((e) => `${e.scheduled ? 'scheduled:' : ''}${JSON.stringify(e.text.slice(0, 30))}`).join(' '));
  } finally {
    view.close();
  }
}

/**
 * An ended session started again: Claude goes on with the conversation under the id it had, in the
 * same transcript, and knows what was said before. The session's one reply so far is "pong".
 */
async function runResume(id) {
  const before = await sessionNow(id);
  const transcript = before?.transcripts.at(-1);
  const ended = await api('POST', `/api/sessions/${id}/end`);
  if (!check(ended.json?.exited === true && ended.json?.stillAlive === false, 'resume: the session ends first', JSON.stringify(ended.json))) return;
  const resumed = await api('POST', `/api/sessions/${id}/resume`, { theme: 'dark' });
  if (!check(resumed.status === 201 && resumed.json?.id === id, 'resume: the same session starts again', `HTTP ${resumed.status} ${resumed.json?.error ?? ''}`)) return;
  const term = terminal(id);
  let view = null;
  try {
    const ready = await waitFor(id, (s) => s.state === 'running' && s.status.value === 'idle' && s.transcripts.length > 0, 30_000);
    if (!check(ready?.state === 'running' && ready.status.value === 'idle', 'resume: hooks report in (idle after SessionStart)', describe(ready))) console.log(await term.text());
    const now = ready?.transcripts.at(-1);
    check(Boolean(transcript) && now?.path === transcript.path && now?.vendorSessionId === transcript.vendorSessionId, 'resume: under the id and in the transcript it had', `${now?.vendorSessionId} / ${transcript?.vendorSessionId}`);
    // Its conversation can be read again once its first hook has named the transcript.
    view = conversation(id);
    await turn(id, 'resume: a prompt in the conversation resumed', 'Which word did you reply with before? Reply with exactly that word.', (s) => s.status.value === 'idle');
    await sleep(2000);
    const replies = view.entries().filter((e) => e.kind === 'text');
    check(replies.length >= 2 && replies.every((e) => /pong/i.test(e.text)), 'resume: it knows what was said, and the view shows both turns', replies.map((e) => JSON.stringify(e.text.slice(0, 40))).join(' '));
  } finally {
    view?.close();
    term.close();
  }
}

// What an agent CLI sets for the programs it runs (apps/server/src/shared/child-env.ts): started with
// them, a Claude Code takes itself for the child of whichever session ran the canary.
const INHERITED = ['AI_AGENT', 'CLAUDECODE', 'CLAUDE_PID', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SSE_PORT'];

/**
 * A Claude Code started directly, in a terminal of its own, as the user would in another window:
 * AgentHouse did not start it and finds it in Claude's own list of sessions, asked for while a page
 * is open (the events socket stands for one). No prompt is sent.
 */
async function runExternal(id) {
  const pty = serverRequire('node-pty');
  const report = (await api('GET', '/api/env')).json;
  const install = report?.clis?.claude?.installs?.[report.clis.claude.selected];
  if (!check(Boolean(install), 'external: the Claude Code AgentHouse runs is known')) return;
  const childEnv = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  for (const name of INHERITED) delete childEnv[name];
  const name = `canary-outside-${process.pid}`;
  const screen = new Terminal({ cols: 120, rows: 32, allowProposedApi: true });
  const child = pty.spawn(install.file, [...install.args, '--name', name], { cwd: work, env: childEnv, cols: 120, rows: 32, name: 'xterm-256color' });
  let exited = false;
  child.onData((data) => screen.write(data));
  child.onExit(() => (exited = true));
  // A terminal answers what the CLI asks of it (its size, its colors); without answers the screen may not start.
  screen.onData((data) => child.write(data));
  const term = {
    text: () =>
      new Promise((resolve) =>
        screen.write('', () => {
          const lines = [];
          for (let row = 0; row < screen.rows; row += 1) lines.push(screen.buffer.active.getLine(screen.buffer.active.baseY + row)?.translateToString(true) ?? '');
          resolve(lines.join('\n'));
        }),
      ),
    type: (data) => child.write(data),
  };
  const outside = async () => ((await api('GET', '/api/sessions')).json ?? []).filter((s) => s.external);
  // Claude is asked every ten seconds: what it lists shows a little later than it happens.
  const eventually = async (found, ms) => {
    const deadline = Date.now() + ms;
    let result = found(await outside());
    while (!result && Date.now() < deadline) {
      await sleep(500);
      result = found(await outside());
    }
    return result;
  };
  try {
    // The folder was trusted for AgentHouse's own session a moment ago; asked again all the same, it is answered the same way.
    let text = await untilScreen(term, (now) => /trust this folder/i.test(now) || /Claude Code v/.test(now), 20_000);
    for (let tries = 0; /trust this folder/i.test(text) && tries < 3; tries += 1) {
      if (/^Yes, I trust/.test(highlighted(text) ?? '')) {
        term.type('\r');
        break;
      }
      term.type('\x1b[B');
      text = await untilScreen(term, (now) => /^Yes, I trust/.test(highlighted(now) ?? ''), 2000);
    }
    const found = await eventually((list) => list.find((s) => s.pid === child.pid), 40_000);
    if (!check(Boolean(found), 'external: a Claude Code started in a terminal of its own is listed', `pid ${child.pid}`)) {
      console.log(await term.text());
      return;
    }
    check(found.title === name && found.status.value === 'idle' && found.screen === false, 'external: by its name, idle, with no terminal here', `${found.title} · ${describe(found)}`);
    const own = await sessionNow(id);
    const listed = await outside();
    check(!listed.some((s) => s.pid === own.pid || s.vendorSessionId === own.vendorSessionId), "external: AgentHouse's own session is not listed a second time");
    // How many, not which: they are whatever the user has open.
    console.log(`INFO  external: ${listed.length - 1} other session(s) started outside AgentHouse are listed`);
    const refused = await api('POST', `/api/sessions/${found.id}/compose`, { text: 'hello' });
    check(refused.status === 409 && refused.json?.code === 'EXTERNAL_SESSION', 'external: it takes no message from here', `HTTP ${refused.status}`);
    term.type('\x03');
    await sleep(600);
    term.type('\x03');
    await until(() => exited, 10_000);
    check(exited, 'external: it ends in its own terminal (Ctrl+C twice)');
    const gone = await eventually((list) => !list.some((s) => s.pid === child.pid), 40_000);
    check(Boolean(gone), 'external: gone from the list once it ended');
  } finally {
    if (!exited) child.kill();
  }
}

let session = null;
try {
  // The scenario and the resumed conversation stay out of this repository's own Claude history.
  const apart = scenario || withResume || background || external;
  if (apart) {
    mkdirSync(work, { recursive: true, mode: 0o700 });
    // Claude is told to trust this folder and the scenario empties it, and on Linux the temp folder
    // is everyone's: a folder another account made there, or a link to some other folder, is not it.
    const made = lstatSync(work);
    const others = typeof process.getuid === 'function' && (made.uid !== process.getuid() || (made.mode & 0o022) !== 0);
    if (!made.isDirectory() || others) throw new Error(`${work} is not a folder of this user's alone: remove it and run again`);
  }
  if (scenario) for (const name of readdirSync(work)) rmSync(path.join(work, name), { recursive: true, force: true });
  const options = {
    vendor: 'claude',
    title: 'canary',
    theme: 'dark',
    // manual, not the user's default mode: in plan mode Claude answers with a larger model than haiku.
    ...(withTurn ? { model: 'haiku', effort: 'low', permissionMode: 'manual' } : {}),
    ...(apart ? { cwd: work } : {}),
  };
  const created = await api('POST', '/api/sessions', options);
  if (!check(created.status === 201, 'session starts', `HTTP ${created.status}`)) throw new Error(created.json?.error ?? 'not created');
  session = created.json.id;
  const id = session;
  const term = terminal(id);
  if (apart) await trustFolder(id, term);

  const ready = await waitFor(id, (s) => s.status.value === 'idle', 30_000);
  if (!check(ready?.status.value === 'idle', 'hooks report in (idle after SessionStart)', describe(ready))) console.log(await term.text());
  const observed = await waitFor(id, (s) => s.telemetry.model !== null, 15_000);
  check(observed?.telemetry.model !== null, 'status line reports in', `model ${observed?.telemetry.model}`);
  check(/Claude Code/.test(await untilScreen(term, (text) => /Claude Code/.test(text), 3000)), 'the screen renders');

  let limits = [];
  const events = socket('/ws/events', (message) => {
    if (message.type === 'limits') limits = message.limits;
    if (message.type === 'delegations') delegations = message.delegations;
  });

  if (scenario) {
    const named = await waitFor(id, (s) => s.transcripts.length > 0, 5000);
    if (!check(named?.transcripts.length > 0, 'SessionStart names the transcript')) throw new Error('no transcript to view');
    const view = conversation(id);
    const agents = await runScenario(id, term);
    await sleep(2000);
    check(view.ready(), 'conversation: the view receives a copy');
    const entries = view.entries();
    const tools = entries.filter((e) => e.kind === 'tool' && e.name === 'Write');
    const notices = (kind) => entries.filter((e) => e.kind === 'notice' && e.notice === kind).length;
    check(entries.some((e) => e.kind === 'text' && /pong/i.test(e.text)), 'conversation: the reply');
    check(tools.some((e) => e.state === 'done') && tools.some((e) => e.state === 'denied'), 'conversation: one Write approved, one denied', tools.map((e) => e.state).join(', '));
    check(notices('interrupted') >= 1, 'conversation: the cut-short turns are marked', `${notices('interrupted')}`);
    check(notices('cleared') === 1 && entries.some((e) => e.kind === 'command' && e.name === '/clear'), 'conversation: /clear starts the next part');
    const turns = view.turns();
    check(turns.some((t) => /haiku/.test(t.model ?? '') && t.usage.calls > 0 && t.usage.output > 0), 'conversation: turns have model and tokens', turns.map((t) => `${t.usage.calls}/${t.usage.output}`).join(' '));
    check(
      entries.some((e) => e.kind === 'prompt' && e.text.startsWith(HEADER) && /gamma/i.test(e.text)),
      "conversation: the delegate's answer came back as a message",
      entries.filter((e) => e.kind === 'prompt').map((e) => JSON.stringify(e.text.slice(0, 60))).at(-1),
    );
    const blocks = entries.filter((e) => e.kind === 'agent');
    const reports = entries.filter((e) => e.kind === 'task');
    check(blocks.length === 2 && blocks.every((e) => e.state === 'done') && reports.length >= 2, 'conversation: agent blocks done, their reports start turns', `${blocks.map((e) => e.state).join(',')} / ${reports.length} reports`);
    const parent = agents.find((a) => agents.some((c) => c.parentId === a.id));
    if (parent) {
      const own = conversation(id, parent.id);
      await sleep(2000);
      const mine = own.entries();
      check(mine.some((e) => e.kind === 'agent' && e.state === 'done') && mine.some((e) => e.kind === 'text' && /beta/i.test(e.text)), "conversation: a sub-agent's own, with the agent it started", mine.map((e) => e.kind).join(','));
      own.close();
    }
    const kinds = {};
    for (const e of entries) {
      const kind = e.kind === 'notice' ? `notice:${e.notice}` : e.kind;
      kinds[kind] = (kinds[kind] ?? 0) + 1;
    }
    console.log(`INFO  conversation: ${turns.length} turns, ${JSON.stringify(kinds)}`);
    view.close();
  } else if (background) {
    await runBackground(id);
  } else if (external) {
    await runExternal(id);
  } else if (withTurn) {
    await turn(id, 'a prompt: working, then idle', 'Reply with exactly the word: pong', (s) => s.status.value === 'idle');
  }
  if (withTurn) {
    await sleep(3000);
    // Only subscription logins report plan limits, so this is information, not a check.
    const claude = limits.find((l) => l.vendor === 'claude');
    console.log(`INFO  plan limits: ${claude ? `5h ${claude.fiveHour?.usedPct ?? '-'}%, 7d ${claude.sevenDay?.usedPct ?? '-'}%` : 'none reported'}`);
  }
  events.close();
  term.close();
  if (withResume) await runResume(id);

  const ended = await api('DELETE', `/api/sessions/${id}`);
  session = null;
  check(ended.json?.exited === true && ended.json?.stillAlive === false, 'the session ends cleanly', JSON.stringify(ended.json));
} catch (error) {
  check(false, 'canary ran to the end', error.message);
} finally {
  if (session) await api('DELETE', `/api/sessions/${session}`).catch(() => {});
  server.kill();
  try {
    execFileSync(process.execPath, [main, '--stop'], { env, stdio: 'ignore' });
  } catch {
    // the host may already be gone
  }
  rmSync(home, { recursive: true, force: true });
  console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
  process.exitCode = failures ? 1 : 0;
  setTimeout(() => process.exit(), 300);
}
