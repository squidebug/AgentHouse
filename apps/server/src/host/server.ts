import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket } from 'ws';
import { TERMINAL_COLORS, type AccountLimits, type SessionInfo, type TerminalClientMessage, type Vendor } from '@agenthouse/protocol';
import { hostBuildId } from '../shared/build';
import { sameSecret } from '../shared/compare';
import { HOST_PROTOCOL, HostRequestError, hostProof, type HostMessage, type HostRequest, type SpawnSpec } from '../shared/host-protocol';
import { clearState, removeTree, runDir, writeState } from '../shared/state';
import { receiveFromRelay } from './hooks';
import { ClaudeObserver, Observer } from './observer';
import { Session, type ViewerBacklog } from './session';

export interface HostOptions {
  stateDir: string;
  /** Leave after this long with no running session and no web server attached; null never leaves (tests). */
  idleExitMs: number | null;
  /** Browser login token kept for the host's lifetime, so a browser stays logged in across web server restarts. */
  webToken?: string;
  log?: (line: string) => void;
  /** Tests make it small, so a stalled viewer outgrows it whatever the OS buffers on the socket. */
  viewerBacklog?: ViewerBacklog;
}

export interface SessionHost {
  port: number;
  /** Settles when the host should exit: idle for idleExitMs, or asked to shut down. */
  done: Promise<'idle' | 'shutdown'>;
  close(): Promise<void>;
}

const sameWindow = (a: AccountLimits['fiveHour'], b: AccountLimits['fiveHour']) => a?.usedPct === b?.usedPct && a?.resetsAt === b?.resetsAt;

/**
 * The long-lived half of AgentHouse. It owns every PTY and its screen mirror, so
 * the web server can restart (or crash) without ending a running agent. Only web
 * servers that can read the state file get in; browsers never talk to it.
 */
export async function createSessionHost(options: HostOptions): Promise<SessionHost> {
  const log = options.log ?? (() => {});
  const token = randomBytes(32).toString('base64url');
  const build = hostBuildId();
  const webToken = options.webToken || randomBytes(24).toString('base64url');
  const sessions = new Map<string, Session>();
  const controls = new Set<WebSocket>();
  let idleTimer: NodeJS.Timeout | undefined;
  let settle: (reason: 'idle' | 'shutdown') => void = () => {};
  const done = new Promise<'idle' | 'shutdown'>((resolve) => {
    settle = resolve;
  });

  const limits = new Map<Vendor, AccountLimits>();
  let broadcastTimer: NodeJS.Timeout | undefined;

  const list = (): SessionInfo[] => [...sessions.values()].map((s) => s.info());
  const send = (ws: WebSocket, message: HostMessage) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
  };
  const broadcast = () => {
    clearTimeout(broadcastTimer);
    broadcastTimer = undefined;
    const message: HostMessage = { type: 'sessions', sessions: list() };
    for (const ws of controls) send(ws, message);
  };
  // Status lines and hook events arrive in bursts; one update per burst is enough.
  const broadcastSoon = () => {
    broadcastTimer ??= setTimeout(broadcast, 150);
  };
  const updateLimits = (vendor: Vendor, update: Omit<AccountLimits, 'vendor'>) => {
    const previous = limits.get(vendor);
    limits.set(vendor, { vendor, ...update });
    if (previous && sameWindow(previous.fiveHour, update.fiveHour) && sameWindow(previous.sevenDay, update.sevenDay)) return;
    const message: HostMessage = { type: 'limits', limits: [...limits.values()] };
    for (const ws of controls) send(ws, message);
  };

  // Exited sessions do not keep the host alive; their list entries go with it.
  const checkIdle = () => {
    clearTimeout(idleTimer);
    if (options.idleExitMs === null || controls.size > 0) return;
    if ([...sessions.values()].some((s) => !s.exit)) return;
    idleTimer = setTimeout(() => settle('idle'), options.idleExitMs);
  };

  const find = (id: string): Session => {
    const session = sessions.get(id);
    if (!session) throw new HostRequestError('세션을 찾을 수 없습니다.', 'NOT_FOUND');
    return session;
  };

  const start = (spec: SpawnSpec): SessionInfo => {
    if (typeof spec.id !== 'string' || !/^[\w-]{8,64}$/.test(spec.id)) throw new HostRequestError('세션 id가 올바르지 않습니다.', 'INVALID_REQUEST');
    if (sessions.has(spec.id)) throw new HostRequestError('이미 있는 세션입니다.', 'DUPLICATE');
    const removeTemp = async () => {
      await Promise.all(spec.tempPaths.map(removeTree));
    };
    let session: Session;
    try {
      session = new Session({
        id: spec.id,
        vendor: spec.vendor,
        title: spec.title,
        file: spec.file,
        args: spec.args,
        cwd: spec.cwd,
        env: spec.env,
        cols: spec.cols,
        rows: spec.rows,
        colors: TERMINAL_COLORS[spec.theme],
        model: spec.model,
        effort: spec.effort,
        permissionMode: spec.permissionMode,
        cliVersion: spec.cliVersion,
        observe: (pid) =>
          spec.hookToken
            ? new ClaudeObserver({ token: spec.hookToken, vendorSessionId: spec.vendorSessionId, agentsCommand: spec.agentsCommand, env: spec.env, pid })
            : new Observer(spec.vendorSessionId),
        cleanup: removeTemp,
        ...(options.viewerBacklog ? { backlog: options.viewerBacklog } : {}),
      });
    } catch (error) {
      removeTemp().catch(() => {});
      throw new HostRequestError(`실행하지 못했습니다: ${(error as Error).message}`, 'SPAWN_FAILED');
    }
    sessions.set(session.id, session);
    log(`session ${session.id} started (${spec.vendor}, pid ${session.pid})`);
    session.on('exit', () => {
      log(`session ${session.id} exited (code ${session.exit?.code})`);
      broadcast();
      checkIdle();
    });
    session.on('status', broadcastSoon);
    broadcast();
    checkIdle();
    return session.info();
  };

  const closeAll = () => Promise.all([...sessions.values()].map((s) => s.close()));

  async function handle(request: HostRequest): Promise<unknown> {
    switch (request.op) {
      case 'spawn':
        return start(request.spec);
      case 'close': {
        const session = find(request.sessionId);
        const result = await session.close();
        sessions.delete(session.id);
        broadcast();
        checkIdle();
        return result;
      }
      case 'compose':
        return find(request.sessionId).compose(request.request);
      case 'shutdown': {
        const running = [...sessions.values()].filter((s) => !s.exit).length;
        await closeAll();
        setImmediate(() => settle('shutdown'));
        return { closed: running };
      }
      default:
        throw new HostRequestError('알 수 없는 요청입니다.', 'UNKNOWN_OP');
    }
  }

  const attachControl = (ws: WebSocket, nonce: string) => {
    controls.add(ws);
    clearTimeout(idleTimer);
    const proof = hostProof(token, nonce);
    send(ws, { type: 'hello', protocol: HOST_PROTOCOL, pid: process.pid, proof, build, webToken, sessions: list(), limits: [...limits.values()] });
    ws.on('message', async (raw) => {
      let request: HostRequest;
      try {
        request = JSON.parse(raw.toString()) as HostRequest;
      } catch {
        return;
      }
      if (typeof request?.id !== 'number') return;
      try {
        send(ws, { type: 'reply', id: request.id, ok: true, result: (await handle(request)) ?? null });
      } catch (error) {
        const code = error instanceof HostRequestError ? error.code : undefined;
        send(ws, { type: 'reply', id: request.id, ok: false, error: (error as Error).message, ...(code ? { code } : {}) });
      }
    });
    ws.on('close', () => {
      controls.delete(ws);
      checkIdle();
    });
  };

  // The web server has validated the browser's messages; this only guards the types.
  const attachTerminal = (session: Session, ws: WebSocket) => {
    const viewer = session.attach(ws);
    ws.on('message', (raw) => {
      let message: TerminalClientMessage;
      try {
        message = JSON.parse(raw.toString()) as TerminalClientMessage;
      } catch {
        return;
      }
      if (message.type === 'input' && typeof message.data === 'string') session.input(message.data, message.binary === true);
      else if (message.type === 'resize' && Number.isFinite(message.cols) && Number.isFinite(message.rows)) session.resize(viewer, message.cols, message.rows);
      else if (message.type === 'claim') session.claim(viewer);
      else if (message.type === 'theme' && (message.mode === 'light' || message.mode === 'dark')) session.setColors(TERMINAL_COLORS[message.mode]);
    });
    ws.on('close', () => session.detach(viewer));
  };

  const inbox = {
    find: (token: string) => {
      for (const session of sessions.values()) {
        if (session.observer instanceof ClaudeObserver && session.observer.ownsHookToken(token)) return session.observer;
      }
      return undefined;
    },
    limits: (update: Omit<AccountLimits, 'vendor'>) => updateLimits('claude', update),
  };
  const server = http.createServer((req, res) => {
    if (receiveFromRelay(req, res, inbox)) return;
    res.writeHead(404);
    res.end();
    req.resume();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    const reject = (status: number) => {
      socket.write(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    // A browser always sends Origin; a web server on this machine never does, and holds the token.
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? '';
    if (req.headers.origin !== undefined || !sameSecret(bearer, token)) return reject(401);
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/control') {
      const nonce = req.headers['x-agenthouse-nonce'];
      if (typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 128) return reject(400);
      wss.handleUpgrade(req, socket, head, (ws) => attachControl(ws, nonce));
      return;
    }
    if (url.pathname === '/terminal') {
      const session = sessions.get(url.searchParams.get('id') ?? '');
      if (!session) return reject(404);
      wss.handleUpgrade(req, socket, head, (ws) => attachTerminal(session, ws));
      return;
    }
    reject(404);
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve((server.address() as AddressInfo).port);
    });
  });
  writeState(options.stateDir, { protocol: HOST_PROTOCOL, pid: process.pid, port, token, startedAt: Date.now() });
  // Session files a previous host of this protocol left behind (it was killed,
  // or Windows still held a file when it tried): nobody reads them any more.
  removeTree(runDir(options.stateDir)).catch(() => {});
  checkIdle();

  return {
    port,
    done,
    async close() {
      clearTimeout(idleTimer);
      clearTimeout(broadcastTimer);
      await closeAll();
      sessions.clear();
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      clearState(options.stateDir, process.pid);
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
    },
  };
}
