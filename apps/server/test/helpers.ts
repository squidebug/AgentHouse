import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { HostClient } from '../src/web/host-client';
import { createSessionHost, type SessionHost } from '../src/host/server';
import { createAgentHouseServer, type AgentHouseServer } from '../src/web/http/server';

export const fakeAgentPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-agent.mjs');

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A state folder of the test's own, so tests never touch ~/.agenthouse or each other. */
export function tempStateDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), 'agenthouse-test-'));
}

export interface TestServer extends AgentHouseServer {
  stateDir: string;
  host: SessionHost;
}

/** A web server and a session host of its own, both in this process. close() ends both. */
export async function startServer(): Promise<TestServer> {
  const stateDir = await tempStateDir();
  const host = await createSessionHost({ stateDir, idleExitMs: null });
  const client = await HostClient.connect({ stateDir, spawn: false });
  const app = await createAgentHouseServer({ port: 0, fakeAgentPath, host: client });
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
}

export function request(
  port: number,
  method: string,
  pathname: string,
  { headers = {}, body }: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
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
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json });
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

export function openSocket(port: number, pathname: string, headers: Record<string, string>): Promise<Socket> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${pathname}`, { headers });
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

export async function login(port: number, token: string): Promise<string> {
  const res = await request(port, 'GET', `/auth?token=${token}`);
  const cookie = (res.headers['set-cookie'] ?? [])[0]?.split(';')[0];
  if (!cookie) throw new Error('login failed');
  return cookie;
}
