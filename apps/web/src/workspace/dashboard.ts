// The dashboard: every session as a card, in the place of what it is doing,
// with what runs inside it. Kept free of React so it can be tested directly.
import { isAgentBusy, isAsking, isTaskRunning, type AgentInfo, type BackgroundTask, type ScheduledPrompt, type SessionInfo } from '@agenthouse/protocol';
import { t } from '../strings';
import { agentRows } from './agents';

/** What the page shows under its top bar: the tree and the panes, or over them the dashboard, the graph or the plan's usage. */
export type Screen = 'workspace' | 'dashboard' | 'graph' | 'usage';
export const SCREENS: readonly Screen[] = ['workspace', 'dashboard', 'graph', 'usage'];

const SCREEN_KEY = 'ah-screen';

/** The screen this browser showed last, so a reload shows it again. */
export function loadScreen(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): Screen {
  try {
    const kept = storage?.getItem(SCREEN_KEY);
    return SCREENS.find((screen) => screen === kept) ?? 'workspace';
  } catch {
    return 'workspace';
  }
}

export function saveScreen(screen: Screen, storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined = globalThis.localStorage): void {
  try {
    if (screen !== 'workspace') storage?.setItem(SCREEN_KEY, screen);
    else storage?.removeItem(SCREEN_KEY);
  } catch {
    // private windows and blocked storage: the workspace next time
  }
}

/**
 * Where a session's card is, from what needs the user first to what is over:
 * waiting for an approval or an answer; at work; living by a prompt set for it
 * (a loop); idle; ended.
 */
export type Standing = 'asking' | 'working' | 'scheduled' | 'idle' | 'ended';

/** Its own conversation is idle while its sub-agents work: Claude runs them in the background. */
export const agentsAtWork = (session: Pick<SessionInfo, 'state' | 'agents'>): boolean => session.state === 'running' && session.agents.some(isAgentBusy);

export function standingOf(session: Pick<SessionInfo, 'state' | 'status' | 'agents' | 'schedules'>): Standing {
  if (session.state === 'exited') return 'ended';
  if (isAsking(session.status.value)) return 'asking';
  // A prompt set for it makes it work for a moment at every run and leaves it idle in between: with a
  // place of its own its card stays where it is, instead of going back and forth between the two.
  if (session.schedules.length) return 'scheduled';
  return session.status.value === 'working' || agentsAtWork(session) ? 'working' : 'idle';
}

const byStart = (a: SessionInfo, b: SessionInfo) => a.startedAt - b.startedAt;

/**
 * The sessions by standing. Whoever has waited longest for the user comes
 * first; those at work or with a loop keep the order they started in; of the
 * idle ones, what went wrong first, then whichever finished last; the ended
 * ones latest first.
 */
export function board(sessions: SessionInfo[]): Record<Standing, SessionInfo[]> {
  const by: Record<Standing, SessionInfo[]> = { asking: [], working: [], scheduled: [], idle: [], ended: [] };
  for (const session of sessions) by[standingOf(session)].push(session);
  by.asking.sort((a, b) => a.status.at - b.status.at || byStart(a, b));
  by.working.sort(byStart);
  by.scheduled.sort(byStart);
  by.idle.sort((a, b) => Number(b.status.error) - Number(a.status.error) || b.status.at - a.status.at || byStart(a, b));
  by.ended.sort((a, b) => (b.exit?.at ?? b.status.at) - (a.exit?.at ?? a.status.at) || byStart(a, b));
  return by;
}

/** Something that runs in a session now. `nested`: a sub-agent listed under the one that started it. */
export type Running = { kind: 'schedule'; job: ScheduledPrompt } | { kind: 'agent'; agent: AgentInfo; nested: boolean } | { kind: 'task'; task: BackgroundTask };

/** A card lists this many of them; the rest is a number. */
export const SHOWN_RUNNING = 5;

/**
 * What runs in a session now, in the order its card lists it: the prompts set
 * for it (a session that has one lives by them), then its sub-agents that work
 * or wait for the user, each after the one that started it, then what it left
 * running in the background. What has ended is not among them.
 */
export function runningIn(session: Pick<SessionInfo, 'state' | 'agents' | 'tasks' | 'schedules'>): Running[] {
  if (session.state === 'exited') return [];
  const busy = new Set(session.agents.filter(isAgentBusy).map((agent) => agent.id));
  const agents = agentRows(session.agents, true)
    .rows.filter(({ agent }) => busy.has(agent.id))
    .map(({ agent }): Running => ({ kind: 'agent', agent, nested: agent.parentId !== null && busy.has(agent.parentId) }));
  return [...session.schedules.map((job): Running => ({ kind: 'schedule', job })), ...agents, ...session.tasks.filter(isTaskRunning).map((task): Running => ({ kind: 'task', task }))];
}

/** How long something has been as it is, to the minute: 1분 미만, 12분, 1시간 4분, 2일 3시간. */
export function span(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  const { day, hour, minute } = t.unit;
  if (minutes < 1) return t.underMinute;
  if (minutes < 60) return `${minutes}${minute}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}${hour} ${minutes % 60}${minute}` : `${hours}${hour}`;
  return hours % 24 ? `${Math.floor(hours / 24)}${day} ${hours % 24}${hour}` : `${Math.floor(hours / 24)}${day}`;
}
