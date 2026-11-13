// How the conversation view lays out a session's turns, kept free of React so
// it can be tested directly.
import type { ConversationEntry, ConversationTurn, DelegationInfo } from '@agenthouse/protocol';
import { t } from '../strings';

export type WorkEntry = Extract<ConversationEntry, { kind: 'tool' | 'thinking' }>;

/** A run of tool calls and thinking shows as one collapsed row; everything else stands on its own. */
export type Block = { kind: 'entry'; entry: ConversationEntry } | { kind: 'work'; id: string; entries: WorkEntry[] };

export interface TurnView {
  turn: ConversationTurn;
  blocks: Block[];
}

const isWork = (entry: ConversationEntry): entry is WorkEntry => entry.kind === 'tool' || entry.kind === 'thinking';

export function arrange(turns: ConversationTurn[], entries: ConversationEntry[]): TurnView[] {
  const views = new Map<number, TurnView>(turns.map((turn) => [turn.index, { turn, blocks: [] }]));
  for (const entry of entries) {
    const view = views.get(entry.turn);
    if (!view) continue;
    const last = view.blocks.at(-1);
    if (isWork(entry) && last?.kind === 'work') last.entries.push(entry);
    else if (isWork(entry)) view.blocks.push({ kind: 'work', id: entry.id, entries: [entry] });
    else view.blocks.push({ kind: 'entry', entry });
  }
  return [...views.values()].sort((a, b) => a.turn.index - b.turn.index);
}

export interface WorkSummary {
  tools: number;
  thinking: number;
  running: number;
  failed: number;
}

export function summarize(entries: WorkEntry[]): WorkSummary {
  const summary: WorkSummary = { tools: 0, thinking: 0, running: 0, failed: 0 };
  for (const entry of entries) {
    if (entry.kind === 'thinking') summary.thinking += 1;
    else {
      summary.tools += 1;
      if (entry.state === 'running') summary.running += 1;
      if (entry.state === 'error' || entry.state === 'denied') summary.failed += 1;
    }
  }
  return summary;
}

/** claude-opus-5-5 → Opus 5.5, claude-sonnet-4-20250514 → Sonnet 4; any other name as it is. */
export function modelName(id: string): string {
  const match = id.match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/);
  if (!match) return id;
  const [, family = '', major, minor] = match;
  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}${minor ? `.${minor}` : ''}`;
}

/** 950, 12K, 1.2M */
export function compactCount(n: number): string {
  // 999,999 rounds to 1000K: it is 1M by then.
  if (n >= 999_500) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1).replace(/\.0$/, '')}K`;
  return String(n);
}

/** 45초, 1분 23초, 1시간 5분 */
export function duration(ms: number): string {
  if (ms < 1000) return t.underSecond;
  const { hour, minute, second } = t.unit;
  const seconds = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h) return `${h}${hour} ${m}${minute}`;
  if (m) return s ? `${m}${minute} ${s}${second}` : `${m}${minute}`;
  return `${s}${second}`;
}

/**
 * Where each delegation card goes: after the last turn that had started when
 * the work was sent (the turn the handed-over answer came from), else after
 * the first. Key -1: there are no turns yet; the cards go at the end.
 */
export function delegationTurns(turns: ConversationTurn[], tasks: DelegationInfo[]): Map<number, DelegationInfo[]> {
  const placed = new Map<number, DelegationInfo[]>();
  const ordered = [...turns].sort((a, b) => a.index - b.index);
  for (const task of [...tasks].sort((a, b) => a.sentAt - b.sentAt)) {
    let at = ordered[0]?.index ?? -1;
    for (const turn of ordered) if (turn.startedAt !== null && turn.startedAt <= task.sentAt) at = turn.index;
    placed.set(at, [...(placed.get(at) ?? []), task]);
  }
  return placed;
}
