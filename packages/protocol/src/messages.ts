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
  | { type: 'delegations'; delegations: DelegationInfo[] };

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
