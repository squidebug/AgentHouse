import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ApiError, ComposeResult, EventServerMessage } from '@agenthouse/protocol';
import { LaunchError } from '../cli/launch';
import { EnvService } from '../doctor';
import { HostUnavailableError, type HostClient } from '../host-client';
import { HostRequestError } from '../../shared/host-protocol';
import { Conversations } from '../conversations';
import { SessionManager } from '../manager';
import { AccessControl } from './access';
import { ComposeBody, LaunchBody, TerminalClient } from './schemas';
import { serveStatic } from './static';

export interface ServerOptions {
  port: number;
  /** The session host that runs the CLIs; the web server only prepares and relays. */
  host: HostClient;
  /** Extra origins allowed to call the API, e.g. the Vite dev server. */
  devOrigins?: string[];
  /** Built web app to serve; omitted in development, where Vite serves it. */
  webDist?: string;
  defaultCwd?: string;
  fakeAgentPath?: string;
  /** Browser login token. Defaults to the host's, which outlives web server restarts. */
  token?: string;
  /** How the user ends the session host, for the environment check (default `pnpm stop`). */
  stopCommand?: string;
}

export interface AgentHouseServer {
  port: number;
  token: string;
  url: string;
  manager: SessionManager;
  /** Stops serving. The sessions keep running in the host. */
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly command?: string,
  ) {
    super(message);
  }
}

// A browser that falls behind stops being read for; the host's backlog for it
// then grows and the host resyncs it from a snapshot. The PTY never waits.
const RELAY_HIGH_WATER = 1024 * 1024;
const RELAY_LOW_WATER = 256 * 1024;

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const isText = typeof body === 'string';
  res.writeHead(status, {
    'content-type': isText ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(isText ? body : JSON.stringify(body));
}

async function readJson(req: IncomingMessage, limit = 256 * 1024): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, '요청이 너무 큽니다.');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON 형식이 올바르지 않습니다.');
  }
}

// A sub-agent's id as Claude writes it; anything else names no transcript.
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const agentParam = (url: URL): string | null | undefined => {
  const value = url.searchParams.get('agent');
  if (value === null) return null;
  return AGENT_ID.test(value) ? value : undefined;
};

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, '요청 값이 올바르지 않습니다.', 'INVALID_REQUEST');
  return result.data;
}

/** Relays one browser terminal socket to the session's terminal on the host. */
function relayTerminal(browser: WebSocket, upstream: WebSocket): void {
  const early: string[] = [];
  let draining: NodeJS.Timeout | undefined;
  const stopDraining = () => clearInterval(draining);

  upstream.on('open', () => {
    for (const text of early) upstream.send(text);
    early.length = 0;
  });
  upstream.on('message', (data, isBinary) => {
    if (browser.readyState !== browser.OPEN) return;
    browser.send(data, { binary: isBinary });
    if (browser.bufferedAmount > RELAY_HIGH_WATER && !upstream.isPaused) {
      upstream.pause();
      draining = setInterval(() => {
        if (browser.readyState === browser.OPEN && browser.bufferedAmount > RELAY_LOW_WATER) return;
        stopDraining();
        upstream.resume();
      }, 50);
    }
  });
  // The session was removed or the host went away; the browser reconnects by itself.
  const end = () => {
    stopDraining();
    browser.close();
  };
  upstream.on('close', end);
  upstream.on('error', end);

  browser.on('message', (raw) => {
    let message;
    try {
      message = TerminalClient.parse(JSON.parse(raw.toString()));
    } catch {
      return;
    }
    const text = JSON.stringify(message);
    if (upstream.readyState === upstream.OPEN) upstream.send(text);
    else if (upstream.readyState === upstream.CONNECTING) early.push(text);
  });
  browser.on('close', () => {
    stopDraining();
    upstream.terminate();
  });
}

export async function createAgentHouseServer(options: ServerOptions): Promise<AgentHouseServer> {
  const token = options.token ?? options.host.webToken;
  const access = new AccessControl(token, options.devOrigins ?? []);
  const defaultCwd = options.defaultCwd ?? process.cwd();
  const { host } = options;
  const env = new EnvService(defaultCwd, {
    get build() {
      return host.build;
    },
    stateDir: host.stateDir,
    stopCommand: options.stopCommand ?? 'pnpm stop',
  });
  const manager = new SessionManager({ env, defaultCwd, host: options.host, ...(options.fakeAgentPath ? { fakeAgentPath: options.fakeAgentPath } : {}) });
  const eventClients = new Set<WebSocket>();
  const terminals = new Set<WebSocket>();
  const conversations = new Conversations(manager);
  const conversationSockets = new Set<WebSocket>();

  const broadcast = (message: EventServerMessage) => {
    const text = JSON.stringify(message);
    for (const ws of eventClients) if (ws.readyState === ws.OPEN) ws.send(text);
  };
  const broadcastSessions = () => broadcast({ type: 'sessions', sessions: manager.list() });
  const broadcastLimits = () => broadcast({ type: 'limits', limits: manager.limits() });
  manager.on('change', broadcastSessions);
  manager.on('limits', broadcastLimits);

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== 'GET' && !access.originAllowed(req)) throw new HttpError(403, '허용되지 않은 출처입니다.');
    const parts = url.pathname.split('/').filter(Boolean); // ['api', 'sessions', id, action]

    if (url.pathname === '/api/env' && req.method === 'GET') {
      send(res, 200, await env.report(url.searchParams.has('refresh')));
      return;
    }
    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      send(res, 200, manager.list());
      return;
    }
    if (url.pathname === '/api/sessions' && req.method === 'POST') {
      const body = parse(LaunchBody, await readJson(req));
      send(res, 201, await manager.create(body));
      return;
    }
    if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2]) {
      const session = manager.get(parts[2]);
      if (!session) throw new HttpError(404, '세션을 찾을 수 없습니다.');
      if (parts.length === 3 && req.method === 'DELETE') {
        send(res, 200, await manager.remove(session.id));
        return;
      }
      if (parts[3] === 'conversation' && parts[4] && parts.length === 5 && req.method === 'GET') {
        const agent = agentParam(url);
        const detail = agent === undefined ? null : await conversations.detail(session.id, parts[4], agent);
        if (!detail) throw new HttpError(404, '찾을 수 없습니다.');
        send(res, 200, detail);
        return;
      }
      if (parts[3] === 'compose' && req.method === 'POST') {
        const body = parse(ComposeBody, await readJson(req));
        const result: ComposeResult = { sessionId: session.id, ...(await manager.compose(session.id, body)) };
        send(res, 200, result);
        return;
      }
    }
    throw new HttpError(404, '찾을 수 없습니다.');
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!access.hostAllowed(req)) {
        send(res, 403, 'host not allowed');
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const loginToken = url.searchParams.get('token');
      if ((url.pathname === '/auth' || url.pathname === '/') && loginToken !== null) {
        if (!access.tokenMatches(loginToken)) {
          send(res, 401, '접속 토큰이 올바르지 않습니다.');
          return;
        }
        send(res, 302, '', { location: '/', 'set-cookie': access.loginCookie() });
        return;
      }
      if (!access.authenticated(req)) {
        send(res, 401, '접속 토큰이 없습니다. 서버를 시작할 때 출력된 주소로 접속하세요.');
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res, url);
        return;
      }
      if (req.method === 'GET' && options.webDist && (await serveStatic(options.webDist, url.pathname, res))) return;
      send(res, 404, '찾을 수 없습니다.');
    } catch (error) {
      if (error instanceof HttpError || error instanceof LaunchError) {
        const body: ApiError = { error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.command ? { command: error.command } : {}) };
        send(res, error.status, body);
        return;
      }
      if (error instanceof HostUnavailableError) {
        send(res, 503, { error: error.message, code: 'HOST_UNAVAILABLE' } satisfies ApiError);
        return;
      }
      if (error instanceof HostRequestError) {
        send(res, error.code === 'NOT_FOUND' ? 404 : 500, { error: error.message, ...(error.code ? { code: error.code } : {}) } satisfies ApiError);
        return;
      }
      send(res, 500, { error: (error as Error).message });
    }
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const reject = (status: number) => {
      socket.write(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (!access.hostAllowed(req) || !access.originAllowed(req)) return reject(403);
    if (!access.authenticated(req)) return reject(401);
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/ws/conversation') {
      // A session's conversation, or with agent=<id> one of its sub-agents'.
      const id = url.searchParams.get('id') ?? '';
      const agent = agentParam(url);
      if (agent === undefined || !conversations.available(id, agent)) return reject(404);
      wss.handleUpgrade(req, socket, head, (ws) => {
        const unsubscribe = conversations.subscribe(
          id,
          (message) => {
            if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
          },
          agent,
        );
        if (!unsubscribe) return ws.close();
        conversationSockets.add(ws);
        ws.on('close', () => {
          conversationSockets.delete(ws);
          unsubscribe();
        });
      });
      return;
    }
    if (url.pathname === '/ws/events') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        eventClients.add(ws);
        ws.on('close', () => eventClients.delete(ws));
        const sessions: EventServerMessage = { type: 'sessions', sessions: manager.list() };
        const limits: EventServerMessage = { type: 'limits', limits: manager.limits() };
        ws.send(JSON.stringify(sessions));
        ws.send(JSON.stringify(limits));
      });
      return;
    }
    const sessionId = url.pathname === '/ws/session' ? (url.searchParams.get('id') ?? '') : '';
    // Only the session host has terminals; an ended session from an earlier host has none.
    if (!sessionId || !manager.get(sessionId)?.screen) return reject(404);
    wss.handleUpgrade(req, socket, head, (ws) => {
      terminals.add(ws);
      ws.on('close', () => terminals.delete(ws));
      relayTerminal(ws, options.host.openTerminal(sessionId));
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      resolve(typeof address === 'object' && address ? address.port : options.port);
    });
  });
  access.bind(port);
  env.report().catch(() => {}); // warm the CLI probe so the launcher opens instantly

  return {
    port,
    token,
    url: `http://127.0.0.1:${port}/auth?token=${token}`,
    manager,
    async close() {
      manager.off('change', broadcastSessions);
      manager.off('limits', broadcastLimits);
      manager.close();
      conversations.close();
      for (const ws of conversationSockets) ws.terminate();
      for (const ws of eventClients) ws.close();
      for (const ws of terminals) ws.terminate();
      wss.close();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      // Keep-alive connections (the default since Node 19) would hold close() open.
      server.closeAllConnections();
      await closed;
    },
  };
}
