export type Vendor = 'claude' | 'codex';

/** `fake` is a test double that exists only when the server runs with --allow-fake. */
export type SessionVendor = Vendor | 'fake';

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
  code: number;
  signal: number | null;
  at: number;
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
}

export interface CliInstall {
  file: string;
  args: string[];
  shim: string;
  version: string | null;
}

export interface CliStatus {
  vendor: Vendor;
  installs: CliInstall[];
  /** Index into `installs` of the one AgentHouse launches: the one the user's shell runs. */
  selected: number | null;
  loggedIn: boolean | null;
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
