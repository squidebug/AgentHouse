import type { AccountLimits, DelegationInfo, SessionInfo, SessionLink, ThemeMode } from './session';

/** Browser → server on /ws/session */
export type TerminalClientMessage =
  | { type: 'input'; data: string; binary?: boolean }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'claim' }
  | { type: 'theme'; mode: ThemeMode };

/** Server → browser on /ws/session */
export type TerminalServerMessage =
  | { type: 'snapshot'; cols: number; rows: number; data: string }
  | { type: 'output'; data: string }
  | { type: 'size'; cols: number; rows: number }
  | { type: 'owner'; you: boolean }
  | { type: 'exit'; code: number; signal: number | null };

/** Server → browser on /ws/events */
export type EventServerMessage =
  | { type: 'sessions'; sessions: SessionInfo[] }
  | { type: 'limits'; limits: AccountLimits[] }
  | { type: 'links'; links: SessionLink[] }
  | { type: 'delegations'; delegations: DelegationInfo[] }
  /** Whether the sessions started outside AgentHouse are watched (the user's choice, kept by the server). */
  | { type: 'external'; on: boolean };

/** PUT /api/external: watch the sessions started outside AgentHouse, or stop. */
export interface ExternalRequest {
  on: boolean;
}

export interface ComposeRequest {
  text: string;
  enterDelayMs?: number;
  quietMs?: number;
  /** Only Enter: the text went in before and its Enter was held back (a dialog opened meanwhile). Web server only. */
  enterOnly?: boolean;
  /** Sent while nobody may be watching (a queued answer): the CLI itself is asked first whether it waits for the user. Web server only. */
  verify?: boolean;
}

export interface ComposeResult {
  sessionId: string;
  sent: boolean;
  submitted: boolean;
  /** Why nothing (or no Enter) was sent, e.g. `awaiting_permission`, `exited`. */
  reason?: string;
}

export interface ApiError {
  error: string;
  code?: string;
  command?: string;
}

/**
 * Logging in: the address the server prints and opens carries a one-time code,
 * which the page trades for a token of its own (POST /api/login). The page keeps
 * the token in its storage, which browsers keep apart per port, and sends it as
 * `Authorization: Bearer`; a cookie would also reach every other port of 127.0.0.1.
 */
export interface LoginRequest {
  code: string;
}

export interface LoginResult {
  token: string;
}

/** 401 codes: no valid token (log in again), or a login code that was used or ran out. */
export const AUTH_REQUIRED = 'AUTH_REQUIRED';
export const LOGIN_EXPIRED = 'LOGIN_EXPIRED';

/**
 * Browsers cannot put headers on a WebSocket, so the page sends its token as a
 * subprotocol (`ah-token.<token>`) next to `agenthouse`, the one the server picks:
 * it stays out of the address, like the Authorization header of a request.
 */
export const SOCKET_PROTOCOL = 'agenthouse';
export const TOKEN_PROTOCOL_PREFIX = 'ah-token.';
