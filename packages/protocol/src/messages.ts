import type { SessionInfo, ThemeMode } from './session';

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
export type EventServerMessage = { type: 'sessions'; sessions: SessionInfo[] };

export interface ComposeRequest {
  text: string;
  bracketed?: boolean;
  enterDelayMs?: number;
  quietMs?: number;
  submit?: boolean;
}

export interface ComposeResult {
  sessionId: string;
  sent: boolean;
  submitted: boolean;
  reason?: string;
}

export interface ApiError {
  error: string;
  code?: string;
  command?: string;
}
