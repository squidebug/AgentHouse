// The read-only conversation view of a session, built from the CLI's
// transcript. Entries carry summaries; the full tool input and output are
// fetched when the user opens one (GET /api/sessions/:id/conversation/:entryId).

/** Tokens of one turn: every API call counted once (by message id). */
export interface TurnUsage {
  /** Input tokens not read from the cache. */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  /** Output tokens, thinking included. */
  output: number;
  /** API calls (assistant messages) in the turn. */
  calls: number;
}

export interface ConversationTurn {
  /** Position in the session's conversation, from 0, across /clear. */
  index: number;
  /** Which transcript it is in: 0 for the first, one more after each /clear. */
  segment: number;
  /** Epoch ms of its first and last record. */
  startedAt: number | null;
  endedAt: number | null;
  /** The model of its last API call. */
  model: string | null;
  effort: string | null;
  usage: TurnUsage;
  /** What Claude Code recorded as the turn's length, once it ended. */
  durationMs: number | null;
  interrupted: boolean;
}

export type ToolState = 'running' | 'done' | 'error' | 'denied' | 'interrupted';

export type NoticeKind = 'interrupted' | 'cleared' | 'compacted' | 'api_error';

interface EntryBase {
  /** Stable within the session; updates replace the entry with the same id. */
  id: string;
  turn: number;
  at: number | null;
}

export type ConversationEntry =
  /** What the user typed, a message another agent sent (`from`), or a prompt the CLI gave the session on a schedule (`scheduled`). */
  | (EntryBase & { kind: 'prompt'; text: string; images: number; from: string | null; truncated: boolean; scheduled?: true })
  | (EntryBase & { kind: 'text'; text: string; truncated: boolean })
  | (EntryBase & { kind: 'thinking'; chars: number })
  | (EntryBase & { kind: 'tool'; name: string; summary: string; state: ToolState })
  /** A sub-agent the model started (the Agent tool). One running in the background stays `running` until it reports back. */
  | (EntryBase & { kind: 'agent'; agentType: string | null; description: string; state: ToolState; agentId: string | null })
  /** A background sub-agent reported back (Claude's task notification); this starts a turn. */
  | (EntryBase & { kind: 'task'; agentId: string | null; description: string; state: ToolState; tokens: number | null; durationMs: number | null })
  /** A slash command typed into the CLI, with what it printed. */
  | (EntryBase & { kind: 'command'; name: string; args: string; output: string })
  | (EntryBase & { kind: 'notice'; notice: NoticeKind; text: string });

/** The full input and output of an entry, loaded when it is opened. */
export interface EntryDetail {
  /** Tool input as the model sent it; long strings are cut. */
  input?: unknown;
  /** Tool output, thinking, or the summary of a compacted conversation. */
  text?: string;
  /** Edit and Write results: the change as diff hunks. */
  patch?: Array<{ oldStart: number; newStart: number; lines: string[] }>;
  /** Something was cut to keep the page responsive. */
  truncated: boolean;
}

/**
 * What a session was last asked and what it last said to that, as a few plain
 * words: for a glance at many sessions (GET /api/sessions/:id/latest), read
 * from the end of its transcript when asked for.
 */
export interface LatestWords {
  /** The latest prompt (typed, handed over by another session, or given on a schedule), or the command the model answered. */
  prompt: string | null;
  /** When it was given (epoch ms): the turn it started may still go on. */
  promptAt: number | null;
  /** The latest the model said after it; null while it said nothing yet. */
  answer: string | null;
}

/** Server → browser on /ws/conversation. */
export type ConversationServerMessage =
  /** Everything known so far; sent first and whenever the view must start over. */
  | { type: 'reset'; turns: ConversationTurn[]; entries: ConversationEntry[] }
  /** New or changed turns and entries; replace by turn index and entry id. */
  | { type: 'update'; turns: ConversationTurn[]; entries: ConversationEntry[] };
