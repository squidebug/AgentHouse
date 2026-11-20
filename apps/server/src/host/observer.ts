import { EventEmitter } from 'node:events';
import { isAsking, type AgentInfo, type BackgroundTask, type ScheduledPrompt, type SessionStatus, type SessionTelemetry, type StatusValue, type TranscriptSegment } from '@agenthouse/protocol';
import { AgentTracker, agentTranscript, type AgentAsk } from '../claude/agents';
import { BackgroundTracker } from '../claude/background';
import { SHORT_ID } from '../claude/json';
import { askSessions, listedSessions, type ListedSession } from '../claude/sessions';
import { claudeConfigDir } from '../claude/settings';
import {
  applyAgents,
  applyHook,
  applyStatusLine,
  Dialogs,
  endsWithInterrupt,
  exitedStatus,
  initialStatus,
  initialTelemetry,
  interruptedStatus,
  isClaudeTranscript,
  unobservedStatus,
  type HookEvent,
  type StatusLineInput,
} from '../claude/status';
import { sameSecret } from '../shared/compare';
import { readTail } from '../shared/tail';

// Claude's first hook (SessionStart) comes within a few seconds; none by then
// means hooks are blocked (e.g. by managed policy) and only the terminal is left.
const FIRST_HOOK_WAIT_MS = 30_000;

const BUSY = new Set<StatusValue>(['working', 'awaiting_permission', 'awaiting_input']);

/**
 * The id of a conversation as a hook names it. Whatever holds the session's hook token can send a
 * payload, and the id goes to every browser and into sessions.json: only what is an id is kept.
 */
const conversationId = (value: unknown): string | null => (typeof value === 'string' && SHORT_ID.test(value) ? value : null);

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
  /** Where the CLI keeps the conversation, one entry per conversation (Claude: a new one after /clear). */
  transcripts: TranscriptSegment[] = [];

  /** The sub-agents the CLI started; none for a CLI that does not report them. */
  get agents(): AgentInfo[] {
    return [];
  }

  /** What the CLI left running in the background, what it scheduled, and the skills it ran; the same. */
  get tasks(): BackgroundTask[] {
    return [];
  }

  get schedules(): ScheduledPrompt[] {
    return [];
  }

  get invoked(): string[] {
    return [];
  }

  constructor(vendorSessionId: string | null, status: SessionStatus = unobservedStatus()) {
    super();
    this.vendorSessionId = vendorSessionId;
    this.status = status;
  }

  /** Something the user sent to the CLI from a terminal. */
  typed(_data: string): void {}

  /**
   * Whether text and Enter may go to the CLI now. Without hooks nothing tells
   * of a dialog, so only an exited CLI or a known dialog refuses.
   */
  acceptsInput(): boolean {
    return this.status.value !== 'exited' && !isAsking(this.status.value);
  }

  /** Asks the CLI itself whether it waits for the user, when it can tell: the status it waits in, else null. */
  async waiting(): Promise<StatusValue | null> {
    return null;
  }

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
  private recheckPending = false;
  private done = false;
  private readonly hookWait: NodeJS.Timeout;
  /**
   * What the main conversation is doing, from its own events. Sub-agents run
   * in the background, so their tool calls say nothing about it; only a dialog
   * one of them opens in the terminal shows in the session's status.
   */
  private main: SessionStatus;
  /** Dialogs of the main conversation, apart from `main`: a call ending next to one that asks must not hide it. */
  private readonly dialogs = new Dialogs();
  private readonly tracker: AgentTracker;
  private readonly background = new BackgroundTracker();
  private askShown: { ask: AgentAsk; status: SessionStatus } | null = null;

  constructor(private readonly options: ClaudeObserverOptions) {
    super(options.vendorSessionId, initialStatus());
    this.main = this.status;
    const configDir = claudeConfigDir(options.env);
    this.tracker = new AgentTracker(
      (id) => agentTranscript(this.transcripts.at(-1)?.path, id, configDir),
      (file) => isClaudeTranscript(file, configDir),
    );
    this.hookWait = setTimeout(() => {
      if (this.main.value === 'starting') this.setMain(unobservedStatus());
    }, FIRST_HOOK_WAIT_MS);
    this.hookWait.unref();
  }

  get agents(): AgentInfo[] {
    return this.tracker.list();
  }

  get tasks(): BackgroundTask[] {
    return this.background.list();
  }

  get schedules(): ScheduledPrompt[] {
    return this.background.schedules();
  }

  get invoked(): string[] {
    return this.background.invoked();
  }

  /** True when a hook relay presents this session's token. */
  ownsHookToken(candidate: string): boolean {
    return sameSecret(candidate, this.options.token);
  }

  /** One hook event from the CLI's relay. */
  onHook(event: HookEvent): void {
    if (this.done) return;
    clearTimeout(this.hookWait);
    const at = Date.now();
    let changed = this.noteTranscript(event);
    const named = conversationId(event.session_id);
    if (event.hook_event_name === 'SessionStart' && named !== null && named !== this.vendorSessionId) {
      this.vendorSessionId = named;
      changed = true;
    }
    if (this.telemetry.level !== 'full') {
      this.telemetry = { ...this.telemetry, level: 'full' };
      changed = true;
    }
    if (this.tracker.onHook(event, at)) changed = true;
    if (this.background.onHook(event, at)) changed = true;
    const fromAgent = typeof event.agent_id === 'string' && event.agent_id !== '';
    if (!fromAgent) {
      this.main = applyHook(this.main, event, at);
      this.dialogs.onHook(event, at);
    }
    const shown = this.shown();
    if (shown !== this.status) this.status = shown;
    else if (!changed) return;
    this.emit('change');
  }

  /**
   * Text and Enter go only to a session that has started (its first hook;
   * the folder trust question comes before any) and shows no dialog: they
   * would answer it.
   */
  acceptsInput(): boolean {
    return this.status.value === 'idle' || this.status.value === 'working';
  }

  /** `claude agents --json` on whether this session waits for the user; null when it does not or cannot tell. */
  async waiting(): Promise<StatusValue | null> {
    if (this.done) return null;
    const mine = await this.listed();
    if (mine?.status !== 'waiting') return null;
    return applyAgents(this.main, mine).value;
  }

  /** This session in Claude's own list, asked for now: by its process, or by the conversation it is in. Undefined when it is not there, or there is no list to ask for. */
  private async listed(): Promise<ListedSession | undefined> {
    const command = this.options.agentsCommand;
    if (!command) return undefined;
    const entries = listedSessions(await askSessions(command, this.options.env));
    return entries?.find((e) => e.pid === this.options.pid || (this.vendorSessionId !== null && e.sessionId === this.vendorSessionId));
  }

  /** The main conversation as it stands: a dialog it has open comes first. */
  private mainNow(): SessionStatus {
    return this.main.value === 'exited' ? this.main : (this.dialogs.current() ?? this.main);
  }

  /** The sub-agent status line's input: its tasks, with model and tokens. */
  onSubagentStatusLine(line: { tasks?: unknown }): void {
    if (this.done) return;
    if (this.tracker.onStatusLine(line.tasks)) this.emit('change');
  }

  /** The main conversation's status, unless a sub-agent's dialog waits for the user. */
  private shown(): SessionStatus {
    const main = this.mainNow();
    const ask = this.tracker.asking();
    if (!ask || isAsking(main.value) || main.value === 'exited') {
      this.askShown = null;
      return main;
    }
    if (this.askShown?.ask !== ask) {
      const value: StatusValue = ask.kind === 'permission' ? 'awaiting_permission' : 'awaiting_input';
      this.askShown = { ask, status: { value, reason: ask.tool, tool: ask.tool, error: false, at: ask.at } };
    }
    return this.askShown.status;
  }

  private setMain(next: SessionStatus): void {
    this.main = next;
    this.setStatus(this.shown());
  }

  /**
   * A conversation starts with SessionStart: at launch, after /clear (a new
   * file) and on /resume (another file). Only then does the transcript change;
   * a payload from a sub-agent context may name other files. The path is opened
   * later, so only Claude's own transcripts are taken.
   */
  private noteTranscript(event: HookEvent): boolean {
    const file = event.transcript_path;
    const last = this.transcripts.at(-1);
    if (typeof file !== 'string' || (last && (event.hook_event_name !== 'SessionStart' || last.path === file))) return false;
    if (!isClaudeTranscript(file, claudeConfigDir(this.options.env))) return false;
    const vendorSessionId = conversationId(event.session_id) ?? this.vendorSessionId;
    this.transcripts = [...this.transcripts, { vendorSessionId, path: file, since: Date.now() }];
    return true;
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
    this.tracker.stopAll(at);
    this.background.stopAll(at);
    super.exited(code, at);
    this.main = this.status;
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
    // A sub-agent's dialog is answered in that agent's transcript; the main one only tells about the main turn.
    const agentAsks = () => this.tracker.asking() !== null && !isAsking(this.mainNow().value);
    const transcript = this.transcripts.at(-1)?.path;
    if (!agentAsks() && transcript && endsWithInterrupt((await readTail(transcript, 64 * 1024))?.data.toString('utf8') ?? '')) {
      if (stale()) return;
      this.dialogs.clear();
      this.setMain(interruptedStatus());
      return;
    }
    const mine = await this.listed();
    if (!mine || stale()) return;
    if (agentAsks()) {
      // Waiting means the sub-agent's dialog, never the main conversation's: that is as it was.
      if (mine.status !== 'waiting') {
        this.tracker.clearAsks();
        this.setStatus(this.shown());
      }
      return;
    }
    // The CLI no longer waits: whatever dialog was open got its answer in the terminal.
    if (mine.status !== 'waiting') this.dialogs.clear();
    this.setMain(applyAgents(this.main, mine));
  }
}
