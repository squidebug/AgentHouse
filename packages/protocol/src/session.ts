export type Vendor = 'claude' | 'codex';

/** `fake` is a test double that exists only when the server runs with --allow-fake. */
export type SessionVendor = Vendor | 'fake';

export const VENDOR_NAMES: Record<SessionVendor, string> = { claude: 'Claude Code', codex: 'Codex CLI', fake: 'fake-agent' };

export type ThemeMode = 'light' | 'dark';

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh'] as const;
export const CLAUDE_PERMISSION_MODES = ['plan', 'acceptEdits', 'auto', 'manual'] as const;
export const CLAUDE_MODEL_ALIASES = ['fable', 'opus', 'sonnet', 'haiku'] as const;

export interface LaunchOptions {
  vendor: SessionVendor;
  title?: string;
  cwd?: string;
  model?: string;
  effort?: string;
  permissionMode?: string;
  cols?: number;
  rows?: number;
  theme?: ThemeMode;
}

export interface SessionExit {
  /** null: unknown, the session host ended while the CLI ran. */
  code: number | null;
  signal: number | null;
  at: number;
}

/** `unobserved`: the process runs but reports no turns (no hooks: Codex until M8, hooks blocked by policy). */
export type StatusValue = 'starting' | 'unobserved' | 'idle' | 'working' | 'awaiting_permission' | 'awaiting_input' | 'exited';

/**
 * Waiting for the user: an approval, or the answer to a question. Text and
 * Enter typed now would answer the dialog, so nothing is sent to such a session.
 * Takes a status value or a compose result's reason.
 */
export function isAsking(value: string | null | undefined): boolean {
  return value === 'awaiting_permission' || value === 'awaiting_input';
}

/**
 * A compose result's reason when the session could not take the text yet: a
 * dialog is open, a Claude session has not started (its folder trust question
 * may be up), or someone is typing in its terminal (`typing`: only text sent
 * while nobody may be watching waits for that). The text can go again later.
 */
export function isHeld(reason: string | null | undefined): boolean {
  return isAsking(reason) || reason === 'starting' || reason === 'unobserved' || reason === 'typing';
}

/** What the agent is doing, from confirmed signals only (hooks, the process exiting). */
export interface SessionStatus {
  value: StatusValue;
  /** Short reason: the tool waiting for approval, `interrupted`, `cleared`, an error kind. */
  reason: string | null;
  /** The tool running right now, when known. */
  tool: string | null;
  /** The last turn ended with an error (e.g. a rate limit). */
  error: boolean;
  at: number;
}

/** Live numbers from the CLI's status line. */
export interface SessionTelemetry {
  /** `full` once the CLI's hooks report in; `minimal` before that or for CLIs without them. */
  level: 'full' | 'minimal';
  model: string | null;
  /** The effort the CLI actually applies. */
  effort: string | null;
  contextPct: number | null;
  contextWindow: number | null;
  /** API-priced cost of the session so far; secondary for subscription users. */
  costUsd: number | null;
}

export interface RateWindow {
  usedPct: number;
  /** Epoch milliseconds. */
  resetsAt: number | null;
}

/** Plan usage of one vendor account: the latest any of its sessions reported. */
export interface AccountLimits {
  vendor: Vendor;
  fiveHour: RateWindow | null;
  sevenDay: RateWindow | null;
  at: number;
}

/** One conversation of a session in the CLI's own transcript file. Claude Code starts a new one on /clear. */
export interface TranscriptSegment {
  /** The CLI's session id for this conversation. */
  vendorSessionId: string | null;
  path: string;
  /** When AgentHouse first saw it (epoch ms). */
  since: number;
}

/**
 * A sub-agent the CLI started (Claude Code: the Agent tool), as its hooks and
 * sub-agent status line report it. Claude runs them in the background: the
 * main conversation can be idle while they work.
 */
export interface AgentInfo {
  /** The CLI's id for it (Claude: the `agent-<id>.jsonl` transcript). */
  id: string;
  /** The agent that started it; null when the session's main conversation did. */
  parentId: string | null;
  /** Its kind, e.g. Explore or general-purpose. */
  agentType: string;
  /** What it was asked to do, in a few words (the Agent tool's description). */
  description: string | null;
  /** `stopped`: its turn ended. It may be resumed, and its own sub-agents may still run. */
  state: 'running' | 'stopped';
  /** The tool it runs now, or the one waiting for the user. */
  tool: string | null;
  /** One of its tools waits for an approval or an answer in the terminal. */
  asking: boolean;
  model: string | null;
  /** Tokens it has used, as the CLI counts them. */
  tokens: number | null;
  startedAt: number;
  endedAt: number | null;
  /** Its own transcript (under Claude's projects folder), once known. */
  transcriptPath: string | null;
}

/** Working, or waiting for the user with one of its tools: not done. */
export const isAgentBusy = (agent: Pick<AgentInfo, 'state' | 'asking'>): boolean => agent.state === 'running' || agent.asking;

/**
 * A session placed under another in the tree. `group` only shows it there;
 * `delegate` also lets the parent hand it work. One level: a parent
 * is never under another session itself.
 */
export type LinkKind = 'group' | 'delegate';

export interface SessionLink {
  childId: string;
  parentId: string;
  kind: LinkKind;
}

/**
 * Work a session handed to the session delegated under it: the text was sent
 * to the child, and its answer goes back to the parent when the user says so.
 * The answer itself stays in the child's transcript; only where it is is kept.
 */
export interface DelegationInfo {
  id: string;
  parentId: string;
  childId: string;
  sentAt: number;
  /** `done`: the child is idle again with no sub-agent running; `failed`: it ended or the turn failed. */
  status: 'running' | 'done' | 'interrupted' | 'failed';
  endedAt: number | null;
  /** The first line of the child's answer, once done. */
  summary: string | null;
  /** The answer handed to the parent: `queued` waits until the parent is idle (never into a dialog). */
  delivery: 'none' | 'queued' | 'sent' | 'failed';
  deliveredAt: number | null;
}

export interface SessionInfo {
  id: string;
  vendor: SessionVendor;
  title: string;
  cwd: string;
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  cli: { file: string; version: string | null };
  /** The CLI's own session id when AgentHouse could choose it up front (Claude `--session-id`). */
  vendorSessionId: string | null;
  pid: number;
  cols: number;
  rows: number;
  startedAt: number;
  state: 'running' | 'exited';
  exit: SessionExit | null;
  /** The session host still has its terminal: it runs, or it ended while that host stayed up. */
  screen: boolean;
  status: SessionStatus;
  telemetry: SessionTelemetry;
  /** The transcripts this session wrote, oldest first; empty when the CLI reports none. */
  transcripts: TranscriptSegment[];
  /** Its sub-agents in the order they started, nested through parentId; the CLI's internal helpers are left out. */
  agents: AgentInfo[];
}

export interface CliInstall {
  file: string;
  args: string[];
  /** As found or given: the PATH entry (an npm shim) or the file the user chose. */
  shim: string;
  version: string | null;
  /** Found through PATH; the first such is the one the user's shell runs. */
  onPath: boolean;
}

export interface CliStatus {
  vendor: Vendor;
  /** Those on PATH in PATH order, then the one the user chose if it is not among them. */
  installs: CliInstall[];
  /** Index into `installs` of the one AgentHouse launches: the one the user chose, else the one the user's shell runs. Null when there is none, or the chosen one cannot run. */
  selected: number | null;
  loggedIn: boolean | null;
  /** The executable the user chose for this CLI (in the environment check), or null to follow PATH. */
  chosen: string | null;
  /** Why the chosen executable cannot run (gone, not a program): nothing launches until it is chosen again. */
  chosenError?: string;
}

/** PUT /api/cli/:vendor: the executable to run for this CLI, or null for the one the user's shell runs. */
export interface ChooseCliRequest {
  path: string | null;
}

export type EnvLevel = 'error' | 'warn' | 'info';

export interface EnvMessage {
  id: string;
  level: EnvLevel;
  text: string;
  command?: string;
}

export interface EnvReport {
  node: { version: string; major: number; supported: boolean; eol: boolean };
  platform: string;
  windowsBuild: number | null;
  defaultCwd: string;
  clis: Record<Vendor, CliStatus>;
  messages: EnvMessage[];
}
