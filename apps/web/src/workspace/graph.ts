// The graph screen: every session with what it started, what it runs by itself
// and the sessions placed under it. Drawn as a tree on its side (who is under
// whom) and as lanes over time (when each worked). What is under what is the
// tree's own order. Kept free of React so it can be tested directly.
import { isAgentBusy, isAsking, isTaskRunning, type AgentInfo, type BackgroundTask, type DelegationInfo, type ScheduledPrompt, type SessionInfo, type SessionLink } from '@agenthouse/protocol';
import { agentRows, SHOWN_FINISHED } from './agents';
import { agentsAtWork } from './dashboard';
import type { Bar } from './flow';
import { sessionTree, type SessionNode } from './tree';

interface Base {
  /** Its name among the nodes: the same from one list of sessions to the next. */
  key: string;
  /** The session it is, or is of. */
  session: SessionInfo;
  children: GraphNode[];
}

export type GraphNode =
  /** `link`: what places it under its parent; `work`: the latest work that parent handed it, when it is delegated to. */
  | (Base & { kind: 'session'; link: SessionLink | null; work: DelegationInfo | null })
  | (Base & { kind: 'agent'; agent: AgentInfo })
  /** What a session runs by itself: a command left running in the background, a prompt set for later. */
  | (Base & { kind: 'task'; task: BackgroundTask })
  | (Base & { kind: 'schedule'; job: ScheduledPrompt })
  /** Stands for the finished sub-agents that are not listed (`folded` of them); with none folded, it folds them again. */
  | (Base & { kind: 'fold'; folded: number });

export interface GraphFolder {
  cwd: string;
  label: string;
  roots: GraphNode[];
}

export type GraphFilter = 'all' | 'running';

export interface GraphOptions {
  filter: GraphFilter;
  /** The sessions whose finished sub-agents are all listed. */
  allAgents: ReadonlySet<string>;
  /** The ended sessions show too. */
  ended: boolean;
}

const sessionBusy = (session: SessionInfo) => session.state === 'running' && (session.status.value === 'working' || isAsking(session.status.value));

/** Busy now: at work or waiting for the user, a command still running, a prompt that will be given again. */
export function isBusy(node: GraphNode): boolean {
  if (node.kind === 'session') return sessionBusy(node.session);
  if (node.kind === 'agent') return isAgentBusy(node.agent);
  return node.kind === 'task' || node.kind === 'schedule';
}

/** A session with what is under it, in the order the tree lists it: its sub-agents, what it runs by itself, the sessions placed under it. */
function sessionNode({ session, link, children }: SessionNode, delegations: DelegationInfo[], options: GraphOptions): GraphNode {
  const under: GraphNode[] = [];
  const all = options.allAgents.has(session.id);
  const { rows, folded } = agentRows(session.agents, all);
  // The rows come as the tree lists them, each after the one that started it: nested again by their depth.
  const above: Array<{ depth: number; node: GraphNode }> = [];
  for (const { agent, depth } of rows) {
    const node: GraphNode = { key: `${session.id}/${agent.id}`, kind: 'agent', session, agent, children: [] };
    while (above.length && above.at(-1)!.depth >= depth) above.pop();
    (above.at(-1)?.node.children ?? under).push(node);
    above.push({ depth, node });
  }
  const finished = session.agents.filter((agent) => !isAgentBusy(agent)).length;
  if (folded > 0 || (all && finished > SHOWN_FINISHED)) under.push({ key: `${session.id}#agents`, kind: 'fold', session, folded, children: [] });
  for (const task of session.tasks.filter(isTaskRunning)) under.push({ key: `${session.id}/task/${task.id}`, kind: 'task', session, task, children: [] });
  for (const job of session.schedules) under.push({ key: `${session.id}/schedule/${job.id}`, kind: 'schedule', session, job, children: [] });
  for (const child of children) under.push(sessionNode(child, delegations, options));
  const handed = link?.kind === 'delegate' ? delegations.filter((work) => work.parentId === link.parentId && work.childId === session.id) : [];
  const work = handed.reduce<DelegationInfo | null>((latest, one) => (!latest || one.sentAt >= latest.sentAt ? one : latest), null);
  return { key: session.id, kind: 'session', session, link, work, children: under };
}

/** What is busy, with everything above it; null when nothing of it is. */
function running(node: GraphNode): GraphNode | null {
  const children = node.children.map(running).filter((child): child is GraphNode => child !== null);
  return isBusy(node) || children.length ? { ...node, children } : null;
}

/**
 * The sessions as trees, by folder, as the session tree groups and orders them. An ended session at
 * the top with nothing under it folds away unless `ended`: `foldedEnded` says how many there are.
 * With `running`, only what is busy now and what is above it.
 */
export function forest(sessions: SessionInfo[], links: SessionLink[], delegations: DelegationInfo[], options: GraphOptions): { folders: GraphFolder[]; foldedEnded: number } {
  const folds = (node: SessionNode) => node.session.state === 'exited' && !node.children.length;
  let foldedEnded = 0;
  const folders: GraphFolder[] = [];
  for (const group of sessionTree(sessions, links)) {
    foldedEnded += group.nodes.filter(folds).length;
    const roots = group.nodes
      .filter((node) => options.ended || !folds(node))
      .map((node) => sessionNode(node, delegations, options))
      .map((node) => (options.filter === 'running' ? running(node) : node))
      .filter((node): node is GraphNode => node !== null);
    if (roots.length) folders.push({ cwd: group.cwd, label: group.label, roots });
  }
  return { folders, foldedEnded };
}

/** What a line says of what it leads to: at work, waiting for the user, or neither. */
export type Tone = 'busy' | 'asks' | null;

export function toneOf(node: GraphNode): Tone {
  if (node.kind === 'session') {
    const { session } = node;
    if (session.state !== 'running') return null;
    if (isAsking(session.status.value)) return 'asks';
    // At work itself, through its sub-agents, or on work its parent handed it.
    return session.status.value === 'working' || agentsAtWork(session) || node.work?.status === 'running' ? 'busy' : null;
  }
  if (node.kind === 'agent') return node.agent.asking ? 'asks' : node.agent.state === 'running' ? 'busy' : null;
  return node.kind === 'task' ? 'busy' : null;
}

/** How a tree on its side is measured: a node's box, the room between two in a column and between two columns, and around the folders. */
export interface Sizes {
  width: number;
  height: number;
  gap: number;
  across: number;
  /** The room a folder's name takes above its sessions, and the room after the last of them. */
  folder: number;
  after: number;
  /** More room between two sessions at the top than between two nodes. */
  between: number;
}

export interface Placed {
  node: GraphNode;
  /** The node it is under; null at the top. */
  parent: Placed | null;
  depth: number;
  x: number;
  y: number;
}

export interface Layout {
  placed: Placed[];
  folders: Array<{ cwd: string; label: string; y: number }>;
  width: number;
  height: number;
}

/**
 * Where everything goes: a node to the right of the one it is under, the nodes under one stacked
 * in their order, and that one at the middle of them. Folders follow one another downwards.
 */
export function layout(folders: GraphFolder[], sizes: Sizes): Layout {
  const placed: Placed[] = [];
  /** Places a node and what is under it from `top` down; returns where the next one may start. */
  const place = (node: GraphNode, parent: Placed | null, depth: number, top: number): number => {
    const at: Placed = { node, parent, depth, x: depth * (sizes.width + sizes.across), y: top };
    placed.push(at);
    if (!node.children.length) return top + sizes.height + sizes.gap;
    let next = top;
    const under: Placed[] = [];
    for (const child of node.children) {
      // The child is the next one placed, before what is under it.
      const index = placed.length;
      next = place(child, at, depth + 1, next);
      under.push(placed[index]!);
    }
    at.y = (under[0]!.y + under.at(-1)!.y) / 2;
    return next;
  };
  const labels: Layout['folders'] = [];
  let top = 0;
  for (const folder of folders) {
    labels.push({ cwd: folder.cwd, label: folder.label, y: top });
    top += sizes.folder;
    for (const root of folder.roots) top = place(root, null, 0, top) + sizes.between;
    top += sizes.after - sizes.between;
  }
  const deepest = placed.reduce((most, at) => Math.max(most, at.depth), 0);
  return { placed, folders: labels, width: placed.length ? (deepest + 1) * sizes.width + deepest * sizes.across : 0, height: Math.max(0, top - sizes.after - sizes.gap) };
}

/** What a node pointed at is shown with: what it is under, up to the top, and all that is under it. */
export function related(placed: Placed[], key: string): Set<string> {
  const keys = new Set<string>();
  const pointed = placed.find((at) => at.node.key === key);
  for (let at = pointed ?? null; at; at = at.parent) keys.add(at.node.key);
  const under = (node: GraphNode) => {
    keys.add(node.key);
    node.children.forEach(under);
  };
  if (pointed) under(pointed.node);
  return keys;
}

/** The nodes in the order the tree lists them, each with how deep it is under its session at the top: the rows of the lanes. */
export function rowsOf(roots: GraphNode[]): Array<{ node: GraphNode; depth: number }> {
  const rows: Array<{ node: GraphNode; depth: number }> = [];
  const walk = (node: GraphNode, depth: number) => {
    rows.push({ node, depth });
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  return rows;
}

/** A command in the background ran from its start to its end, or runs until now. */
export function taskBars(task: Pick<BackgroundTask, 'startedAt' | 'endedAt' | 'state'>, now: number): Bar[] {
  return [{ from: task.startedAt, to: task.endedAt ?? now, kind: isTaskRunning(task) ? 'working' : 'done' }];
}
