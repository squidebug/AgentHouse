import type { ComposeRequest, SessionInfo, SessionVendor, ThemeMode } from '@agenthouse/protocol';

/**
 * Web server ↔ session host. Bump when either side could misread the other:
 * a web server only talks to a host of its own protocol version.
 */
export const HOST_PROTOCOL = 1;

/** Written by the host once it listens: how web servers find it and prove they may use it. */
export interface HostState {
  protocol: number;
  pid: number;
  port: number;
  token: string;
  startedAt: number;
}

/** One CLI to start. The web server has already resolved and validated everything in it. */
export interface SpawnSpec {
  vendor: SessionVendor;
  title: string;
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  theme: ThemeMode;
  model: string | null;
  effort: string | null;
  permissionMode: string | null;
  cliVersion: string | null;
  vendorSessionId: string | null;
  /** Temporary files the CLI reads while it runs (e.g. a settings file); removed when it ends. */
  tempPaths: string[];
}

export interface CloseResult {
  exited: boolean;
  stillAlive: boolean;
}

export interface ComposeOutcome {
  sent: boolean;
  submitted: boolean;
  reason?: string;
}

/** Web server → host on /control. /terminal carries the browser's terminal protocol unchanged. */
export type HostRequest =
  | { id: number; op: 'spawn'; spec: SpawnSpec }
  | { id: number; op: 'close'; sessionId: string }
  | { id: number; op: 'compose'; sessionId: string; request: ComposeRequest }
  | { id: number; op: 'shutdown' };

/** Host → web server on /control. */
export type HostMessage =
  | { type: 'hello'; protocol: number; pid: number; webToken: string; sessions: SessionInfo[] }
  | { type: 'sessions'; sessions: SessionInfo[] }
  | { type: 'reply'; id: number; ok: true; result: unknown }
  | { type: 'reply'; id: number; ok: false; error: string; code?: string };

/** The host understood the request and refused it (unknown session, spawn failure). */
export class HostRequestError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}
