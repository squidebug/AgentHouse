import type { AccountLimits, RateWindow, SessionStatus, SessionTelemetry, StatusValue } from '@agenthouse/protocol';

/** The fields of a Claude Code hook event that status tracking reads; everything else is dropped. */
export interface HookEvent {
  hook_event_name?: unknown;
  session_id?: unknown;
  transcript_path?: unknown;
  source?: unknown;
  tool_name?: unknown;
  notification_type?: unknown;
  error?: unknown;
  error_type?: unknown;
  agent_id?: unknown;
}

const text = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const number = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function status(value: StatusValue, at: number, extra: Partial<SessionStatus> = {}): SessionStatus {
  return { value, reason: null, tool: null, error: false, at, ...extra };
}

export const initialStatus = (at = Date.now()) => status('starting', at);
/** For a CLI that reports no turns: only that it runs. */
export const runningStatus = (at = Date.now()) => status('running', at);
export const initialTelemetry = (): SessionTelemetry => ({ level: 'minimal', model: null, effort: null, contextPct: null, contextWindow: null, costUsd: null });

// Tools that wait for the user instead of running.
const ASKING_TOOLS: Record<string, string> = { AskUserQuestion: 'question', ExitPlanMode: 'plan' };

/**
 * Status after one hook event (plan §7). Only confirmed signals move it; an
 * event this table does not know leaves it unchanged. Hook events can arrive
 * slightly out of order (they run async), which these rules tolerate: every
 * event states where the turn is, not how far it moved.
 */
export function applyHook(current: SessionStatus, event: HookEvent, at = Date.now()): SessionStatus {
  if (current.value === 'exited') return current;
  const tool = text(event.tool_name);
  switch (event.hook_event_name) {
    case 'SessionStart':
      return status('idle', at, { reason: event.source === 'clear' ? 'cleared' : null });
    case 'UserPromptSubmit':
      return status('working', at);
    case 'PreToolUse':
      if (tool && ASKING_TOOLS[tool]) return status('awaiting_input', at, { reason: ASKING_TOOLS[tool], tool });
      return status('working', at, { tool });
    case 'PermissionRequest':
      return status('awaiting_permission', at, { reason: tool, tool });
    case 'Notification':
      if (event.notification_type === 'permission_prompt') {
        return current.value === 'awaiting_permission' ? current : status('awaiting_permission', at, { reason: current.tool, tool: current.tool });
      }
      if (event.notification_type === 'elicitation_dialog') return status('awaiting_input', at, { reason: 'elicitation' });
      if (event.notification_type === 'idle_prompt') return current.value === 'idle' ? current : status('idle', at);
      return current;
    case 'PostToolUse':
    case 'PostToolUseFailure':
    case 'PermissionDenied':
      return status('working', at);
    case 'Stop':
      return status('idle', at);
    case 'StopFailure':
      return status('idle', at, { error: true, reason: text(event.error_type) ?? text(event.error) ?? 'error' });
    default:
      return current;
  }
}

/** Esc or Ctrl+C ended the turn. No hook reports this; the transcript does. */
export const interruptedStatus = (at = Date.now()) => status('idle', at, { reason: 'interrupted' });

/** One entry of `claude agents --json` (2.1.145+). */
export interface AgentsEntry {
  pid?: unknown;
  sessionId?: unknown;
  status?: unknown;
  waitingFor?: unknown;
}

/**
 * Status from `claude agents --json`, asked when no hook can tell: after a
 * dialog is answered or a turn is cut short in the terminal (denying with Esc
 * fires no hook either).
 */
export function applyAgents(current: SessionStatus, entry: AgentsEntry, at = Date.now()): SessionStatus {
  if (current.value === 'exited') return current;
  switch (entry.status) {
    case 'idle':
      return current.value === 'idle' ? current : status('idle', at);
    case 'busy':
      return current.value === 'working' ? current : status('working', at);
    case 'waiting': {
      const what = text(entry.waitingFor);
      const value: StatusValue = what && /permission/i.test(what) ? 'awaiting_permission' : 'awaiting_input';
      return current.value === value ? current : status(value, at, { reason: current.reason ?? what, tool: current.tool });
    }
    default:
      return current;
  }
}

export const exitedStatus = (code: number, at = Date.now()) => status('exited', at, { reason: code === 0 ? null : `exit ${code}`, error: code !== 0 });

/** The fields of Claude Code's status line input that AgentHouse reads. */
export interface StatusLineInput {
  model?: { display_name?: unknown; id?: unknown };
  effort?: { level?: unknown };
  context_window?: { used_percentage?: unknown; context_window_size?: unknown };
  cost?: { total_cost_usd?: unknown };
  rate_limits?: { five_hour?: RateLimitInput; seven_day?: RateLimitInput };
}
interface RateLimitInput {
  used_percentage?: unknown;
  resets_at?: unknown;
}

export function applyStatusLine(current: SessionTelemetry, line: StatusLineInput): SessionTelemetry {
  return {
    level: current.level,
    model: text(line.model?.display_name) ?? text(line.model?.id) ?? current.model,
    effort: text(line.effort?.level) ?? current.effort,
    // Null right after /clear and before the first reply: unknown, not zero.
    contextPct: number(line.context_window?.used_percentage),
    contextWindow: number(line.context_window?.context_window_size) ?? current.contextWindow,
    costUsd: number(line.cost?.total_cost_usd) ?? current.costUsd,
  };
}

function rateWindow(input: RateLimitInput | undefined): RateWindow | null {
  const usedPct = number(input?.used_percentage);
  if (usedPct === null) return null;
  const resetsAt = number(input?.resets_at);
  return { usedPct, resetsAt: resetsAt === null ? null : resetsAt * 1000 };
}

/** Plan usage windows from a status line, or null when it carries none (e.g. API key users). */
export function limitsFrom(line: StatusLineInput, at = Date.now()): Omit<AccountLimits, 'vendor'> | null {
  const fiveHour = rateWindow(line.rate_limits?.five_hour);
  const sevenDay = rateWindow(line.rate_limits?.seven_day);
  return fiveHour || sevenDay ? { fiveHour, sevenDay, at } : null;
}

/**
 * True when the newest user entry in this transcript tail is Claude's interrupt
 * marker, i.e. the running turn was just cut short. Older markers are followed
 * by newer user entries and do not count.
 */
export function endsWithInterrupt(tail: string): boolean {
  const lines = tail.split('\n').reverse();
  for (const line of lines) {
    if (!line.includes('"user"')) continue;
    let entry: { type?: unknown; message?: { role?: unknown; content?: unknown } };
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== 'user' && entry.message?.role !== 'user') continue;
    return JSON.stringify(entry.message?.content ?? '').includes('[Request interrupted by user');
  }
  return false;
}
