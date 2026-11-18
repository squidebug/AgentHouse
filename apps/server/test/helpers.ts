import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { HostClient } from '../src/web/host-client';
import { createSessionHost, type SessionHost } from '../src/host/server';
import { childEnv } from '../src/shared/child-env';
import type { SpawnSpec } from '../src/shared/host-protocol';
import { createAgentHouseServer, type AgentHouseServer } from '../src/web/http/server';

export const fakeAgentPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-agent.mjs');

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The fake agent as the session host would start it; `extra` turns it into whatever a test needs. */
export function fakeSpec(extra: Partial<SpawnSpec> = {}): SpawnSpec {
  return {
    id: randomUUID(),
    vendor: 'fake',
    title: 'fake',
    file: process.execPath,
    args: [fakeAgentPath],
    cwd: os.tmpdir(),
    env: childEnv(),
    cols: 100,
    rows: 30,
    theme: 'dark',
    model: null,
    effort: null,
    permissionMode: null,
    cliVersion: null,
    vendorSessionId: null,
    tempPaths: [],
    hookToken: null,
    agentsCommand: null,
    ...extra,
  };
}

/** A state folder of the test's own, so tests never touch ~/.agenthouse or each other. */
export function tempStateDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'agenthouse-test-'));
}

/**
 * What every web server of a test is made with: the CLIs the developer has installed are not run.
 * They are looked for nowhere, so the environment check finds none to ask for its version and login
 * (asked with the config folder a test gave, Claude Code would write its own files there), and
 * Claude Code's list of sessions is not asked for (it would list the sessions the developer has open).
 */
export const noRealCli = { cliPath: '', claudeSessions: null } as const;

export interface TestServer extends AgentHouseServer {
  stateDir: string;
  host: SessionHost;
}

/**
 * A web server and a session host of its own, both in this process. close() ends both.
 * `claudeSessions` stands in for Claude Code's own list of sessions, and `cliPath` names the folders
 * a stand-in CLI is in; without them nothing is asked and no CLI is found (`noRealCli`).
 */
export async function startServer(options: { claudeSessions?: () => Promise<unknown>; cliPath?: string } = {}): Promise<TestServer> {
  const stateDir = await tempStateDir();
  const host = await createSessionHost({ stateDir, idleExitMs: null });
  const client = await HostClient.connect({ stateDir, spawn: false });
  const app = await createAgentHouseServer({ port: 0, fakeAgentPath, host: client, ...noRealCli, ...options });
  return {
    ...app,
    stateDir,
    host,
    async close() {
      await app.close();
      client.close();
      await host.close();
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}

export interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: unknown;
  /** It went over a connection that an earlier request of its `agent` had opened. */
  reused: boolean;
}

/** A request, over a connection of its own unless an `agent` keeps some open for the requests given it. */
export function request(
  port: number,
  method: string,
  pathname: string,
  { headers = {}, body, agent }: { headers?: Record<string, string>; body?: unknown; agent?: http.Agent } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: { host: `127.0.0.1:${port}`, ...headers }, ...(agent ? { agent } : {}) }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json, reused: req.reusedSocket });
      });
    });
    req.on('error', reject);
    if (body === undefined) req.end();
    else {
      req.setHeader('content-type', 'application/json');
      req.end(JSON.stringify(body));
    }
  });
}

export interface Socket {
  ws: WebSocket | null;
  status: number;
  messages: Array<{ type: string; [key: string]: unknown }>;
}

/** A WebSocket as a tool opens it (headers), or as a page does: `protocols` carry its token. */
export function openSocket(port: number, pathname: string, headers: Record<string, string>, protocols: string[] = []): Promise<Socket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}`, protocols, { headers });
    const messages: Socket['messages'] = [];
    ws.on('message', (raw) => messages.push(JSON.parse(raw.toString())));
    ws.on('open', () => resolve({ ws, status: 101, messages }));
    ws.on('unexpected-response', (_req, res) => resolve({ ws: null, status: res.statusCode ?? 0, messages }));
    ws.on('error', () => resolve({ ws: null, status: 0, messages }));
  });
}

export async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  return predicate();
}

/** Reads until the value is what the test waits for, or the time is up; returns the last value read. */
export async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await sleep(100);
    value = await read();
  }
  return value;
}

/** Terminal text without escape sequences (ConPTY re-renders the CLI's screen). */
export function plain(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?<=>]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][0-9A-B]/g, '');
}

export function screenText(messages: Socket['messages']): string {
  return messages
    .filter((m) => m.type === 'snapshot' || m.type === 'output')
    .map((m) => String(m.data))
    .join('');
}

/** Logs in as a page does, with the one-time code of an address the server gives out; the Authorization value. */
export async function login(app: { port: number; loginUrl(): string }): Promise<string> {
  const code = new URL(app.loginUrl()).searchParams.get('code');
  const res = await request(app.port, 'POST', '/api/login', { headers: { origin: `http://127.0.0.1:${app.port}` }, body: { code } });
  const token = (res.json as { token?: unknown } | null)?.token;
  if (typeof token !== 'string') throw new Error(`login failed: ${res.status}`);
  return `Bearer ${token}`;
}

/**
 * A stand-in Claude Code installed in `bin` the way npm does (a .cmd shim to a
 * script on Windows, an executable elsewhere). It answers `--version` and
 * `auth status --json` as the real one does; returns the file to run.
 */
export function installFakeClaude(bin: string, version = '9.9.9'): string {
  const source = [
    '#!/usr/bin/env node',
    "const args = process.argv.slice(2).join(' ');",
    `if (args === '--version') console.log('${version} (Claude Code)');`,
    "else if (args === 'auth status --json') console.log(JSON.stringify({ loggedIn: true }));",
    '',
  ].join('\n');
  mkdirSync(bin, { recursive: true });
  if (process.platform === 'win32') {
    const script = path.join(bin, 'node_modules', 'fake-claude', 'cli.js');
    mkdirSync(path.dirname(script), { recursive: true });
    writeFileSync(script, source);
    const shim = path.join(bin, 'claude.cmd');
    writeFileSync(shim, '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\fake-claude\\cli.js" %*\r\n');
    return shim;
  }
  const file = path.join(bin, 'claude');
  writeFileSync(file, source);
  chmodSync(file, 0o755);
  return file;
}
