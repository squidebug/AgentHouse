// The flow of a session over time: a lane for the session, for each sub-agent
// it started (in the order the tree lists them) and for the sessions placed
// under it, with the stretches of time each worked. The tree beside it shows
// who is under whom; this shows when. Kept free of React so it can be tested
// directly.
import { isAsking, type AgentInfo, type ConversationTurn, type SessionInfo, type SessionLink } from '@agenthouse/protocol';
import { agentRows } from './agents';

export type BarKind = 'working' | 'waiting' | 'done';

export interface Bar {
  from: number;
  to: number;
  kind: BarKind;
}

export type FlowRow =
  | { key: string; kind: 'session'; depth: number; session: SessionInfo; link: SessionLink | null }
  | { key: string; kind: 'agent'; depth: number; session: SessionInfo; agent: AgentInfo };

export type FlowFilter = 'all' | 'running';

// The window shows at most this much of the past, and at least this much.
export const MAX_WINDOW_MS = 60 * 60_000;
const MIN_WINDOW_MS = 2 * 60_000;

const agentBusy = (agent: AgentInfo) => agent.state === 'running' || agent.asking;
const sessionBusy = (session: SessionInfo) => session.status.value === 'working' || isAsking(session.status.value);

/**
 * The session, then its sub-agents (nested as they started one another), then
 * the sessions placed under it with their own sub-agents. With `running`,
 * only what is busy now, and the rows above it.
 */
export function flowRows(session: SessionInfo, sessions: SessionInfo[], links: SessionLink[], filter: FlowFilter = 'all'): FlowRow[] {
  const rows: FlowRow[] = [];
  const add = (owner: SessionInfo, depth: number, link: SessionLink | null) => {
    rows.push({ key: owner.id, kind: 'session', depth, session: owner, link });
    for (const { agent, depth: level } of agentRows(owner.agents, true).rows) {
      rows.push({ key: `${owner.id}/${agent.id}`, kind: 'agent', depth: depth + level, session: owner, agent });
    }
  };
  add(session, 0, null);
  const byId = new Map(sessions.map((s) => [s.id, s]));
  for (const link of links) {
    const child = link.parentId === session.id ? byId.get(link.childId) : undefined;
    if (child) add(child, 1, link);
  }
  if (filter === 'all') return rows;
  // Keep what is busy and every row above it, so each shows where it belongs.
  const keep = new Set<number>();
  rows.forEach((row, i) => {
    const busy = row.kind === 'agent' ? agentBusy(row.agent) : sessionBusy(row.session);
    if (!busy) return;
    keep.add(i);
    let depth = row.depth;
    for (let j = i - 1; j >= 0 && depth > 0; j -= 1) {
      if (rows[j]!.depth < depth) {
        keep.add(j);
        depth = rows[j]!.depth;
      }
    }
  });
  return rows.filter((_, i) => keep.has(i));
}

/** A sub-agent ran from its start to its end, or until now. */
export function agentBars(agent: AgentInfo, now: number): Bar[] {
  const kind: BarKind = agent.asking ? 'waiting' : agent.state === 'running' ? 'working' : 'done';
  return [{ from: agent.startedAt, to: agent.endedAt ?? now, kind }];
}

/**
 * A session worked in its turns (from its transcript, when there is one):
 * the turns that ended show as done, the one going on as working or waiting.
 * Without turns, its status says since when it has been doing what it does.
 */
export function sessionBars(session: SessionInfo, turns: ConversationTurn[] | null, now: number): Bar[] {
  const busy: BarKind | null = isAsking(session.status.value) ? 'waiting' : session.status.value === 'working' ? 'working' : null;
  const timed = (turns ?? []).filter((t): t is ConversationTurn & { startedAt: number } => t.startedAt !== null).sort((a, b) => a.startedAt - b.startedAt);
  if (timed.length) {
    return timed.map((turn, i) => {
      const last = i === timed.length - 1;
      if (last && busy) return { from: turn.startedAt, to: now, kind: busy };
      return { from: turn.startedAt, to: Math.max(turn.endedAt ?? turn.startedAt, turn.startedAt), kind: 'done' };
    });
  }
  // Without turns, only work going on now has a known start: since its status changed.
  return busy ? [{ from: session.status.at, to: now, kind: busy }] : [];
}

export interface TimeWindow {
  from: number;
  to: number;
}

/** From the earliest bar to now, at least two minutes and at most an hour. */
export function timeWindow(bars: Bar[], now: number): TimeWindow {
  const earliest = bars.reduce((min, bar) => Math.min(min, bar.from), now);
  const from = Math.min(Math.max(earliest, now - MAX_WINDOW_MS), now - MIN_WINDOW_MS);
  return { from, to: now };
}

/** Where a bar sits in the window, in percent; a sliver at least, so a short one still shows. */
export function place(bar: Bar, window: TimeWindow): { left: number; width: number } | null {
  const span = window.to - window.from;
  const from = Math.max(bar.from, window.from);
  const to = Math.min(bar.to, window.to);
  if (to < window.from || from > window.to) return null;
  const left = ((from - window.from) / span) * 100;
  return { left, width: Math.max(((to - from) / span) * 100, 0.8) };
}

/**
 * Where a lane's name goes, in percent of the lane: from the start of its first
 * bar, or, when that bar is in the right half, ending where it ends.
 */
export function labelPlace(bars: Bar[], window: TimeWindow): { left: number } | { right: number } {
  const first = bars.map((bar) => place(bar, window)).find((at) => at !== null);
  if (!first) return { left: 0 };
  return first.left <= 50 ? { left: first.left } : { right: Math.max(0, 100 - first.left - first.width) };
}

/** A stretch of time, short: 45초, 1분 30초 (seconds under ten minutes), 12분, 1시간 5분. */
export function ago(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}초`;
  if (seconds < 600) return `${Math.floor(seconds / 60)}분${seconds % 60 ? ` ${seconds % 60}초` : ''}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}분`;
  return `${Math.floor(minutes / 60)}시간${minutes % 60 ? ` ${minutes % 60}분` : ''}`;
}

/** The axis: five marks from the start of the window to now. */
export function ticks(window: TimeWindow): Array<{ pct: number; ago: number }> {
  return [0, 25, 50, 75, 100].map((pct) => ({ pct, ago: ((window.to - window.from) * (100 - pct)) / 100 }));
}
