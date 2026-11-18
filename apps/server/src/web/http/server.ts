import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { AUTH_REQUIRED, LOGIN_EXPIRED, SOCKET_PROTOCOL, type ApiError, type EventServerMessage, type LoginResult } from '@agenthouse/protocol';
import { webLogger } from '../../shared/state';
import { readAppSettings, writeAppSettings } from '../app-settings';
import { Conversations } from '../conversations';
import { Delegations, delegationsFile } from '../delegations';
import { EnvService } from '../doctor';
import type { HostClient } from '../host-client';
import { SessionManager } from '../manager';
import { AccessControl } from './access';
import { answer, apiRoutes, HttpError, readBody, refusal } from './routes';
import { agentParam, LoginBody, TerminalClient } from './schemas';
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
  /** Claude Code's own list of sessions, for the ones started outside AgentHouse (ManagerOptions.claudeSessions). */
  claudeSessions?: (() => Promise<unknown>) | null;
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

// A browser that falls behind stops being read for; the host's backlog for it
// then grows and the host resyncs it from a snapshot. The PTY never waits.
const RELAY_HIGH_WATER = 1024 * 1024;
const RELAY_LOW_WATER = 256 * 1024;
// A page's first list waits this long at most for Claude's own list of sessions (one call is about half a second).
const FIRST_LOOK_MS = 2500;
/** The code of a 500 that is a fault, not a refusal: its cause is in logs/web.log, never in the reply. */
const SERVER_ERROR = 'SERVER_ERROR';

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
  const manager = new SessionManager({
    env,
    defaultCwd,
    host: options.host,
    ...(options.fakeAgentPath ? { fakeAgentPath: options.fakeAgentPath } : {}),
    ...(options.claudeSessions !== undefined ? { claudeSessions: options.claudeSessions } : {}),
  });
  // The pages that are open, and those of them that have their first lists and get every change.
  const pages = new Set<WebSocket>();
  const eventClients = new Set<WebSocket>();
  // The sessions started outside AgentHouse are looked for while a page is open, unless the user turned that off.
  let external = readAppSettings(host.stateDir).external;
  const watchExternal = () => manager.watchExternal(external && pages.size > 0);
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

  // The user's choice to watch the sessions started outside AgentHouse, or not: kept in settings.json.
  const setExternal = (on: boolean) => {
    writeAppSettings(host.stateDir, { ...readAppSettings(host.stateDir), external: on });
    external = on;
    watchExternal();
    if (!on) manager.forgetExternal();
    broadcast({ type: 'external', on });
  };
  const routes = apiRoutes({ env, manager, conversations, delegations, setExternal });

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
        const { code } = await readBody(req, LoginBody, 4096);
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
        // Whatever changes anything comes from the page itself, not from another site open in the same browser.
        if (req.method !== 'GET' && !access.originAllowed(req)) throw new HttpError(403, '허용되지 않은 출처입니다.');
        const { status, body } = await answer(routes, req, url);
        send(res, status, body);
        return;
      }
      // The page holds no secret; what it shows comes from the API.
      if (req.method === 'GET' && options.webDist && (await serveStatic(options.webDist, url.pathname, res))) return;
      send(res, 404, '찾을 수 없습니다.');
    } catch (error) {
      const refused = refusal(error);
      if (refused) {
        send(res, refused.status, refused.body);
        return;
      }
      // A fault of this server's own, or of the host's. What it says may name files of this machine, and a
      // page file that cannot be read fails for someone who has not logged in: the reply says only that it
      // failed, and the log has the rest (without the query, where a login code may be).
      webLogger(host.stateDir)(`${req.method} ${(req.url ?? '').split('?')[0]}: ${(error as Error)?.stack ?? error}`);
      send(res, 500, { error: '서버 오류가 발생했습니다.', code: SERVER_ERROR } satisfies ApiError);
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
        pages.add(ws);
        ws.on('close', () => {
          pages.delete(ws);
          eventClients.delete(ws);
          watchExternal();
        });
        watchExternal();
        // The first list a page gets has the sessions started elsewhere in it: a pane restored to one
        // of them would close on a list without it. Until Claude has been asked once, the page gets
        // no list at all.
        const looked = manager.externalReady(FIRST_LOOK_MS).catch(() => {});
        void looked.then(() => {
          if (ws.readyState !== ws.OPEN) return;
          eventClients.add(ws);
          const first: EventServerMessage[] = [
            { type: 'sessions', sessions: manager.list() },
            { type: 'limits', limits: manager.limits() },
            { type: 'links', links: manager.links() },
            { type: 'delegations', delegations: delegations.list() },
            { type: 'external', on: external },
          ];
          for (const message of first) ws.send(JSON.stringify(message));
        });
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
      for (const ws of pages) ws.close();
      for (const ws of terminals) ws.terminate();
      wss.close();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      // Keep-alive connections (the default since Node 19) would hold close() open.
      server.closeAllConnections();
      await closed;
    },
  };
}
