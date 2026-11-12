#!/usr/bin/env node
// Checks the built AgentHouse against the real Claude Code installed on this
// machine: a session starts, its hooks and status line report in, the screen
// renders, and it ends cleanly. Uses a throwaway state folder, so it never
// touches running sessions. Without --turn or --scenario no prompt is sent.
//   pnpm build && pnpm canary:claude              start, observe, end
//   pnpm canary:claude -- --turn                  also one short prompt (haiku, low effort)
//   pnpm canary:claude -- --scenario              five short prompts (haiku, low effort): a reply,
//       a permission approved, a permission denied with Esc, a turn cut short with Esc, three
//       sub-agents (two in parallel, one nested), then /clear; the status and agent tree after
//       each, and the conversation views read from the real transcripts.
//       Runs in a folder of its own in the temp folder; the first run tells Claude to trust it.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
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
const withTurn = scenario || process.argv.includes('--turn');
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
const { port, token } = JSON.parse(await new Promise((resolve) => createInterface({ input: server.stdout }).once('line', resolve)));
const origin = `http://127.0.0.1:${port}`;
const headers = { cookie: `ah_token=${token}`, origin, 'content-type': 'application/json' };
const api = async (method, route, body) => {
  const res = await fetch(origin + route, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, json: await res.json().catch(() => null) };
};
const sessionNow = async (id) => (await api('GET', '/api/sessions')).json.find((s) => s.id === id);
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
  const ws = new WebSocket(`ws://127.0.0.1:${port}${route}`, { headers: { cookie: headers.cookie, origin } });
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
  return agents ?? [];
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

let session = null;
try {
  if (scenario) {
    mkdirSync(work, { recursive: true });
    for (const name of readdirSync(work)) rmSync(path.join(work, name), { recursive: true, force: true });
  }
  const options = {
    vendor: 'claude',
    title: 'canary',
    theme: 'dark',
    // manual, not the user's default mode: in plan mode Claude answers with a larger model than haiku.
    ...(withTurn ? { model: 'haiku', effort: 'low', permissionMode: 'manual' } : {}),
    ...(scenario ? { cwd: work } : {}),
  };
  const created = await api('POST', '/api/sessions', options);
  if (!check(created.status === 201, 'session starts', `HTTP ${created.status}`)) throw new Error(created.json?.error ?? 'not created');
  session = created.json.id;
  const id = session;
  const term = terminal(id);
  if (scenario) await trustFolder(id, term);

  const ready = await waitFor(id, (s) => s.status.value === 'idle', 30_000);
  if (!check(ready?.status.value === 'idle', 'hooks report in (idle after SessionStart)', describe(ready))) console.log(await term.text());
  const observed = await waitFor(id, (s) => s.telemetry.model !== null, 15_000);
  check(observed?.telemetry.model !== null, 'status line reports in', `model ${observed?.telemetry.model}`);
  check(/Claude Code/.test(await untilScreen(term, (text) => /Claude Code/.test(text), 3000)), 'the screen renders');

  let limits = [];
  const events = socket('/ws/events', (message) => {
    if (message.type === 'limits') limits = message.limits;
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
