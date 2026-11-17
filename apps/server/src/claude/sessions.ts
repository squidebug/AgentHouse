// The sessions Claude Code lists itself (`claude agents --json`, 2.1.145+):
// every session of the user's that runs on this machine, whoever started it.
// The web server reads the list to show the ones AgentHouse did not start
// (facts §2.8). It says who they are and whether they are idle, busy or waiting;
// the rest comes from each one's transcript.
import path from 'node:path';
import type { SessionStatus } from '@agenthouse/protocol';

/** A session as Claude Code lists it. */
export interface ListedSession {
  pid: number;
  /** The id of the conversation it is in, a new one after /clear. Its transcript is named after it. */
  sessionId: string;
  cwd: string;
  /** What the user or Claude called it. */
  name: string | null;
  /** When it registered with Claude Code (epoch ms): once its folder is trusted. */
  startedAt: number | null;
  /** `idle`, `busy` or `waiting`. */
  status: string | null;
  /** What it waits for, in Claude's words (`permission prompt`). */
  waitingFor: string | null;
}

// A name, a state: short by nature. The list is whatever the session files in Claude's folder say,
// and any program of the user's can write one.
const TEXT_CHARS = 200;
const PATH_CHARS = 1024;
const text = (value: unknown, limit = TEXT_CHARS): string | null => (typeof value === 'string' && value ? value.slice(0, limit) : null);
// The id names a file: nothing but a UUID is taken for one.
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The sessions of Claude's list that can be shown; null when what it printed is
 * no list. A folder on another machine (\\host\share) is left out: its notes
 * would be read from there, and Windows sends the user's credentials to such a host.
 */
export function listedSessions(parsed: unknown): ListedSession[] | null {
  if (!Array.isArray(parsed)) return null;
  const sessions: ListedSession[] = [];
  for (const item of parsed as Array<Record<string, unknown> | null>) {
    const pid = item?.pid;
    const sessionId = item?.sessionId;
    const cwd = item?.cwd;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) continue;
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) continue;
    if (typeof cwd !== 'string' || cwd.length > PATH_CHARS || /^(\\\\|\/\/)/.test(cwd) || !path.isAbsolute(cwd)) continue;
    const startedAt = item?.startedAt;
    sessions.push({
      pid,
      sessionId: sessionId.toLowerCase(),
      cwd: path.normalize(cwd),
      name: text(item?.name),
      startedAt: typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt > 0 ? startedAt : null,
      status: text(item?.status),
      waitingFor: text(item?.waitingFor),
    });
  }
  return sessions;
}

/**
 * What a listed session is doing. Nothing says which tool it runs or waits
 * with. `before` is kept, with its time, while it still says the same.
 */
export function listedStatus(entry: Pick<ListedSession, 'status' | 'waitingFor'>, before: SessionStatus | null, at: number): SessionStatus {
  const waitsForApproval = entry.status === 'waiting' && /permission/i.test(entry.waitingFor ?? '');
  const value = entry.status === 'idle' ? 'idle' : entry.status === 'busy' ? 'working' : waitsForApproval ? 'awaiting_permission' : entry.status === 'waiting' ? 'awaiting_input' : 'unobserved';
  // An approval needs no more words; anything else it waits for is said as Claude says it.
  const reason = value === 'awaiting_input' ? entry.waitingFor : null;
  if (before?.value === value && before.reason === reason) return before;
  return { value, reason, tool: null, error: false, at };
}

/** Claude's folder for a project's transcripts and memory: every character of its path that is no letter or digit becomes a dash. */
export const projectDir = (configDir: string, cwd: string): string => path.join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));

/** Where the transcript of a conversation is, by the name of its project's folder. */
export const transcriptFile = (configDir: string, cwd: string, sessionId: string): string => path.join(projectDir(configDir, cwd), `${sessionId}.jsonl`);
