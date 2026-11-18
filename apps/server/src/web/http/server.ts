// The web server's door: who may ask (Host, login, Origin), the page's files,
// and what a request that failed is told. Behind it are the API (routes.ts) and
// the page's sockets (sockets.ts); this file makes what they work with and
// connects them.
import http, { type ServerResponse } from 'node:http';
import { AUTH_REQUIRED, LOGIN_EXPIRED, type ApiError, type LoginResult } from '@agenthouse/protocol';
import { webLogger } from '../../shared/state';
import { readAppSettings, writeAppSettings } from '../app-settings';
import { Conversations } from '../conversations';
import { Delegations, delegationsFile } from '../delegations';
import { EnvService } from '../doctor';
import type { HostClient } from '../host-client';
import { SessionManager } from '../manager';
import { AccessControl } from './access';
import { answer, apiRoutes, HttpError, readBody, refusal } from './routes';
import { LoginBody } from './schemas';
import { attachSockets } from './sockets';
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
  /**
   * Where the CLIs are looked for, written as a PATH; by default this process's own. A check names
   * the folders of its stand-ins, or none (''), so that it never runs the CLIs installed on the machine.
   */
  cliPath?: string;
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

export async function createAgentHouseServer(options: ServerOptions): Promise<AgentHouseServer> {
  // The host keeps its login secret for as long as it runs, so logins outlive web server restarts.
  const access = new AccessControl(options.host.webToken, options.devOrigins ?? []);
  const startCommand = options.startCommand ?? 'pnpm start';
  // Called once the server listens, when the port is known.
  const loginAddress = (code: string) => `http://127.0.0.1:${port}/?code=${code}`;
  const defaultCwd = options.defaultCwd ?? process.cwd();
  const { host } = options;
  const env = new EnvService(
    defaultCwd,
    {
      get build() {
        return host.build;
      },
      stateDir: host.stateDir,
      stopCommand: options.stopCommand ?? 'pnpm stop',
    },
    host.stateDir,
    options.cliPath,
  );
  const manager = new SessionManager({
    env,
    defaultCwd,
    host: options.host,
    ...(options.fakeAgentPath ? { fakeAgentPath: options.fakeAgentPath } : {}),
    ...(options.claudeSessions !== undefined ? { claudeSessions: options.claudeSessions } : {}),
  });
  const conversations = new Conversations(manager);
  const delegations = new Delegations(manager, delegationsFile(host.stateDir));

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

  // The sessions started outside AgentHouse are looked for while a page is open, unless the user turned
  // that off: a choice kept in settings.json, the same for every page.
  let external = readAppSettings(host.stateDir).external;
  const watchExternal = () => manager.watchExternal(external && sockets.pages() > 0);
  const sockets = attachSockets(server, { access, manager, conversations, delegations, openTerminal: (sessionId) => host.openTerminal(sessionId), external: () => external, onPages: watchExternal });
  const setExternal = (on: boolean) => {
    writeAppSettings(host.stateDir, { ...readAppSettings(host.stateDir), external: on });
    external = on;
    watchExternal();
    if (!on) manager.forgetExternal();
    sockets.broadcast({ type: 'external', on });
  };
  const routes = apiRoutes({ env, manager, conversations, delegations, setExternal });

  // Nothing of this server may stay behind, still taking host events and writing its files.
  const closeServices = () => {
    sockets.close();
    delegations.close();
    manager.close();
    conversations.close();
  };
  let port: number;
  try {
    port = await listenOn(server, [options.port, ...(options.fallbackPorts ?? [])]);
  } catch (error) {
    closeServices();
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
      closeServices();
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      // Keep-alive connections (the default since Node 19) would hold close() open.
      server.closeAllConnections();
      await closed;
    },
  };
}
