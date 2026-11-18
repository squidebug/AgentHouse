import { readFileSync } from 'node:fs';
import path from 'node:path';
import { isAgentBusy, isTaskRunning, type SessionInfo } from '@agenthouse/protocol';
import { notSaved, writeFileAtomic } from '../shared/state';

const FILE_VERSION = 1;
// Ended sessions stay listed until removed; beyond this many the oldest go.
const MAX_ENDED = 50;
const SAVE_DELAY_MS = 1000;

export const registryFile = (stateDir: string) => path.join(stateDir, 'sessions.json');

/** A session the host no longer has: ended, with no screen left, everything else as last seen. */
function asEnded(info: SessionInfo): SessionInfo {
  if (info.state === 'exited' && !info.screen) return info;
  const at = info.exit?.at ?? info.status.at;
  return {
    ...info,
    state: 'exited',
    screen: false,
    exit: info.exit ?? { code: null, signal: null, at },
    status: info.status.value === 'exited' ? info.status : { value: 'exited', reason: null, tool: null, error: false, at },
    // Whatever still ran ended with the session, and what it had scheduled went with its process.
    agents: info.agents.map((a) => (isAgentBusy(a) ? { ...a, state: 'stopped', endedAt: a.endedAt ?? at, tool: null, asking: false } : a)),
    tasks: info.tasks.map((task) => (isTaskRunning(task) ? { ...task, state: 'stopped', endedAt: task.endedAt ?? at } : task)),
    schedules: [],
  };
}

/** An entry as it is kept: one written before sub-agents or background work were tracked has none. */
function withDefaults(entry: SessionInfo): SessionInfo {
  const list = <T>(value: T[] | undefined): T[] => (Array.isArray(value) ? value : []);
  return { ...entry, agents: list(entry.agents), tasks: list(entry.tasks), schedules: list(entry.schedules), invoked: list(entry.invoked) };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
/** A list of things, which an entry from before they were tracked does not have. */
const things = (value: unknown): boolean => value === undefined || (Array.isArray(value) && value.every(isObject));

/**
 * Whether a saved entry has what is read of it without a check, here and in the
 * page: its status and since when, when it ended, what it ran with, where its
 * transcripts are, the things that ran in it. The file is this server's own, but
 * one edited by hand or cut short must cost that entry, not the server's start.
 */
function isEntry(value: unknown): value is SessionInfo {
  if (!isObject(value)) return false;
  const { status, exit, transcripts } = value;
  return (
    typeof value.id === 'string' &&
    typeof value.vendor === 'string' &&
    typeof value.title === 'string' &&
    typeof value.cwd === 'string' &&
    typeof value.startedAt === 'number' &&
    isObject(status) &&
    typeof status.value === 'string' &&
    typeof status.at === 'number' &&
    (exit === null || (isObject(exit) && typeof exit.at === 'number')) &&
    isObject(value.cli) &&
    isObject(value.telemetry) &&
    Array.isArray(transcripts) &&
    transcripts.every((segment) => isObject(segment) && typeof segment.path === 'string') &&
    things(value.agents) &&
    things(value.tasks) &&
    things(value.schedules)
  );
}

/**
 * The sessions of this state folder, kept by the web server in sessions.json
 * so they outlive the session host. A session the host no longer lists has
 * ended (the host restarted, or another web server removed it) and stays
 * listed, with its transcripts, until the user removes it.
 */
export class SessionRegistry {
  private readonly sessions = new Map<string, SessionInfo>();
  private saveTimer: NodeJS.Timeout | undefined;
  private saved = '';

  constructor(private readonly file: string) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown; sessions?: unknown };
      if (data.version === FILE_VERSION && Array.isArray(data.sessions)) {
        for (const entry of data.sessions) if (isEntry(entry)) this.sessions.set(entry.id, withDefaults(entry));
      }
    } catch {
      // none yet, or unreadable: start over
    }
    this.saved = this.serialize();
  }

  /** The host's current list. Sessions missing from it have ended. */
  record(live: SessionInfo[]): void {
    const ids = new Set(live.map((s) => s.id));
    for (const info of live) this.sessions.set(info.id, info);
    for (const [id, info] of this.sessions) if (!ids.has(id)) this.sessions.set(id, asEnded(info));
    const ended = [...this.sessions.values()].filter((s) => !ids.has(s.id)).sort((a, b) => (b.exit?.at ?? 0) - (a.exit?.at ?? 0));
    for (const old of ended.slice(MAX_ENDED)) this.sessions.delete(old.id);
    this.saveSoon();
  }

  /** Ended sessions the host no longer has, oldest first. */
  past(live: SessionInfo[]): SessionInfo[] {
    const ids = new Set(live.map((s) => s.id));
    return [...this.sessions.values()].filter((s) => !ids.has(s.id)).sort((a, b) => a.startedAt - b.startedAt);
  }

  get(id: string): SessionInfo | undefined {
    return this.sessions.get(id);
  }

  remove(id: string): void {
    if (this.sessions.delete(id)) this.saveSoon();
  }

  /** Writes what is pending now (the web server is closing). */
  flush(): void {
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.save();
  }

  private serialize(): string {
    return JSON.stringify({ version: FILE_VERSION, sessions: [...this.sessions.values()] });
  }

  private saveSoon(): void {
    this.saveTimer ??= setTimeout(() => {
      this.saveTimer = undefined;
      this.save();
    }, SAVE_DELAY_MS);
  }

  private save(): void {
    const text = this.serialize();
    if (text === this.saved) return;
    try {
      writeFileAtomic(this.file, text);
      this.saved = text;
    } catch (error) {
      // Kept in memory; the next change tries again.
      notSaved(this.file, error);
    }
  }
}
