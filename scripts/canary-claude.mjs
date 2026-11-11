#!/usr/bin/env node
// Checks the built AgentHouse against the real Claude Code installed on this
// machine: a session starts, its hooks and status line report in, the screen
// renders, and it ends cleanly. Uses a throwaway state folder, so it never
// touches running sessions. Without --turn no prompt is sent (no usage).
//   pnpm build && pnpm canary:claude            start, observe, end
//   pnpm canary:claude -- --turn                also one short prompt (haiku, low effort)
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const main = path.join(root, 'apps/server/dist/main.js');
const WebSocket = createRequire(path.join(root, 'apps/server/package.json'))('ws');
const withTurn = process.argv.includes('--turn');
const home = mkdtempSync(path.join(os.tmpdir(), 'agenthouse-canary-'));
const env = { ...process.env, AGENTHOUSE_HOME: home };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const plain = (text) => text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?<=>]*[ -/]*[@-~]/g, ' ');
let failures = 0;
const check = (ok, label, detail = '') => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
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

try {
  const options = withTurn ? { vendor: 'claude', title: 'canary', model: 'haiku', effort: 'low', theme: 'dark' } : { vendor: 'claude', title: 'canary', theme: 'dark' };
  const created = await api('POST', '/api/sessions', options);
  check(created.status === 201, 'session starts', `HTTP ${created.status}`);
  const id = created.json.id;

  const ready = await waitFor(id, (s) => s.status.value === 'idle', 30_000);
  check(ready?.status.value === 'idle', 'hooks report in (idle after SessionStart)', ready?.status.value);
  const observed = await waitFor(id, (s) => s.telemetry.model !== null, 15_000);
  check(observed?.telemetry.model !== null, 'status line reports in', `model ${observed?.telemetry.model}`);

  const terminal = new WebSocket(`ws://127.0.0.1:${port}/ws/session?id=${id}`, { headers: { cookie: headers.cookie, origin } });
  let screen = '';
  terminal.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (message.type === 'snapshot') screen = message.data;
  });
  await sleep(1500);
  check(/Claude Code/.test(plain(screen)), 'the screen renders');
  terminal.close();

  if (withTurn) {
    let limits = [];
    const events = new WebSocket(`ws://127.0.0.1:${port}/ws/events`, { headers: { cookie: headers.cookie, origin } });
    events.on('message', (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.type === 'limits') limits = message.limits;
    });
    await api('POST', `/api/sessions/${id}/compose`, { text: 'Reply with exactly the word: pong' });
    const working = await waitFor(id, (s) => s.status.value === 'working', 15_000);
    check(working?.status.value === 'working', 'a prompt shows as working');
    const done = await waitFor(id, (s) => s.status.value === 'idle', 60_000);
    check(done?.status.value === 'idle', 'the turn ends as idle');
    await sleep(3000);
    // Only subscription logins report plan limits, so this is information, not a check.
    const claude = limits.find((l) => l.vendor === 'claude');
    console.log(`INFO  plan limits: ${claude ? `5h ${claude.fiveHour?.usedPct ?? '-'}%, 7d ${claude.sevenDay?.usedPct ?? '-'}%` : 'none reported'}`);
    events.close();
  }

  const ended = await api('DELETE', `/api/sessions/${id}`);
  check(ended.json?.exited === true && ended.json?.stillAlive === false, 'the session ends cleanly', JSON.stringify(ended.json));
} catch (error) {
  check(false, 'canary ran to the end', error.message);
} finally {
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
