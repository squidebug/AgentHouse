import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { AUTH_REQUIRED, LOGIN_EXPIRED, SOCKET_PROTOCOL, type ApiError, type ComposeResult, type EventServerMessage, type LoginResult } from '@agenthouse/protocol';
import { AGENT_ID } from '../../claude/agents';
import { LaunchError } from '../cli/launch';
import { CliChoiceError, EnvService } from '../doctor';
import { HostUnavailableError, type HostClient } from '../host-client';
import { HostRequestError } from '../../shared/host-protocol';
import { Conversations } from '../conversations';
import { DelegationError, Delegations, delegationsFile } from '../delegations';
import { LinkError } from '../links';
import { SessionManager } from '../manager';
import { AccessControl } from './access';
import { ChooseCliBody, ComposeBody, DelegateBody, DeliverBody, LaunchBody, LinkBody, LoginBody, TerminalClient } from './schemas';
import { serveStatic } from './static';

export interface ServerOptions {
  port: number;
  /** Tried in order when `port` is taken; 0 lets the system choose. */
  fallbackPorts?: number[];
  /** The session host that runs the CLIs; the web server only prepares and relays. */
  host: HostClient;
  /** Extra origins allowed to call the API, e.g. the Vite dev server. */
  devOrigins?: string[];
  /** Built web app to serve; omitted in development, where Vite serves it. */
  webDist?: string;
  defaultCwd?: string;
  fakeAgentPath?: string;
  /** How the user ends the session host, for the environment check (default `pnpm stop`). */
  stopCommand?: string;
  /** How the user gets a new login address, for a page that is not logged in (default `pnpm start`). */
  startCommand?: string;
}

export interface AgentHouseServer {
  port: number;
  /** The address without a login code. */
  url: string;
  /** For local tools (web.json, --json, tests): taken as a bearer, at this port only. */
  key: string;
  /** An address that logs a browser in, once: a new one-time code on every call. */
  loginUrl(): string;
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
// A message or delegated work is 200,000 characters at most (schemas.ts): up to four bytes each in
// UTF-8, more where JSON escapes them. The default limit refused Korean text from about 85,000 on.
const TEXT_BODY_BYTES = 1024 * 1024;

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  // A reply already under way (it failed halfway) can only be cut off; writing headers again would throw.
  if (res.headersSent) {
    res.destroy();
    return;
  }
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

// A sub-agent's id as Claude writes it (AGENT_ID); anything else names no transcript.
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

/** Listens on the first of these ports that is free; any other error, or none free, fails. */
async function listenOn(server: http.Server, ports: number[]): Promise<number> {
  let taken: unknown = new Error('no port to listen on');
  for (const candidate of ports) {
    try {
      return await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(candidate, '127.0.0.1', () => {
          server.off('error', reject);
          const address = server.address();
          resolve(typeof address === 'object' && address ? address.port : candidate);
        });
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
      taken = error;
    }
  }
  throw taken;
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
  // The host keeps its login secret for as long as it runs, so logins outlive web server restarts.
  const access = new AccessControl(options.host.webToken, options.devOrigins ?? []);
  const startCommand = options.startCommand ?? 'pnpm start';
  // Called once the server listens, when the port is known.
  const loginAddress = (code: string) => `http://127.0.0.1:${port}/?code=${code}`;
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
  const delegations = new Delegations(manager, delegationsFile(host.stateDir));
  const conversationSockets = new Set<WebSocket>();

  const broadcast = (message: EventServerMessage) => {
    const text = JSON.stringify(message);
    for (const ws of eventClients) if (ws.readyState === ws.OPEN) ws.send(text);
  };
  const broadcastSessions = () => broadcast({ type: 'sessions', sessions: manager.list() });
  const broadcastLimits = () => broadcast({ type: 'limits', limits: manager.limits() });
  const broadcastLinks = () => broadcast({ type: 'links', links: manager.links() });
  const broadcastDelegations = () => broadcast({ type: 'delegations', delegations: delegations.list() });
  delegations.on('change', broadcastDelegations);
  manager.on('change', broadcastSessions);
  manager.on('limits', broadcastLimits);
  manager.on('links', broadcastLinks);

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== 'GET' && !access.originAllowed(req)) throw new HttpError(403, '허용되지 않은 출처입니다.');
    const parts = url.pathname.split('/').filter(Boolean); // ['api', 'sessions', id, action]

    // The page's token is good: a page that lost its sockets tells a server restart from a lost login.
    if (url.pathname === '/api/auth' && req.method === 'GET') {
      send(res, 200, {});
      return;
    }
    if (url.pathname === '/api/env' && req.method === 'GET') {
      send(res, 200, await env.report(url.searchParams.has('refresh')));
      return;
    }
    // Which executable runs a CLI: one picked or typed in the environment check, or null for the shell's.
    if (parts[0] === 'api' && parts[1] === 'cli' && parts.length === 3 && req.method === 'PUT') {
      const vendor = parts[2];
      if (vendor !== 'claude' && vendor !== 'codex') throw new HttpError(404, '찾을 수 없습니다.');
      const { path: chosen } = parse(ChooseCliBody, await readJson(req, 8192));
      try {
        send(res, 200, await env.choose(vendor, chosen));
      } catch (error) {
        if (error instanceof CliChoiceError) throw new HttpError(400, error.message, 'INVALID_CLI');
        throw error;
      }
      return;
    }
    if (url.pathname === '/api/sessions' && req.method === 'GET') {
      send(res, 200, manager.list());
      return;
    }
    // Hands a delegate's answer back to the session that delegated the work.
    if (parts[0] === 'api' && parts[1] === 'delegations' && parts[2] && parts[3] === 'deliver' && parts.length === 4 && req.method === 'POST') {
      const body = parse(DeliverBody, await readJson(req));
      send(res, 200, await delegated(() => delegations.deliver(parts[2]!, body.header)));
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
      // Ends the CLI; the session stays listed, ended.
      if (parts[3] === 'end' && parts.length === 4 && req.method === 'POST') {
        send(res, 200, await manager.end(session.id));
        return;
      }
      if (parts[3] === 'conversation' && parts[4] && parts.length === 5 && req.method === 'GET') {
        const agent = agentParam(url);
        const detail = agent === undefined ? null : await conversations.detail(session.id, parts[4], agent);
        if (!detail) throw new HttpError(404, '찾을 수 없습니다.');
        send(res, 200, detail);
        return;
      }
      // Sends work from this session to the session delegated under it.
      if (parts[3] === 'delegations' && parts.length === 4 && req.method === 'POST') {
        const body = parse(DelegateBody, await readJson(req, TEXT_BODY_BYTES));
        send(res, 201, await delegated(() => delegations.delegate(session.id, body.childId, body.text)));
        return;
      }
      // Places the session under another one (grouping), or back at the top.
      if (parts[3] === 'link' && parts.length === 4 && req.method === 'PUT') {
        const body = parse(LinkBody, await readJson(req));
        try {
          send(res, 200, { links: manager.link(session.id, body.parentId, body.kind ?? 'group') });
        } catch (error) {
          if (error instanceof LinkError) throw new HttpError(error.code === 'NOT_FOUND' ? 404 : 400, error.message, error.code);
          throw error;
        }
        return;
      }
      if (parts[3] === 'compose' && parts.length === 4 && req.method === 'POST') {
        const body = parse(ComposeBody, await readJson(req, TEXT_BODY_BYTES));
        const result: ComposeResult = { sessionId: session.id, ...(await manager.compose(session.id, body)) };
        send(res, 200, result);
        return;
      }
    }
    throw new HttpError(404, '찾을 수 없습니다.');
  }

  /** A delegation call, its refusals as HTTP errors. */
  async function delegated<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof DelegationError) throw new HttpError(error.code === 'NOT_FOUND' ? 404 : error.code === 'BUSY' ? 409 : 400, error.message, error.code);
      throw error;
    }
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!access.hostAllowed(req)) {
        send(res, 403, 'host not allowed');
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      // A local tool (a second start) asks for an address to open.
      if (url.pathname === '/auth/code' && req.method === 'POST') {
        if (!access.isLocalTool(req)) {
          send(res, 401, { error: '로그인 코드를 만들 수 없습니다.' } satisfies ApiError);
          return;
        }
        const code = access.issueCode();
        send(res, 200, { code, url: loginAddress(code) });
        return;
      }
      if (url.pathname === '/api/login' && req.method === 'POST') {
        if (!access.originAllowed(req)) throw new HttpError(403, '허용되지 않은 출처입니다.');
        const { code } = parse(LoginBody, await readJson(req, 4096));
        const token = access.redeem(code);
        if (!token) {
          send(res, 401, { error: '로그인 링크가 만료되었습니다.', code: LOGIN_EXPIRED, command: startCommand } satisfies ApiError);
          return;
        }
        send(res, 200, { token } satisfies LoginResult);
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        if (!access.authenticated(req)) {
          send(res, 401, { error: '로그인이 필요합니다.', code: AUTH_REQUIRED, command: startCommand } satisfies ApiError);
          return;
        }
        await handleApi(req, res, url);
        return;
      }
      // The address of the old login: the page now logs itself in.
      if (url.pathname === '/auth') {
        send(res, 302, '', { location: '/' });
        return;
      }
      // The page holds no secret; what it shows comes from the API.
      if (req.method === 'GET' && options.webDist) {
        if (access.sendsOldCookie(req)) res.setHeader('set-cookie', AccessControl.clearOldCookie);
        if (await serveStatic(options.webDist, url.pathname, res)) return;
      }
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

  // A page offers `agenthouse` and its token as subprotocols; the server answers with `agenthouse`, never the token.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 2 * 1024 * 1024,
    handleProtocols: (protocols) => (protocols.has(SOCKET_PROTOCOL) ? SOCKET_PROTOCOL : false),
  });
  // A socket's error (a frame over maxPayload, a peer gone mid-frame) closes that socket only: ws closes
  // it by itself (1009 for a frame too big). Without a listener it would be thrown, and the web server
  // with every tab would go.
  const accept = (ws: WebSocket) => ws.on('error', () => {});

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
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
        accept(ws);
        // turns=only: the turns without the entries, for a view that only shows when the session worked.
        const turnsOnly = url.searchParams.get('turns') === 'only';
        const unsubscribe = conversations.subscribe(
          id,
          (message) => {
            if (ws.readyState !== ws.OPEN) return;
            if (!turnsOnly) return ws.send(JSON.stringify(message));
            if (message.type === 'update' && !message.turns.length) return;
            ws.send(JSON.stringify({ ...message, entries: [] }));
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
        accept(ws);
        eventClients.add(ws);
        ws.on('close', () => eventClients.delete(ws));
        const sessions: EventServerMessage = { type: 'sessions', sessions: manager.list() };
        const limits: EventServerMessage = { type: 'limits', limits: manager.limits() };
        const links: EventServerMessage = { type: 'links', links: manager.links() };
        const delegated: EventServerMessage = { type: 'delegations', delegations: delegations.list() };
        ws.send(JSON.stringify(sessions));
        ws.send(JSON.stringify(limits));
        ws.send(JSON.stringify(links));
        ws.send(JSON.stringify(delegated));
      });
      return;
    }
    const sessionId = url.pathname === '/ws/session' ? (url.searchParams.get('id') ?? '') : '';
    // Only the session host has terminals; an ended session from an earlier host has none.
    if (!sessionId || !manager.get(sessionId)?.screen) return reject(404);
    wss.handleUpgrade(req, socket, head, (ws) => {
      accept(ws);
      terminals.add(ws);
      ws.on('close', () => terminals.delete(ws));
      relayTerminal(ws, options.host.openTerminal(sessionId));
    });
  });

  let port: number;
  try {
    port = await listenOn(server, [options.port, ...(options.fallbackPorts ?? [])]);
  } catch (error) {
    // Nothing of this server may stay behind, still taking host events and writing its files.
    delegations.close();
    manager.close();
    conversations.close();
    throw error;
  }
  access.bind(port);
  env.report().catch(() => {}); // warm the CLI probe so the launcher opens instantly

  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    key: access.key,
    loginUrl: () => loginAddress(access.issueCode()),
    manager,
    async close() {
      manager.off('change', broadcastSessions);
      manager.off('limits', broadcastLimits);
      manager.off('links', broadcastLinks);
      delegations.off('change', broadcastDelegations);
      delegations.close();
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
