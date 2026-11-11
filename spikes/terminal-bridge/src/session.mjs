import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import pty from 'node-pty';
import { isAlive, killTree } from './kill-tree.mjs';
import { ColorQueryResponder, isAutoResponse } from './terminal-responses.mjs';

const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

// A viewer that falls this far behind stops receiving live output and is
// resynchronised from a snapshot instead; the PTY itself is never paused.
const MAX_BUFFERED = 4 * 1024 * 1024;
const RESYNC_BELOW = 256 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class Viewer {
  constructor(ws) {
    this.ws = ws;
    this.live = false;
    this.stale = false;
    this.pending = [];
  }

  send(message) {
    if (this.ws.readyState === this.ws.OPEN) this.ws.send(JSON.stringify(message));
  }

  output(data) {
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

/**
 * One CLI running in a PTY. Every byte it prints also goes into a headless
 * terminal on the server, which (1) answers the CLI's terminal queries and
 * (2) can be serialised so a browser that connects later sees the same screen.
 */
export class Session {
  constructor({ preset, file, args, cwd, env, cols = 120, rows = 32, colors, useConptyDll = false, onExit }) {
    this.id = randomUUID();
    this.preset = preset;
    this.file = file;
    this.args = args;
    this.cwd = cwd;
    this.cols = cols;
    this.rows = rows;
    this.startedAt = Date.now();
    this.exit = null;
    this.viewers = new Set();
    this.owner = null;
    this.lastOutputAt = 0;
    this.bytesThisSecond = 0;
    this.bytesPerSec = 0;
    this.droppedReplies = 0;
    this.onExitCallback = onExit;
    this.colors = new ColorQueryResponder(colors);

    this.mirror = new HeadlessTerminal({ cols, rows, scrollback: 5000, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.mirror.loadAddon(this.serializer);

    this.pty = pty.spawn(file, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
      useConptyDll,
    });
    this.pid = this.pty.pid;

    // The mirror is the only terminal allowed to answer queries. Color queries
    // are answered by ColorQueryResponder instead, with the browser's real colors.
    this.mirror.onData((reply) => {
      if (!this.colors.isColorReport(reply) && !this.exit) this.pty.write(reply);
    });
    this.pty.onData((data) => this.#handleOutput(data));
    this.pty.onExit(({ exitCode, signal }) => this.#handleExit(exitCode, signal));

    this.statsTimer = setInterval(() => this.#tick(), 1000);
  }

  #handleOutput(data) {
    try {
      this.mirror.write(data);
    } catch {
      // xterm discards input past ~50 MB of unparsed backlog; the live stream still flows.
    }
    for (const reply of this.colors.scan(data)) this.pty.write(reply);
    this.bytesThisSecond += Buffer.byteLength(data);
    this.lastOutputAt = Date.now();
    for (const viewer of this.viewers) viewer.output(data);
  }

  #handleExit(exitCode, signal) {
    this.exit = { exitCode, signal, at: Date.now() };
    clearInterval(this.statsTimer);
    this.#broadcast({ type: 'exit', exitCode, signal });
    this.onExitCallback?.(this);
  }

  #tick() {
    this.bytesPerSec = this.bytesThisSecond;
    this.bytesThisSecond = 0;
    for (const viewer of this.viewers) {
      if (viewer.stale && viewer.ws.bufferedAmount < RESYNC_BELOW) this.#sync(viewer);
    }
    this.#broadcast({ type: 'stats', ...this.stats() });
  }

  #broadcast(message) {
    for (const viewer of this.viewers) viewer.send(message);
  }

  /**
   * Sends the current screen, then live output. Output that arrives while the
   * mirror is still parsing is queued for this viewer, so nothing is lost or
   * shown twice between the snapshot and the stream.
   */
  #sync(viewer) {
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

  attach(ws) {
    const viewer = new Viewer(ws);
    this.viewers.add(viewer);
    this.#sync(viewer);
    if (this.exit) viewer.send({ type: 'exit', ...this.exit });
    return viewer;
  }

  detach(viewer) {
    this.viewers.delete(viewer);
    if (this.owner === viewer) this.owner = null;
    this.#announceOwner();
  }

  /** The focused view decides the PTY size; everyone else follows it. */
  claim(viewer) {
    this.owner = viewer;
    this.#announceOwner();
  }

  #announceOwner() {
    for (const viewer of this.viewers) viewer.send({ type: 'owner', you: viewer === this.owner });
  }

  resize(viewer, cols, rows) {
    if (viewer !== this.owner || this.exit) return;
    cols = Math.max(20, Math.min(500, Math.floor(cols)));
    rows = Math.max(5, Math.min(200, Math.floor(rows)));
    if (cols === this.cols && rows === this.rows) return;
    this.cols = cols;
    this.rows = rows;
    this.pty.resize(cols, rows);
    this.mirror.resize(cols, rows);
    this.#broadcast({ type: 'size', cols, rows });
  }

  input(data, { binary = false } = {}) {
    if (this.exit) return;
    if (isAutoResponse(data)) {
      this.droppedReplies += 1;
      return;
    }
    this.pty.write(binary ? Buffer.from(data, 'latin1') : data);
  }

  setColors(colors) {
    this.colors.setColors(colors);
  }

  async #waitForQuiet(quietMs, maxMs) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline && Date.now() - this.lastOutputAt < quietMs) await sleep(25);
  }

  /**
   * Composer input: paste the whole text, wait until the CLI has settled, then
   * press Enter. Some TUIs treat an Enter that follows a paste too closely as
   * part of the paste (a newline) instead of "submit".
   */
  async compose({ text, bracketed = true, enterDelayMs = 300, quietMs = 150, submit = true }) {
    if (this.exit) return { sent: false, reason: 'exited' };
    const payload = String(text).replace(/\r\n?|\n/g, '\r');
    this.pty.write(bracketed ? `\x1b[200~${payload}\x1b[201~` : payload);
    if (!submit) return { sent: true, submitted: false };
    await sleep(enterDelayMs);
    await this.#waitForQuiet(quietMs, 2000);
    if (this.exit) return { sent: true, submitted: false, reason: 'exited' };
    // TODO(M4): refuse to send Enter while the session is awaiting a permission or
    // selection dialog — Enter could pick "Yes". The spike has no status yet.
    this.pty.write('\r');
    return { sent: true, submitted: true };
  }

  async close() {
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
    return { exited: Boolean(this.exit), stillAlive: isAlive(this.pid) };
  }

  stats() {
    return {
      bytesPerSec: this.bytesPerSec,
      viewers: this.viewers.size,
      cols: this.cols,
      rows: this.rows,
      droppedReplies: this.droppedReplies,
    };
  }

  info() {
    return {
      id: this.id,
      preset: this.preset,
      file: this.file,
      args: this.args,
      cwd: this.cwd,
      pid: this.pid,
      startedAt: this.startedAt,
      exit: this.exit,
      ...this.stats(),
    };
  }
}
