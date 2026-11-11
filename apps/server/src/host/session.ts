import { execFile } from 'node:child_process';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import pty, { type IPty } from 'node-pty';
import type { WebSocket } from 'ws';
import {
  ColorQueryResponder,
  isAutoResponse,
  type ComposeRequest,
  type SessionExit,
  type SessionInfo,
  type SessionStatus,
  type SessionTelemetry,
  type SessionVendor,
  type TerminalColors,
  type TerminalServerMessage,
} from '@agenthouse/protocol';
import { isAlive, killTree } from '../shared/kill-tree';
import {
  applyAgents,
  applyHook,
  applyStatusLine,
  endsWithInterrupt,
  exitedStatus,
  initialStatus,
  initialTelemetry,
  interruptedStatus,
  isClaudeTranscript,
  runningStatus,
  type AgentsEntry,
  type HookEvent,
  type StatusLineInput,
} from '../claude/status';

const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = require('@xterm/headless') as typeof import('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize');

// A viewer that falls this far behind stops receiving live output and is
// resynchronised from a snapshot instead; the PTY itself is never paused.
const MAX_BUFFERED = 4 * 1024 * 1024;
const RESYNC_BELOW = 256 * 1024;
// node-pty flushes the last output for up to 1 s after the process exits.
const RELEASE_AFTER_EXIT_MS = 1500;
// Claude's first hook (SessionStart) comes within a few seconds; none by then
// means hooks are blocked (e.g. by managed policy) and only the terminal is left.
const FIRST_HOOK_WAIT_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// States in which Enter would answer a dialog instead of sending a prompt.
const ASKING = new Set<SessionStatus['value']>(['awaiting_permission', 'awaiting_input']);
const BUSY = new Set<SessionStatus['value']>(['working', 'awaiting_permission', 'awaiting_input']);

/** `claude agents --json`; null if it fails (older CLI, timeout). Each call starts the CLI once. */
function listAgents(command: { file: string; args: string[] }, env: NodeJS.ProcessEnv): Promise<AgentsEntry[] | null> {
  return new Promise((resolve) => {
    execFile(command.file, command.args, { env, timeout: 8000, windowsHide: true, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        const parsed: unknown = JSON.parse(stdout);
        resolve(Array.isArray(parsed) ? (parsed as AgentsEntry[]) : null);
      } catch {
        resolve(null);
      }
    });
  });
}

async function readTail(file: string, bytes: number): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

export class Viewer {
  live = false;
  stale = false;
  pending: string[] = [];

  constructor(readonly ws: WebSocket) {}

  send(message: TerminalServerMessage): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(message));
  }

  output(data: string): void {
    if (!this.live) {
      this.pending.push(data);
      return;
    }
    if (this.stale) return;
    if (this.ws.bufferedAmount > MAX_BUFFERED) {
      this.stale = true;
      return;
    }
    this.send({ type: 'output', data });
  }
}

export interface SessionOptions {
  vendor: SessionVendor;
  title: string;
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
  colors: TerminalColors;
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  cliVersion: string | null;
  vendorSessionId: string | null;
  /** Secret the CLI's hook relay presents; null when the CLI reports nothing. */
  hookToken: string | null;
  /** How to run `claude agents --json`, which lists its sessions as idle, busy or waiting. */
  agentsCommand: { file: string; args: string[] } | null;
  cleanup: () => Promise<void>;
}

/**
 * One CLI running in a PTY. Every byte it prints also goes into a headless
 * terminal on the server, which (1) answers the CLI's terminal queries and
 * (2) can be serialised so a browser that connects later sees the same screen.
 */
export class Session extends EventEmitter {
  readonly id = randomUUID();
  readonly startedAt = Date.now();
  readonly pid: number;
  cols: number;
  rows: number;
  exit: SessionExit | null = null;
  lastOutputAt = 0;
  status: SessionStatus = initialStatus();
  telemetry: SessionTelemetry = initialTelemetry();
  /** Changes on /clear, when the CLI starts a new conversation. */
  vendorSessionId: string | null;
  private transcriptPath: string | null = null;
  private recheckPending = false;
  private hookWait: NodeJS.Timeout | undefined;

  private readonly viewers = new Set<Viewer>();
  private owner: Viewer | null = null;
  private readonly colors: ColorQueryResponder;
  private readonly mirror: InstanceType<typeof HeadlessTerminal>;
  private readonly serializer: InstanceType<typeof SerializeAddon>;
  private readonly pty: IPty;
  private readonly resyncTimer: NodeJS.Timeout;

  constructor(private readonly options: SessionOptions) {
    super();
    this.vendorSessionId = options.vendorSessionId;
    if (options.hookToken) {
      this.hookWait = setTimeout(() => {
        if (this.status.value === 'starting') this.setStatus(runningStatus());
      }, FIRST_HOOK_WAIT_MS);
      this.hookWait.unref();
    } else {
      this.status = runningStatus();
    }
    this.cols = options.cols;
    this.rows = options.rows;
    this.colors = new ColorQueryResponder(options.colors);
    this.mirror = new HeadlessTerminal({ cols: this.cols, rows: this.rows, scrollback: 5000, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.mirror.loadAddon(this.serializer);

    this.pty = pty.spawn(options.file, options.args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: options.cwd,
      env: options.env as Record<string, string>,
    });
    this.pid = this.pty.pid;

    // The mirror is the only terminal allowed to answer queries. Color queries
    // are answered by ColorQueryResponder instead, with the browser's real colors.
    this.mirror.onData((reply) => {
      if (!this.colors.isColorReport(reply) && !this.exit) this.pty.write(reply);
    });
    this.pty.onData((data) => this.handleOutput(data));
    this.pty.onExit(({ exitCode, signal }) => this.handleExit(exitCode, signal ?? null));
    this.resyncTimer = setInterval(() => this.resyncStaleViewers(), 1000);
  }

  private handleOutput(data: string): void {
    try {
      this.mirror.write(data);
    } catch {
      // xterm discards input past ~50 MB of unparsed backlog; the live stream still flows.
    }
    for (const reply of this.colors.scan(data)) this.pty.write(reply);
    this.lastOutputAt = Date.now();
    for (const viewer of this.viewers) viewer.output(data);
  }

  private handleExit(code: number, signal: number | null): void {
    this.exit = { code, signal, at: Date.now() };
    this.status = exitedStatus(code, this.exit.at);
    clearTimeout(this.hookWait);
    clearInterval(this.resyncTimer);
    this.broadcast({ type: 'exit', code, signal });
    this.options.cleanup().catch(() => {});
    if (process.platform === 'win32') setTimeout(() => this.releasePty(), RELEASE_AFTER_EXIT_MS);
    this.emit('exit', this);
  }

  /**
   * node-pty (Windows, built-in ConPTY) frees the pseudoconsole handle and its
   * output worker thread only in kill(); after a natural exit they stay open,
   * leak per session and keep Node alive. kill() would also fork a helper to list
   * the console's processes, which fails noisily once they are gone, so that
   * step is skipped: the process tree has already ended.
   */
  private releasePty(): void {
    const agent = (this.pty as unknown as { _agent?: { _getConsoleProcessList?: () => Promise<number[]> } })._agent;
    if (agent && typeof agent._getConsoleProcessList === 'function') agent._getConsoleProcessList = () => Promise.resolve([]);
    try {
      this.pty.kill();
    } catch {
      // already released
    }
  }

  private resyncStaleViewers(): void {
    for (const viewer of this.viewers) {
      if (viewer.stale && viewer.ws.bufferedAmount < RESYNC_BELOW) this.sync(viewer);
    }
  }

  private broadcast(message: TerminalServerMessage): void {
    for (const viewer of this.viewers) viewer.send(message);
  }

  /**
   * Sends the current screen, then live output. Output that arrives while the
   * mirror is still parsing is queued for this viewer, so nothing is lost or
   * shown twice between the snapshot and the stream.
   */
  private sync(viewer: Viewer): void {
    viewer.live = false;
    viewer.stale = false;
    viewer.pending = [];
    this.mirror.write('', () => {
      viewer.send({
        type: 'snapshot',
        cols: this.mirror.cols,
        rows: this.mirror.rows,
        data: this.serializer.serialize({ scrollback: 2000 }),
      });
      for (const chunk of viewer.pending) viewer.send({ type: 'output', data: chunk });
      viewer.pending = [];
      viewer.live = true;
    });
  }

  attach(ws: WebSocket): Viewer {
    const viewer = new Viewer(ws);
    this.viewers.add(viewer);
    this.sync(viewer);
    if (this.exit) viewer.send({ type: 'exit', code: this.exit.code, signal: this.exit.signal });
    return viewer;
  }

  detach(viewer: Viewer): void {
    this.viewers.delete(viewer);
    if (this.owner === viewer) this.owner = null;
    this.announceOwner();
  }

  /** The focused view decides the PTY size; everyone else follows it. */
  claim(viewer: Viewer): void {
    this.owner = viewer;
    this.announceOwner();
  }

  private announceOwner(): void {
    for (const viewer of this.viewers) viewer.send({ type: 'owner', you: viewer === this.owner });
  }

  resize(viewer: Viewer, cols: number, rows: number): void {
    if (viewer !== this.owner || this.exit) return;
    const nextCols = Math.max(20, Math.min(500, Math.floor(cols)));
    const nextRows = Math.max(5, Math.min(200, Math.floor(rows)));
    if (nextCols === this.cols && nextRows === this.rows) return;
    this.cols = nextCols;
    this.rows = nextRows;
    this.pty.resize(nextCols, nextRows);
    this.mirror.resize(nextCols, nextRows);
    this.broadcast({ type: 'size', cols: nextCols, rows: nextRows });
  }

  input(data: string, binary = false): boolean {
    if (this.exit) return false;
    // xterm.js in the browser answers terminal queries too; the mirror already did.
    if (isAutoResponse(data)) return false;
    this.pty.write(binary ? Buffer.from(data, 'latin1') : data);
    // Esc or Ctrl+C during a turn, or any key on an open dialog, can end or
    // resume the turn without a hook saying so.
    const cut = data === '\x1b' || data.includes('\x03');
    if ((cut && BUSY.has(this.status.value)) || ASKING.has(this.status.value)) this.recheckSoon();
    return true;
  }

  get vendor(): SessionVendor {
    return this.options.vendor;
  }

  /** True when a hook relay presents this session's token. */
  ownsHookToken(candidate: string): boolean {
    const token = this.options.hookToken;
    if (!token) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private setStatus(next: SessionStatus): void {
    if (next === this.status) return;
    this.status = next;
    this.emit('status', this);
  }

  /** One hook event from the CLI's relay. */
  onHook(event: HookEvent): void {
    if (this.exit) return;
    clearTimeout(this.hookWait);
    const transcript = event.transcript_path;
    if (typeof transcript === 'string' && isClaudeTranscript(transcript, this.options.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'))) {
      this.transcriptPath = transcript;
    }
    let changed = false;
    if (event.hook_event_name === 'SessionStart' && typeof event.session_id === 'string' && event.session_id !== this.vendorSessionId) {
      this.vendorSessionId = event.session_id;
      changed = true;
    }
    if (this.telemetry.level !== 'full') {
      this.telemetry = { ...this.telemetry, level: 'full' };
      changed = true;
    }
    const next = applyHook(this.status, event);
    if (next !== this.status) this.status = next;
    else if (!changed) return;
    this.emit('status', this);
  }

  /** The CLI's status line input: model, effort, context use, cost. */
  onStatusLine(line: StatusLineInput): void {
    if (this.exit) return;
    const next = applyStatusLine(this.telemetry, line);
    if (JSON.stringify(next) === JSON.stringify(this.telemetry)) return;
    this.telemetry = next;
    this.emit('status', this);
  }

  /**
   * No hook fires when a turn is interrupted (Esc, Ctrl+C) or a permission is
   * denied with Esc. Claude then writes an interrupt marker to the transcript,
   * and `claude agents --json` shows the session idle. Esc may also just close a
   * menu, so these decide, not the key. A newer hook event wins over a recheck.
   */
  private recheckSoon(): void {
    if (this.recheckPending) return;
    this.recheckPending = true;
    const since = this.status.at;
    setTimeout(() => {
      this.recheck(since)
        .catch(() => {})
        .finally(() => {
          this.recheckPending = false;
        });
    }, 1000).unref();
  }

  private async recheck(since: number): Promise<void> {
    const stale = () => this.exit || this.status.at !== since || !BUSY.has(this.status.value);
    if (stale()) return;
    if (this.transcriptPath && endsWithInterrupt(await readTail(this.transcriptPath, 64 * 1024))) {
      if (!stale()) this.setStatus(interruptedStatus());
      return;
    }
    const command = this.options.agentsCommand;
    if (!command) return;
    const entries = await listAgents(command, this.options.env);
    const mine = entries?.find((e) => e.pid === this.pid || (this.vendorSessionId !== null && e.sessionId === this.vendorSessionId));
    if (mine && !stale()) this.setStatus(applyAgents(this.status, mine));
  }

  setColors(colors: TerminalColors): void {
    this.colors.setColors(colors);
  }

  private async waitForQuiet(quietMs: number, maxMs: number): Promise<void> {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline && Date.now() - this.lastOutputAt < quietMs) await sleep(25);
  }

  /**
   * Composer input: paste the whole text, wait until the CLI has settled, then
   * press Enter. Some TUIs treat an Enter that follows a paste too closely as
   * part of the paste (a newline) instead of "submit".
   */
  async compose({ text, bracketed = true, enterDelayMs = 150, quietMs = 120, submit = true }: ComposeRequest) {
    if (this.exit) return { sent: false, submitted: false, reason: 'exited' };
    // A permission or question dialog is open: typed text and Enter would answer it.
    if (ASKING.has(this.status.value)) return { sent: false, submitted: false, reason: this.status.value };
    const payload = text.replace(/\r\n?|\n/g, '\r');
    this.pty.write(bracketed ? `\x1b[200~${payload}\x1b[201~` : payload);
    if (!submit) return { sent: true, submitted: false };
    await sleep(enterDelayMs);
    await this.waitForQuiet(quietMs, 2000);
    if (this.exit) return { sent: true, submitted: false, reason: 'exited' };
    // Checked again right before Enter: a dialog may have opened meanwhile.
    if (ASKING.has(this.status.value)) return { sent: true, submitted: false, reason: this.status.value };
    this.pty.write('\r');
    return { sent: true, submitted: true };
  }

  /**
   * Ends the session the way a user would first (Ctrl+C: the first interrupts a
   * running turn, the next ones quit), so the CLI can save its state; only if it
   * is still running after that is its process tree killed.
   */
  async close({ graceful = true } = {}): Promise<{ exited: boolean; stillAlive: boolean }> {
    if (!this.exit && graceful && this.options.vendor !== 'fake') {
      for (let i = 0; i < 3 && !this.exit; i += 1) {
        this.pty.write('\x03');
        const deadline = Date.now() + 700;
        while (!this.exit && Date.now() < deadline) await sleep(50);
      }
      const deadline = Date.now() + 1500;
      while (!this.exit && Date.now() < deadline) await sleep(50);
    }
    if (!this.exit) {
      await killTree(this.pid);
      const deadline = Date.now() + 3000;
      while (!this.exit && Date.now() < deadline) await sleep(50);
      // Only if taskkill could not end it: node-pty's own kill attaches to the
      // console to list its processes, which fails (noisily) once they are gone.
      if (!this.exit) {
        try {
          this.pty.kill();
        } catch {
          // already gone
        }
      }
    }
    clearInterval(this.resyncTimer);
    return { exited: Boolean(this.exit), stillAlive: isAlive(this.pid) };
  }

  info(): SessionInfo {
    const o = this.options;
    return {
      id: this.id,
      vendor: o.vendor,
      title: o.title,
      cwd: o.cwd,
      model: o.model,
      effort: o.effort,
      permissionMode: o.permissionMode,
      cli: { file: o.file, version: o.cliVersion },
      vendorSessionId: this.vendorSessionId,
      pid: this.pid,
      cols: this.cols,
      rows: this.rows,
      startedAt: this.startedAt,
      state: this.exit ? 'exited' : 'running',
      exit: this.exit,
      status: this.status,
      telemetry: this.telemetry,
    };
  }
}
