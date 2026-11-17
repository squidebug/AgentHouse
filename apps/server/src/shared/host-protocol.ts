import { createHmac } from 'node:crypto';
import type { AccountLimits, ComposeRequest, SessionInfo, SessionVendor, ThemeMode } from '@agenthouse/protocol';
import { sameSecret } from './compare';

/**
 * Web server ↔ session host. Bump when either side could misread the other:
 * a web server only talks to a host of its own protocol version. Two parts
 * stay the same in every version, so `--stop` can end a host of any version:
 * the hello's `protocol`, `pid` and `proof`, and the `shutdown` request.
 */
export const HOST_PROTOCOL = 8;

/**
 * Hosts from this protocol on are shown that a web server holds their token
 * without being sent it (`webProof`). An older one takes the token itself,
 * which is how `--stop` still reaches it.
 */
export const WEB_PROOF_SINCE = 8;

const proof = (token: string, side: 'host' | 'web', nonce: string) => createHmac('sha256', token).update(`agenthouse-${side}:${nonce}`).digest('base64url');

/**
 * The host's answer to a web server's nonce: it holds the token. A process
 * squatting on a dead host's port (left in a stale state file) cannot produce
 * it, so the web server adopts nothing from it and sends it nothing more.
 */
export function hostProof(token: string, nonce: string): string {
  return proof(token, 'host', nonce);
}

export function validHostProof(token: string, nonce: string, presented: unknown): boolean {
  return typeof presented === 'string' && sameSecret(presented, hostProof(token, nonce));
}

/**
 * What a web server presents on every connection to the host, with a nonce of
 * its own: it holds the token too. The token itself never goes over the
 * connection, so whatever listens on that port learns nothing it could prove
 * itself with, to this web server or to the next.
 */
export function webProof(token: string, nonce: string): string {
  return proof(token, 'web', nonce);
}

export function validWebProof(token: string, nonce: string, presented: unknown): boolean {
  return typeof presented === 'string' && sameSecret(presented, webProof(token, nonce));
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
  /** The session's id, chosen by the web server, which keeps it in its session registry. */
  id: string;
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
  | {
      type: 'hello';
      protocol: number;
      pid: number;
      proof: string;
      /** The host's code (hostBuildId) when it started. */
      build: string;
      webToken: string;
      sessions: SessionInfo[];
      limits: AccountLimits[];
    }
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
