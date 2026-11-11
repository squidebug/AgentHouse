import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import type { AccountLimits, ComposeRequest, SessionInfo } from '@agenthouse/protocol';
import { childEnv } from '../sessions/env';
import { isAlive } from '../util/kill-tree';
import {
  HOST_PROTOCOL,
  HostRequestError,
  validHostProof,
  type CloseResult,
  type ComposeOutcome,
  type HostMessage,
  type HostRequest,
  type HostState,
  type SpawnSpec,
} from './protocol';
import { logFile, readState, runDir } from './state';

export class HostUnavailableError extends Error {
  constructor() {
    super('세션 호스트에 연결할 수 없습니다.');
  }
}

export interface ConnectOptions {
  stateDir: string;
  /** Start a host when none is running. Off for `--stop` and for tests that run their own. */
  spawn: boolean;
  /** Extra host arguments, e.g. a short idle timeout in tests. */
  hostArgs?: string[];
  /** Browser login token a newly started host should keep. */
  webToken?: string;
}

type Hello = Extract<HostMessage, { type: 'hello' }>;
interface Link {
  state: HostState;
  ws: WebSocket;
  hello: Hello;
}
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;
type RequestBody = WithoutId<HostRequest>;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The built bundle next to this file, or the TypeScript source under tsx during development and tests. */
function hostCommand(): string[] {
  const here = fileURLToPath(import.meta.url);
  if (!here.endsWith('.ts')) return [path.join(path.dirname(here), 'host.js')];
  const tsx = createRequire(import.meta.url).resolve('tsx');
  return ['--import', pathToFileURL(tsx).href, path.join(path.dirname(here), 'main.ts')];
}

function startHost(options: ConnectOptions): void {
  const env = childEnv();
  if (options.webToken) env.AGENTHOUSE_WEB_TOKEN = options.webToken;
  // `--detach` makes the host start itself once more and leave, so it ends up
  // nobody's child and outlives this process. The home folder as its working
  // directory keeps it from locking the folder AgentHouse was started in.
  const launcher = spawn(process.execPath, [...hostCommand(), '--detach', '--state-dir', options.stateDir, ...(options.hostArgs ?? [])], {
    cwd: os.homedir(),
    env,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  launcher.on('error', () => {});
  launcher.unref();
}

/**
 * Opens the control channel and waits for the host's hello; null if nothing
 * usable answers. The hello must prove the host knows the token, before
 * anything is sent to it or taken from it.
 */
function openControl(state: HostState, timeoutMs: number): Promise<Omit<Link, 'state'> | null> {
  return new Promise((resolve) => {
    const nonce = randomBytes(24).toString('base64url');
    const ws = new WebSocket(`ws://127.0.0.1:${state.port}/control`, {
      headers: { authorization: `Bearer ${state.token}`, 'x-agenthouse-nonce': nonce },
    });
    const fail = () => {
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on('error', () => {});
      ws.terminate();
      resolve(null);
    };
    const timer = setTimeout(fail, timeoutMs);
    ws.once('error', fail);
    ws.once('message', (raw) => {
      let message: HostMessage | null = null;
      try {
        message = JSON.parse(raw.toString()) as HostMessage;
      } catch {
        // not a host
      }
      if (message?.type !== 'hello' || message.protocol !== HOST_PROTOCOL || !validHostProof(state.token, nonce, message.proof)) return fail();
      clearTimeout(timer);
      ws.removeAllListeners();
      ws.on('error', () => {});
      resolve({ ws, hello: message });
    });
  });
}

/** True when a host answers at this state (used by a starting host to avoid running twice). */
export async function probeHost(state: HostState): Promise<boolean> {
  const link = await openControl(state, 1500);
  link?.ws.close();
  return Boolean(link);
}

async function findOrStart(options: ConnectOptions): Promise<Link> {
  const current = readState(options.stateDir);
  if (current && isAlive(current.pid)) {
    const link = await openControl(current, 2000);
    if (link) return { state: current, ...link };
  }
  if (!options.spawn) throw new HostUnavailableError();
  startHost(options);
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await sleep(100);
    const state = readState(options.stateDir);
    if (!state || !isAlive(state.pid) || (current && state.pid === current.pid && state.startedAt === current.startedAt)) continue;
    const link = await openControl(state, 2000);
    if (link) return { state, ...link };
  }
  throw new Error(`세션 호스트를 시작하지 못했습니다. 기록: ${logFile(options.stateDir)}`);
}

/**
 * The web server's side of the session host: requests, the live session list,
 * and terminal sockets to relay. If the host goes away it keeps trying to get
 * back to one (starting a new host when allowed); the sessions of a host that
 * died are gone with it.
 */
export class HostClient extends EventEmitter {
  /** The browser login token this web server should use unless it was given one. */
  readonly webToken: string;
  private link: Link;
  private list: SessionInfo[];
  private limitList: AccountLimits[];
  private up = true;
  private closed = false;
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();

  private constructor(
    private readonly options: ConnectOptions,
    link: Link,
  ) {
    super();
    this.link = link;
    this.list = link.hello.sessions;
    this.limitList = link.hello.limits;
    this.webToken = options.webToken ?? link.hello.webToken;
    this.bind(link.ws);
  }

  static async connect(options: ConnectOptions): Promise<HostClient> {
    return new HostClient(options, await findOrStart(options));
  }

  get pid(): number {
    return this.link.state.pid;
  }

  /** Where the CLIs' hook relays reach the host. */
  get port(): number {
    return this.link.state.port;
  }

  /** Where a session's files (settings, relay config) go; the host removes them when it ends. */
  get runDir(): string {
    return runDir(this.options.stateDir);
  }

  limits(): AccountLimits[] {
    return this.limitList;
  }

  get connected(): boolean {
    return this.up;
  }

  sessions(): SessionInfo[] {
    return this.list;
  }

  get(id: string): SessionInfo | undefined {
    return this.list.find((s) => s.id === id);
  }

  spawn(spec: SpawnSpec): Promise<SessionInfo> {
    return this.request({ op: 'spawn', spec }) as Promise<SessionInfo>;
  }

  closeSession(sessionId: string): Promise<CloseResult> {
    return this.request({ op: 'close', sessionId }, 30_000) as Promise<CloseResult>;
  }

  compose(sessionId: string, request: ComposeRequest): Promise<ComposeOutcome> {
    return this.request({ op: 'compose', sessionId, request }) as Promise<ComposeOutcome>;
  }

  /** Ends every session and the host. */
  shutdown(): Promise<{ closed: number }> {
    return this.request({ op: 'shutdown' }, 60_000) as Promise<{ closed: number }>;
  }

  /** A socket to one session's terminal on the host, for the web server to relay to a browser. */
  openTerminal(sessionId: string): WebSocket {
    const { port, token } = this.link.state;
    return new WebSocket(`ws://127.0.0.1:${port}/terminal?id=${encodeURIComponent(sessionId)}`, { headers: { authorization: `Bearer ${token}` } });
  }

  /** Disconnects; the host and its sessions keep running. */
  close(): void {
    this.closed = true;
    this.link.ws.close();
  }

  private request(body: RequestBody, timeoutMs = 20_000): Promise<unknown> {
    if (!this.up) return Promise.reject(new HostUnavailableError());
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HostUnavailableError());
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.link.ws.send(JSON.stringify({ id, ...body }));
    });
  }

  private bind(ws: WebSocket): void {
    ws.on('message', (raw) => {
      let message: HostMessage;
      try {
        message = JSON.parse(raw.toString()) as HostMessage;
      } catch {
        return;
      }
      if (message.type === 'sessions') {
        this.list = message.sessions;
        this.emit('change');
      } else if (message.type === 'limits') {
        this.limitList = message.limits;
        this.emit('limits');
      } else if (message.type === 'reply') {
        const waiting = this.pending.get(message.id);
        if (!waiting) return;
        this.pending.delete(message.id);
        clearTimeout(waiting.timer);
        if (message.ok) waiting.resolve(message.result);
        else waiting.reject(new HostRequestError(message.error, message.code));
      }
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      this.reconnect().catch(() => {});
    });
  }

  private async reconnect(): Promise<void> {
    this.up = false;
    for (const waiting of this.pending.values()) {
      clearTimeout(waiting.timer);
      waiting.reject(new HostUnavailableError());
    }
    this.pending.clear();
    if (this.closed) return;
    if (!isAlive(this.link.state.pid)) {
      this.list = [];
      this.emit('change');
    }
    let delay = 200;
    while (!this.closed) {
      await sleep(delay);
      delay = Math.min(delay * 2, 3000);
      const link = await findOrStart({ ...this.options, webToken: this.webToken }).catch(() => null);
      if (!link) continue;
      if (this.closed) {
        link.ws.close();
        return;
      }
      this.link = link;
      this.list = link.hello.sessions;
      this.limitList = link.hello.limits;
      this.up = true;
      this.bind(link.ws);
      this.emit('change');
      this.emit('limits');
      return;
    }
  }
}
