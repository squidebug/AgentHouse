import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { open } from 'node:fs/promises';
import { isAsking, type SessionStatus, type SessionTelemetry, type StatusValue } from '@agenthouse/protocol';
import { claudeConfigDir } from '../claude/settings';
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
import { sameSecret } from '../shared/compare';

// Claude's first hook (SessionStart) comes within a few seconds; none by then
// means hooks are blocked (e.g. by managed policy) and only the terminal is left.
const FIRST_HOOK_WAIT_MS = 30_000;

const BUSY = new Set<StatusValue>(['working', 'awaiting_permission', 'awaiting_input']);

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

/**
 * What a session's CLI reports about itself: its status and telemetry.
 * 'change' fires when either changes. This base reports nothing but that the
 * process runs (a CLI without hooks, such as Codex until M8, or the test double).
 */
export class Observer extends EventEmitter {
  status: SessionStatus;
  telemetry: SessionTelemetry = initialTelemetry();
  /** The CLI's own session id; Claude starts a new one on /clear. */
  vendorSessionId: string | null;

  constructor(vendorSessionId: string | null, status: SessionStatus = runningStatus()) {
    super();
    this.vendorSessionId = vendorSessionId;
    this.status = status;
  }

  /** Something the user sent to the CLI from a terminal. */
  typed(_data: string): void {}

  /** The process ended; nothing changes the status after this. */
  exited(code: number, at: number): void {
    this.status = exitedStatus(code, at);
  }

  protected setStatus(next: SessionStatus): void {
    if (next === this.status) return;
    this.status = next;
    this.emit('change');
  }
}

export interface ClaudeObserverOptions {
  /** Secret the session's hook relay presents. */
  token: string;
  vendorSessionId: string | null;
  /** How to run `claude agents --json`, which lists its sessions as idle, busy or waiting; null before 2.1.145. */
  agentsCommand: { file: string; args: string[] } | null;
  env: NodeJS.ProcessEnv;
  /** The CLI's process id, as `claude agents --json` lists it. */
  pid: number;
}

/** A Claude Code session, observed through the hooks and status line its relay passes on. */
export class ClaudeObserver extends Observer {
  private transcriptPath: string | null = null;
  private recheckPending = false;
  private done = false;
  private readonly hookWait: NodeJS.Timeout;

  constructor(private readonly options: ClaudeObserverOptions) {
    super(options.vendorSessionId, initialStatus());
    this.hookWait = setTimeout(() => {
      if (this.status.value === 'starting') this.setStatus(runningStatus());
    }, FIRST_HOOK_WAIT_MS);
    this.hookWait.unref();
  }

  /** True when a hook relay presents this session's token. */
  ownsHookToken(candidate: string): boolean {
    return sameSecret(candidate, this.options.token);
  }

  /** One hook event from the CLI's relay. */
  onHook(event: HookEvent): void {
    if (this.done) return;
    clearTimeout(this.hookWait);
    const transcript = event.transcript_path;
    if (typeof transcript === 'string' && isClaudeTranscript(transcript, claudeConfigDir(this.options.env))) {
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
    this.emit('change');
  }

  /** The CLI's status line input: model, effort, context use, cost. */
  onStatusLine(line: StatusLineInput): void {
    if (this.done) return;
    const next = applyStatusLine(this.telemetry, line);
    if (JSON.stringify(next) === JSON.stringify(this.telemetry)) return;
    this.telemetry = next;
    this.emit('change');
  }

  /** Esc or Ctrl+C during a turn, or any key on an open dialog, can end or resume the turn without a hook saying so. */
  typed(data: string): void {
    const cut = data === '\x1b' || data.includes('\x03');
    if ((cut && BUSY.has(this.status.value)) || isAsking(this.status.value)) this.recheckSoon();
  }

  exited(code: number, at: number): void {
    this.done = true;
    clearTimeout(this.hookWait);
    super.exited(code, at);
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
    const stale = () => this.done || this.status.at !== since || !BUSY.has(this.status.value);
    if (stale()) return;
    if (this.transcriptPath && endsWithInterrupt(await readTail(this.transcriptPath, 64 * 1024))) {
      if (!stale()) this.setStatus(interruptedStatus());
      return;
    }
    const command = this.options.agentsCommand;
    if (!command) return;
    const entries = await listAgents(command, this.options.env);
    const mine = entries?.find((e) => e.pid === this.options.pid || (this.vendorSessionId !== null && e.sessionId === this.vendorSessionId));
    if (mine && !stale()) this.setStatus(applyAgents(this.status, mine));
  }
}
