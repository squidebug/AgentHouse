import { EventEmitter } from 'node:events';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { SessionInfo, TranscriptSegment } from '@agenthouse/protocol';
import { listedSessions, listedStatus, type ListedSession } from '../claude/sessions';
import { initialTelemetry } from '../claude/status';
import { findTranscript, latestRun, transcriptFile, type LatestRun } from '../claude/transcript';
import { readTail, tailLines } from '../shared/tail';

/**
 * How often Claude Code is asked for its sessions while a page is open (the
 * user's choice). Each time starts the CLI once: about half a second, a third
 * of one of CPU (facts §2.8).
 */
export const EXTERNAL_EVERY_MS = 10_000;
// One answer missing (the CLI took too long, or is being updated) is no reason to take every card away.
const MISSES = 3;
// The end of a transcript: its latest answer is in it, but for a turn that wrote more than this since.
const TAIL_BYTES = 256 * 1024;
// A transcript that is not where its folder's name says is looked for in the other projects' folders:
// at once, then at every so many answers (a session nobody has asked anything has none anywhere).
const SEARCH_EVERY = 6;
// A session of AgentHouse's own that just ended may still be in Claude's list for a moment.
const JUST_ENDED_MS = 60_000;

/** A listed session that can be shown: it says which conversation it is in and where it runs. */
type Shown = ListedSession & { sessionId: string; cwd: string };

/**
 * A folder on another machine (\\host\share). A session there is left out: its notes would be read
 * from there, and Windows sends the user's credentials to such a host.
 */
const remote = (cwd: string) => /^(\\\\|\/\/)/.test(cwd);
const canShow = (entry: ListedSession): entry is Shown => entry.sessionId !== null && entry.cwd !== null && !remote(entry.cwd);

/** A file's size and time of change in one word, to tell whether it changed; null when it is not there. */
async function fileState(file: string): Promise<{ key: string; at: number } | null> {
  try {
    const info = await stat(file);
    return info.isFile() ? { key: `${info.size}:${info.mtimeMs}`, at: Math.round(info.mtimeMs) } : null;
  } catch {
    return null;
  }
}

/** The records in the end of a transcript, oldest first. */
async function tailRecords(file: string): Promise<unknown[]> {
  const tail = await readTail(file, TAIL_BYTES);
  const records: unknown[] = [];
  for (const line of tail ? tailLines(tail) : []) {
    try {
      records.push(JSON.parse(line.text));
    } catch {
      // a line still being written
    }
  }
  return records;
}

export interface ExternalOptions {
  /** Claude Code's list of sessions, parsed; null when there is none to have (no CLI, an older one, it failed). */
  ask: () => Promise<unknown>;
  /** The sessions AgentHouse runs itself: Claude lists them too. */
  own: () => SessionInfo[];
  /** Claude's config folder; the transcripts are under its projects folder. */
  configDir: string;
  everyMs?: number;
}

/** A session of the list, as shown, and what was read of its transcript. */
interface Watched {
  info: SessionInfo;
  /** The transcript of the conversation it is in has been seen on disk. */
  found: boolean;
  /** Answers since that transcript was last looked for in the other folders. */
  sinceSearch: number;
  /** The transcript's size and time when it was last read for what the session runs with. */
  read: string | null;
  run: LatestRun;
}

const NO_RUN: LatestRun = { model: null, effort: null, version: null };

/** The id AgentHouse knows it by: its process, and when it registered (a process id is used again). */
const idOf = (entry: Shown) => `x-${entry.pid}-${entry.startedAt ?? 0}`;

/**
 * The Claude Code sessions that run on this machine and AgentHouse did not
 * start (a terminal, an editor): found in Claude's own list, asked for while
 * someone looks, and shown read-only. Their state comes from the list; their
 * conversation, model and effort from their transcripts. 'change' fires when
 * what is shown of them changes.
 */
export class ExternalSessions extends EventEmitter {
  private sessions = new Map<string, Watched>();
  private shown = '[]';
  private timer: NodeJS.Timeout | undefined;
  private asking: Promise<void> | null = null;
  /** The answer asked for when watching started; a page waits for it before its first list. */
  private first: Promise<void> | null = null;
  /** Claude has answered since nothing was known: what is listed is what it said, not just empty. */
  private answered = false;
  private misses = 0;

  constructor(private readonly options: ExternalOptions) {
    super();
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((one) => one.info);
  }

  get(id: string): SessionInfo | undefined {
    return this.sessions.get(id)?.info;
  }

  /**
   * Asks from now on, at once and then at every interval, or stops asking.
   * What it knew stays as it was while nobody looks: a page that comes back
   * finds its panes, and the next answer puts right what changed meanwhile.
   */
  watch(on: boolean): void {
    if (on === Boolean(this.timer)) return;
    if (!on) {
      clearInterval(this.timer);
      this.timer = undefined;
      this.first = null;
      return;
    }
    this.first = this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.options.everyMs ?? EXTERNAL_EVERY_MS);
    this.timer.unref();
  }

  /**
   * Settles once Claude's first answer is in, or the time is up: a list sent before that has none
   * of them in it. At once when not watching, or when it has answered before (what is known then
   * may be a moment old, and the answer under way puts it right).
   */
  async ready(timeoutMs: number): Promise<void> {
    if (!this.first || this.answered) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([this.first, new Promise<void>((resolve) => (timer = setTimeout(resolve, timeoutMs)))]);
    clearTimeout(timer);
  }

  /** Forgets every session: the user turned watching off. */
  clear(): void {
    this.misses = 0;
    this.answered = false;
    this.set(new Map());
  }

  close(): void {
    this.watch(false);
    this.removeAllListeners();
  }

  /** Asks Claude once and takes its answer; a call still under way is not asked again. Never fails: what was known stays. */
  refresh(): Promise<void> {
    this.asking ??= this.ask()
      .catch(() => {})
      .finally(() => {
        this.asking = null;
      });
    return this.asking;
  }

  private async ask(): Promise<void> {
    const listed = listedSessions(await this.options.ask().catch(() => null));
    // Turned off while Claude was asked: nothing is taken any more.
    if (!this.timer) return;
    if (!listed) {
      this.misses += 1;
      if (this.misses >= MISSES) this.set(new Map());
      return;
    }
    this.misses = 0;
    const now = Date.now();
    const own = this.options.own();
    const mine = own.filter((s) => s.state === 'running' || (s.exit !== null && now - s.exit.at < JUST_ENDED_MS));
    const pids = new Set(mine.map((s) => s.pid));
    const conversations = new Set(mine.flatMap((s) => [s.vendorSessionId, ...s.transcripts.map((t) => t.vendorSessionId)]));
    const next = new Map<string, Watched>();
    for (const entry of listed) {
      if (!canShow(entry) || pids.has(entry.pid) || conversations.has(entry.sessionId)) continue;
      const id = idOf(entry);
      next.set(id, await this.describe(id, entry, this.sessions.get(id), now));
    }
    if (!this.timer) return;
    this.answered = true;
    this.set(next);
  }

  private set(next: Map<string, Watched>): void {
    this.sessions = next;
    const shown = JSON.stringify(this.list());
    if (shown === this.shown) return;
    this.shown = shown;
    this.emit('change');
  }

  /** A listed session as AgentHouse shows it, from what was known of it before and what its transcript says now. */
  private async describe(id: string, entry: Shown, before: Watched | undefined, now: number): Promise<Watched> {
    const { configDir } = this.options;
    let transcripts: TranscriptSegment[] = before?.info.transcripts ?? [];
    let found = before?.found ?? false;
    let sinceSearch = before?.sinceSearch ?? SEARCH_EVERY;
    let read = before?.read ?? null;
    let run = before?.run ?? NO_RUN;
    let current = transcripts.at(-1);
    if (current?.vendorSessionId !== entry.sessionId) {
      // A conversation it was not seen in before: its first, or the one after /clear. Its transcript is
      // written with the first prompt; until then this names where it is expected.
      current = { vendorSessionId: entry.sessionId, path: transcriptFile(configDir, entry.cwd, entry.sessionId), since: now };
      transcripts = [...transcripts, current];
      found = false;
      sinceSearch = SEARCH_EVERY;
      read = null;
      run = NO_RUN;
    }
    let file = await fileState(current.path);
    if (file) found = true;
    else if (!found && (sinceSearch += 1) > SEARCH_EVERY) {
      sinceSearch = 0;
      const elsewhere = await findTranscript(configDir, entry.sessionId);
      if (elsewhere) {
        current = { ...current, path: elsewhere };
        transcripts = [...transcripts.slice(0, -1), current];
        found = true;
        file = await fileState(elsewhere);
      }
    }
    if (file && file.key !== read) {
      read = file.key;
      const latest = latestRun(await tailRecords(current.path));
      // A turn that wrote more than the tail holds since its last answer keeps what was read before.
      if (latest.model) run = latest;
    }
    // How long it has been as it is: from when it was last written to when first seen, from now on a change.
    const status = listedStatus(entry, before?.info.status ?? null, before ? now : (file?.at ?? entry.startedAt ?? now));
    const info: SessionInfo = {
      id,
      vendor: 'claude',
      title: entry.name ?? (path.basename(entry.cwd) || entry.cwd),
      cwd: entry.cwd,
      model: run.model,
      effort: run.effort,
      permissionMode: null,
      cli: { file: '', version: run.version },
      vendorSessionId: entry.sessionId,
      pid: entry.pid,
      cols: 0,
      rows: 0,
      startedAt: entry.startedAt ?? before?.info.startedAt ?? now,
      state: 'running',
      exit: null,
      screen: false,
      status,
      telemetry: initialTelemetry(),
      transcripts,
      agents: [],
      tasks: [],
      schedules: [],
      invoked: [],
      external: true,
    };
    return { info, found, sinceSearch, read, run };
  }
}
