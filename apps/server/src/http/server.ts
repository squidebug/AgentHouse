import { randomBytes } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ApiError, ComposeResult, EventServerMessage } from '@agenthouse/protocol';
import { LaunchError } from '../cli/launch';
import { EnvService } from '../env/report';
import { SessionManager, THEME_COLORS } from '../sessions/manager';
import { AccessControl } from './access';
import { ComposeBody, LaunchBody, TerminalClient } from './schemas';
import { serveStatic } from './static';

export interface ServerOptions {
  port: number;
  /** Extra origins allowed to call the API, e.g. the Vite dev server. */
  devOrigins?: string[];
  /** Built web app to serve; omitted in development, where Vite serves it. */
  webDist?: string;
  defaultCwd?: string;
  fakeAgentPath?: string;
  token?: string;
}

export interface AgentHouseServer {
  port: number;
  token: string;
  url: string;
  manager: SessionManager;
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

function parse<T>(schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } }, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, '요청 값이 올바르지 않습니다.', 'INVALID_REQUEST');
  return result.data;
}

export async function createAgentHouseServer(options: ServerOptions): Promise<AgentHouseServer> {
  const token = options.token ?? randomBytes(24).toString('base64url');
  const access = new AccessControl(token, options.devOrigins ?? []);
  const defaultCwd = options.defaultCwd ?? process.cwd();
  const env = new EnvService(defaultCwd);
  const manager = new SessionManager({ env, defaultCwd, ...(options.fakeAgentPath ? { fakeAgentPath: options.fakeAgentPath } : {}) });
  const eventClients = new Set<WebSocket>();

  const broadcastSessions = () => {
    const message: EventServerMessage = { type: 'sessions', sessions: manager.list() };
    const text = JSON.stringify(message);
    for (const ws of eventClients) if (ws.readyState === ws.OPEN) ws.send(text);
  };
  manager.on('change', broadcastSessions);

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
      const session = await manager.create(body);
      send(res, 201, session.info());
      return;
    }
    if (parts[0] === 'api' && parts[1] === 'sessions' && parts[2]) {
      const session = manager.get(parts[2]);
      if (!session) throw new HttpError(404, '세션을 찾을 수 없습니다.');
      if (parts.length === 3 && req.method === 'DELETE') {
        send(res, 200, await manager.remove(session.id));
        return;
      }
      if (parts[3] === 'compose' && req.method === 'POST') {
        const body = parse(ComposeBody, await readJson(req));
        const result: ComposeResult = { sessionId: session.id, ...(await session.compose(body)) };
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
    if (url.pathname === '/ws/events') {
      wss.handleUpgrade(req, socket, head, (ws) => {
        eventClients.add(ws);
        ws.on('close', () => eventClients.delete(ws));
        const message: EventServerMessage = { type: 'sessions', sessions: manager.list() };
        ws.send(JSON.stringify(message));
      });
      return;
    }
    const session = url.pathname === '/ws/session' ? manager.get(url.searchParams.get('id') ?? '') : undefined;
    if (!session) return reject(404);
    wss.handleUpgrade(req, socket, head, (ws) => {
      const viewer = session.attach(ws);
      ws.on('message', (raw) => {
        let message;
        try {
          message = TerminalClient.parse(JSON.parse(raw.toString()));
        } catch {
          return;
        }
        if (message.type === 'input') session.input(message.data, message.binary === true);
        else if (message.type === 'resize') session.resize(viewer, message.cols, message.rows);
        else if (message.type === 'claim') session.claim(viewer);
        else if (message.type === 'theme') session.setColors(THEME_COLORS[message.mode]);
      });
      ws.on('close', () => session.detach(viewer));
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
      for (const ws of eventClients) ws.close();
      await manager.closeAll();
      wss.close();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      // Keep-alive connections (the default since Node 19) would hold close() open.
      server.closeAllConnections();
      await closed;
    },
  };
}
