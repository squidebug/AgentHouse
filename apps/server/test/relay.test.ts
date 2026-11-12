import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { relayPath } from '../src/relay/path';

interface Received {
  path: string | undefined;
  auth: string | undefined;
  body: string;
}

const received: Received[] = [];
let server: http.Server;
let port: number;
let dir: string;

// What Claude Code runs commands with: Git Bash on Windows, sh elsewhere.
const shell = process.platform === 'win32' ? ['C:\\Program Files\\Git\\bin\\bash.exe'].find((p) => existsSync(p)) : '/bin/sh';

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'agenthouse-relay-'));
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      received.push({ path: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dir, { recursive: true, force: true });
});

let configs = 0;
async function runRelay(mode: 'hook' | 'status' | 'subagent', config: object, input: string, env: NodeJS.ProcessEnv = {}) {
  const configPath = path.join(dir, `relay-${(configs += 1)}.json`);
  await writeFile(configPath, JSON.stringify(config));
  const started = Date.now();
  return new Promise<{ code: number | null; stdout: string; ms: number }>((resolve) => {
    const child = spawn(process.execPath, [relayPath(), mode, configPath], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
    const out: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.on('close', (code) => resolve({ code, stdout: Buffer.concat(out).toString('utf8'), ms: Date.now() - started }));
    child.stdin.end(input);
  });
}

describe('hook relay', () => {
  test('a hook event goes to the host with the session token; nothing is printed', async () => {
    const event = JSON.stringify({ hook_event_name: 'Stop', session_id: 'abc' });
    const result = await runRelay('hook', { port, token: 'secret' }, event);
    assert.deepEqual([result.code, result.stdout], [0, ''], 'silent, exit 0: hook output could reach the model');
    const posted = received.find((r) => r.path === '/hook');
    assert.ok(posted);
    assert.equal(posted.auth, 'Bearer secret');
    assert.equal(posted.body, event);
  });

  test('the same command line works when Claude runs hooks in PowerShell (Windows without Git Bash)', { skip: process.platform !== 'win32' }, async () => {
    const configPath = path.join(dir, 'relay-powershell.json');
    await writeFile(configPath, JSON.stringify({ port, token: 'ps-secret' }));
    const command = `node "${relayPath().replace(/\\/g, '/')}" hook "${configPath.replace(/\\/g, '/')}"`;
    const powershell = `${process.env.SystemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const event = JSON.stringify({ hook_event_name: 'Stop', session_id: 'ps' });
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], { stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('close', resolve);
      child.stdin.end(event);
    });
    assert.equal(code, 0);
    assert.ok(received.some((r) => r.auth === 'Bearer ps-secret' && r.body === event), 'the event reached the host');
  });

  test('when the host is unreachable the relay still exits 0 at once', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const deadPort = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const result = await runRelay('hook', { port: deadPort, token: 'secret' }, '{}');
    assert.deepEqual([result.code, result.stdout], [0, '']);
    assert.ok(result.ms < 2500, `took ${result.ms} ms`);
  });

  test("as the status line it prints the user's own status line, unchanged", { skip: !shell }, async () => {
    const input = JSON.stringify({ model: { display_name: 'Haiku 5.5' } });
    const command = 'cat > /dev/null; printf "user-status \\342\\234\\223"';
    const result = await runRelay('status', { port, token: 'secret', statusCommand: command }, input, { SHELL: shell });
    assert.deepEqual([result.code, result.stdout], [0, 'user-status ✓']);
    assert.ok(received.some((r) => r.path === '/status' && r.body === input), 'the status line input also reaches the host');
  });

  test('without a status line of the user it prints nothing', async () => {
    const result = await runRelay('status', { port, token: 'secret' }, '{}');
    assert.deepEqual([result.code, result.stdout], [0, '']);
  });

  test("as the sub-agent status line it passes the tasks on and prints the user's own, or nothing", { skip: !shell }, async () => {
    const input = JSON.stringify({ tasks: [{ id: 'a1', type: 'local_agent', agentType: 'Explore', status: 'running', tokenCount: 12 }] });
    const quiet = await runRelay('subagent', { port, token: 'secret', statusCommand: 'echo not-this-one' }, input, { SHELL: shell });
    assert.deepEqual([quiet.code, quiet.stdout], [0, ''], "nothing printed: Claude keeps its own rows");
    assert.ok(received.some((r) => r.path === '/subagents' && r.body === input), 'the tasks reach the host');
    const rows = await runRelay('subagent', { port, token: 'secret', subagentCommand: `cat > /dev/null; printf '{"id":"a1","content":"mine"}'` }, input, { SHELL: shell });
    assert.deepEqual([rows.code, rows.stdout], [0, '{"id":"a1","content":"mine"}']);
  });
});
