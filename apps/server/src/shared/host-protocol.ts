import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AccountLimits, ComposeRequest, SessionInfo, SessionVendor, ThemeMode } from '@agenthouse/protocol';

/**
 * Web server ↔ session host. Bump when either side could misread the other:
 * a web server only talks to a host of its own protocol version.
 */
export const HOST_PROTOCOL = 3;

/**
 * The host's answer to a web server's nonce. A process squatting on a dead
 * host's port (left in a stale state file) cannot produce it, so the web
 * server sends nothing to it and adopts nothing from it.
 */
export function hostProof(token: string, nonce: string): string {
  return createHmac('sha256', token).update(`agenthouse-host:${nonce}`).digest('base64url');
}

export function validHostProof(token: string, nonce: string, proof: unknown): boolean {
  if (typeof proof !== 'string') return false;
  const expected = Buffer.from(hostProof(token, nonce));
  const actual = Buffer.from(proof);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

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
  /** Secret the CLI's hook relay presents on /hook and /status; null when it has none. */
  hookToken: string | null;
  /** How to run `claude agents --json` for this CLI install; null when it has no such command. */
  agentsCommand: { file: string; args: string[] } | null;
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

/**
 * Host → web server on /control. Besides /control and /terminal (web server,
 * host token), the host takes POST /hook and /status from the CLIs' relays
 * (per-session hook token).
 */
export type HostMessage =
  | { type: 'hello'; protocol: number; pid: number; proof: string; webToken: string; sessions: SessionInfo[]; limits: AccountLimits[] }
  | { type: 'sessions'; sessions: SessionInfo[] }
  | { type: 'limits'; limits: AccountLimits[] }
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
