import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import pty, { type IPty } from 'node-pty';
import type { WebSocket } from 'ws';
import {
  ColorQueryResponder,
  isAutoResponse,
  type ComposeRequest,
  type SessionExit,
  type SessionInfo,
  type SessionStatus,
  type SessionVendor,
  type TerminalColors,
  type TerminalServerMessage,
} from '@agenthouse/protocol';
import type { ComposeOutcome } from '../shared/host-protocol';
import { isAlive, killTree } from '../shared/kill-tree';
import type { Observer } from './observer';

const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = require('@xterm/headless') as typeof import('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize') as typeof import('@xterm/addon-serialize');

/** How far a viewer may fall behind before it stops receiving live output, and when it is resynchronised from a snapshot. */
export interface ViewerBacklog {
  max: number;
  resyncBelow: number;
}

// The PTY itself is never paused for a slow viewer.
export const DEFAULT_BACKLOG: ViewerBacklog = { max: 4 * 1024 * 1024, resyncBelow: 256 * 1024 };
// node-pty flushes the last output for up to 1 s after the process exits.
const RELEASE_AFTER_EXIT_MS = 1500;
// What a browser gets of the scrollback when it connects, and what is kept of an ended session.
const SNAPSHOT_SCROLLBACK = 2000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// C0 and C1 control characters but tab and line breaks, and DEL.
const CONTROL = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x9F]/g;

/**
 * Text as it goes into a bracketed paste. Control characters are dropped: an
 * ESC could end the paste early (the rest would arrive as keys: Enter, Shift+Tab,
 * `!`), and others act as keys on their own (Ctrl+U, Ctrl+C). The text may be
 * another agent's answer. Line breaks become the Enter a terminal would send.
 */
export function pasteText(text: string): string {
  return text.replace(CONTROL, '').replace(/\r\n?|\n/g, '\r');
}

export class Viewer {
  live = false;
  stale = false;
  pending: string[] = [];

  constructor(
    readonly ws: WebSocket,
    private readonly maxBuffered = DEFAULT_BACKLOG.max,
  ) {}

  send(message: TerminalServerMessage): void {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(message));
  }

  output(data: string): void {
    if (!this.live) {
      this.pending.push(data);
      return;
    }
    if (this.stale) return;
    if (this.ws.bufferedAmount > this.maxBuffered) {
      this.stale = true;
      return;
    }
    this.send({ type: 'output', data });
  }
}

export interface SessionOptions {
  /** Chosen by the web server, which keeps it in its session registry. */
  id: string;
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
  /** What reports the CLI's status, made once its process id is known. */
  observe: (pid: number) => Observer;
  backlog?: ViewerBacklog;
  cleanup: () => Promise<void>;
}

/**
 * One CLI running in a PTY. Every byte it prints also goes into a headless
 * terminal on the server, which (1) answers the CLI's terminal queries and
 * (2) can be serialised so a browser that connects later sees the same screen.
 * What the CLI is doing comes from its observer; 'status' fires when that changes.
 */
export class Session extends EventEmitter {
  readonly id: string;
  readonly startedAt = Date.now();
  readonly pid: number;
  readonly observer: Observer;
  cols: number;
  rows: number;
  /** The host always knows how its own CLIs ended. */
  exit: (SessionExit & { code: number }) | null = null;
  lastOutputAt = 0;

  private readonly viewers = new Set<Viewer>();
  private owner: Viewer | null = null;
  private readonly colors: ColorQueryResponder;
  private readonly mirror: InstanceType<typeof HeadlessTerminal>;
  private readonly serializer: InstanceType<typeof SerializeAddon>;
  private readonly pty: IPty;
  private readonly resyncTimer: NodeJS.Timeout;
  private readonly backlog: ViewerBacklog;
  private composing: Promise<unknown> = Promise.resolve();
  /** The last screen of an ended CLI, as text: the mirror itself (megabytes of scrollback) is let go. */
  private final: Extract<TerminalServerMessage, { type: 'snapshot' }> | null = null;

  constructor(private readonly options: SessionOptions) {
    super();
    this.id = options.id;
    this.cols = options.cols;
    this.rows = options.rows;
    this.backlog = options.backlog ?? DEFAULT_BACKLOG;
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
    this.observer = options.observe(this.pid);
    this.observer.on('change', () => this.emit('status', this));

    // The mirror is the only terminal allowed to answer queries. Color queries
    // are answered by ColorQueryResponder instead, with the browser's real colors.
    this.mirror.onData((reply) => {
      if (!this.colors.isColorReport(reply) && !this.exit) this.pty.write(reply);
    });
    this.pty.onData((data) => this.handleOutput(data));
    this.pty.onExit(({ exitCode, signal }) => this.handleExit(exitCode, signal ?? null));
    this.resyncTimer = setInterval(() => this.resyncStaleViewers(), 1000);
  }

  get status(): SessionStatus {
    return this.observer.status;
  }

  private handleOutput(data: string): void {
    if (this.final) return;
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
    this.observer.exited(code, this.exit.at);
    clearInterval(this.resyncTimer);
    this.broadcast({ type: 'exit', code, signal });
    this.options.cleanup().catch(() => {});
    setTimeout(() => {
      if (process.platform === 'win32') this.releasePty();
      this.freeze();
    }, RELEASE_AFTER_EXIT_MS).unref();
    this.emit('exit', this);
  }

  /**
   * The CLI has ended and printed its last. An ended session stays listed until
   * the user removes it, and its mirror holds several megabytes of scrollback:
   * the screen is kept as the text a browser would be sent, and the mirror goes.
   */
  private freeze(): void {
    this.mirror.write('', () => {
      this.final = { type: 'snapshot', cols: this.mirror.cols, rows: this.mirror.rows, data: this.serializer.serialize({ scrollback: SNAPSHOT_SCROLLBACK }) };
      this.mirror.dispose();
    });
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
      if (viewer.stale && viewer.ws.bufferedAmount < this.backlog.resyncBelow) this.sync(viewer);
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
    if (this.final) {
      viewer.send(this.final);
      viewer.live = true;
      return;
    }
    this.mirror.write('', () => {
      viewer.send({
        type: 'snapshot',
        cols: this.mirror.cols,
        rows: this.mirror.rows,
        data: this.serializer.serialize({ scrollback: SNAPSHOT_SCROLLBACK }),
      });
      for (const chunk of viewer.pending) viewer.send({ type: 'output', data: chunk });
      viewer.pending = [];
      viewer.live = true;
    });
  }

  attach(ws: WebSocket): Viewer {
    const viewer = new Viewer(ws, this.backlog.max);
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
    this.observer.typed(data);
    return true;
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
   * part of the paste (a newline) instead of "submit". One text at a time per
   * session, so two never interleave and each sees the status the last one left.
   */
  compose(request: ComposeRequest): Promise<ComposeOutcome> {
    const outcome = this.composing.then(() => this.composeNow(request));
    this.composing = outcome.catch(() => undefined);
    return outcome;
  }

  private async composeNow({ text, enterDelayMs = 150, quietMs = 120, enterOnly = false, verify = false }: ComposeRequest): Promise<ComposeOutcome> {
    // `sent`: the text is in the CLI's input. With enterOnly it went in before.
    const held = (reason: string): ComposeOutcome => ({ sent: enterOnly, submitted: false, reason });
    if (this.exit) return held('exited');
    // A dialog is open, or the CLI has not started (Claude's folder trust question): text and Enter would answer it.
    if (!this.observer.acceptsInput()) return held(this.status.value);
    if (verify) {
      // Nobody may be watching: the CLI itself is asked as well, in case a dialog opened unreported.
      const waiting = await this.observer.waiting();
      if (waiting) return held(waiting);
      if (this.exit) return held('exited');
      if (!this.observer.acceptsInput()) return held(this.status.value);
    }
    if (!enterOnly) {
      this.pty.write(`\x1b[200~${pasteText(text)}\x1b[201~`);
      await sleep(enterDelayMs);
      await this.waitForQuiet(quietMs, 2000);
      // Checked again right before Enter: a dialog may have opened meanwhile.
      if (this.exit) return { sent: true, submitted: false, reason: 'exited' };
      if (!this.observer.acceptsInput()) return { sent: true, submitted: false, reason: this.status.value };
    }
    this.pty.write('\r');
    return { sent: true, submitted: true };
  }

  /**
   * Ends the session the way a user would first (Ctrl+C: the first interrupts a
   * running turn, the next ones quit), so the CLI can save its state; only if it
   * is still running after that is its process tree killed.
   */
  async close(): Promise<{ exited: boolean; stillAlive: boolean }> {
    if (!this.exit && this.options.vendor !== 'fake') {
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
      vendorSessionId: this.observer.vendorSessionId,
      pid: this.pid,
      cols: this.cols,
      rows: this.rows,
      startedAt: this.startedAt,
      state: this.exit ? 'exited' : 'running',
      exit: this.exit,
      screen: true,
      status: this.observer.status,
      telemetry: this.observer.telemetry,
      transcripts: this.observer.transcripts,
      agents: this.observer.agents,
    };
  }
}
