// The sessions Claude Code lists itself (`claude agents --json`, 2.1.145+):
// every session of the user's that runs on this machine, whoever started it,
// and whether it is idle, busy or waiting. The session host asks for it when no
// hook can tell what its own session is doing; the web server reads it to show
// the ones AgentHouse did not start (facts §2.2, §2.8).
import { execFile } from 'node:child_process';
import path from 'node:path';
import { isAsking, type SessionStatus, type StatusValue } from '@agenthouse/protocol';
import { text } from './json';

const ASK_TIMEOUT_MS = 8000;

/** `claude agents --json` (or what stands in for it), parsed; null when it fails or prints something else. Each call starts the CLI once. */
export function askSessions(command: { file: string; args: string[] }, env: NodeJS.ProcessEnv): Promise<unknown> {
  return new Promise((resolve) => {
    execFile(command.file, command.args, { env, timeout: ASK_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        resolve(JSON.parse(stdout));
      } catch {
        resolve(null);
      }
    });
  });
}

/** A session as Claude Code lists it. What an entry does not say, or says in a way that cannot be used, is null. */
export interface ListedSession {
  pid: number;
  /** The id of the conversation it is in, a new one after /clear. Its transcript is named after it. */
  sessionId: string | null;
  cwd: string | null;
  /** What the user or Claude called it. */
  name: string | null;
  /** When it registered with Claude Code (epoch ms): once its folder is trusted. */
  startedAt: number | null;
  /** `idle`, `busy` or `waiting`. */
  status: string | null;
  /** What it waits for, in Claude's words (`permission prompt`). */
  waitingFor: string | null;
}

/** The part of an entry that says what its session is doing. */
export type ListedState = Pick<ListedSession, 'status'> & { waitingFor?: string | null };

// The list is whatever the session files in Claude's folder say, and any program of the user's can write one.
const PATH_CHARS = 1024;
/** The id of a conversation names a file: nothing but a UUID is taken for one. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The entries of Claude's list that say whose they are (a process id); null when what it printed is no list. */
export function listedSessions(parsed: unknown): ListedSession[] | null {
  if (!Array.isArray(parsed)) return null;
  const sessions: ListedSession[] = [];
  for (const item of parsed as Array<Record<string, unknown> | null>) {
    const pid = item?.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) continue;
    const sessionId = item?.sessionId;
    const cwd = item?.cwd;
    const startedAt = item?.startedAt;
    sessions.push({
      pid,
      sessionId: typeof sessionId === 'string' && SESSION_ID.test(sessionId) ? sessionId : null,
      cwd: typeof cwd === 'string' && cwd.length <= PATH_CHARS && path.isAbsolute(cwd) ? path.normalize(cwd) : null,
      name: text(item?.name),
      startedAt: typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt > 0 ? startedAt : null,
      status: text(item?.status),
      waitingFor: text(item?.waitingFor),
    });
  }
  return sessions;
}

/** What a listed session is doing, as AgentHouse calls it; null for a word of Claude's it does not know. */
export function listedActivity(entry: ListedState): Extract<StatusValue, 'idle' | 'working' | 'awaiting_permission' | 'awaiting_input'> | null {
  if (entry.status === 'idle') return 'idle';
  if (entry.status === 'busy') return 'working';
  if (entry.status !== 'waiting') return null;
  return /permission/i.test(entry.waitingFor ?? '') ? 'awaiting_permission' : 'awaiting_input';
}

/**
 * The status of a session of which the list is all that is known. Nothing
 * says which tool it runs or waits with. `before` is kept, with its time,
 * while it still says the same.
 */
export function listedStatus(entry: ListedState, before: SessionStatus | null, at: number): SessionStatus {
  const value = listedActivity(entry) ?? 'unobserved';
  // An approval needs no more words; anything else it waits for is said as Claude says it.
  const reason = isAsking(value) && value !== 'awaiting_permission' ? (entry.waitingFor ?? null) : null;
  if (before?.value === value && before.reason === reason) return before;
  return { value, reason, tool: null, error: false, at };
}

/** Claude's folder for a project's transcripts and memory: every character of its path that is no letter or digit becomes a dash. */
export const projectDir = (configDir: string, cwd: string): string => path.join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));

/** Where the transcript of a conversation is, by the name of its project's folder. */
export const transcriptFile = (configDir: string, cwd: string, sessionId: string): string => path.join(projectDir(configDir, cwd), `${sessionId}.jsonl`);
