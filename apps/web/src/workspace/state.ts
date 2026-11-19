// Workspace layout and drag-and-drop rules, kept free of React and the DOM so
// they can be tested directly.

// The workspace is split into this many stacks at most: each shows a terminal, and each terminal
// redraws with every line its CLI prints. A stack holds any number of panes as tabs.
export const MAX_STACKS = 6;
// A layout brought back from storage holds this many panes at most.
const MAX_PANES = 40;

/**
 * What shows a session (or one of its sub-agents): a tab of the stack it is in. Only the pane on
 * top of its stack is drawn; the others wait as tabs.
 */
export interface Pane {
  id: string;
  sessionId: string;
  /** One of the session's sub-agents: the pane shows that agent's conversation. */
  agentId?: string;
  /** What the pane showed before, newest last, for its back button. Not kept across reloads. */
  history?: PaneEntry[];
}

/** What a pane shows: a session in some mode, or one of its sub-agents. */
export interface PaneEntry {
  sessionId: string;
  agentId?: string;
  mode: PaneMode | null;
}

// Back goes this many steps at most.
const HISTORY = 10;

/** What a pane shows: a session, or one of its sub-agents. */
export interface Target {
  sessionId: string;
  agentId?: string | undefined;
}

const shows = (pane: Pane, target: Target) => pane.sessionId === target.sessionId && (pane.agentId ?? null) === (target.agentId ?? null);
const paneOf = (id: string, target: Target): Pane => ({ id, sessionId: target.sessionId, ...(target.agentId ? { agentId: target.agentId } : {}) });

/** A place in the workspace: the panes in it as tabs, in their order, and the one that shows. */
export interface Stack {
  id: string;
  panes: string[];
  top: string;
}

export type Side = 'left' | 'right' | 'top' | 'bottom';

/**
 * How the stacks lie: one alone, or several side by side (`row`) or one above the other
 * (`column`), each with its share of the room (`sizes`, which add up to one). A split holds
 * stacks and splits of the other direction.
 */
export type Layout = { type: 'stack'; id: string } | { type: 'split'; id: string; dir: 'row' | 'column'; children: Layout[]; sizes: number[] };

const dirOf = (side: Side) => (side === 'left' || side === 'right' ? 'row' : 'column');
const isBefore = (side: Side) => side === 'left' || side === 'top';

/** The stacks of a layout, in reading order. */
export function stacksIn(layout: Layout | null): string[] {
  if (!layout) return [];
  return layout.type === 'stack' ? [layout.id] : layout.children.flatMap(stacksIn);
}

/** The layout with a stack (or more) put next to one of its stacks, on that side: it takes half of that stack's room. */
function beside(layout: Layout, stackId: string, side: Side, added: Layout, splitId: string): Layout {
  if (layout.type === 'stack') {
    if (layout.id !== stackId) return layout;
    return { type: 'split', id: splitId, dir: dirOf(side), children: isBefore(side) ? [added, layout] : [layout, added], sizes: [0.5, 0.5] };
  }
  const at = layout.children.findIndex((child) => child.type === 'stack' && child.id === stackId);
  if (at === -1 || layout.dir !== dirOf(side)) return { ...layout, children: layout.children.map((child) => beside(child, stackId, side, added, splitId)) };
  // In the row (or column) that stack is already in: the two share what was its part.
  const index = isBefore(side) ? at : at + 1;
  const half = layout.sizes[at]! / 2;
  return { ...layout, children: [...layout.children.slice(0, index), added, ...layout.children.slice(index)], sizes: [...layout.sizes.slice(0, at), half, half, ...layout.sizes.slice(at + 1)] };
}

/**
 * The layout as it must be for these stacks: only they are in it, each once; a split left with
 * one part is that part, one inside another of the same direction is part of it, and the shares
 * of a split add up to one. Stacks the layout does not have yet are put at its right end.
 */
function tidy(layout: Layout | null, stackIds: string[], nextNode: number): { layout: Layout | null; nextNode: number } {
  const wanted = new Set(stackIds);
  const seen = new Set<string>();
  const clean = (node: Layout): Layout | null => {
    if (node.type === 'stack') {
      if (!wanted.has(node.id) || seen.has(node.id)) return null;
      seen.add(node.id);
      return node;
    }
    const parts: Array<{ node: Layout; size: number }> = [];
    node.children.forEach((child, i) => {
      // A part without a share is left out before it is looked into: its stacks are put at the end, below.
      const size = node.sizes[i];
      if (!(typeof size === 'number' && size > 0)) return;
      const kept = clean(child);
      if (!kept) return;
      // A row inside a row is part of that row.
      if (kept.type === 'split' && kept.dir === node.dir) kept.children.forEach((inner, j) => parts.push({ node: inner, size: size * kept.sizes[j]! }));
      else parts.push({ node: kept, size });
    });
    if (!parts.length) return null;
    if (parts.length === 1) return parts[0]!.node;
    const total = parts.reduce((sum, part) => sum + part.size, 0);
    return { ...node, children: parts.map((part) => part.node), sizes: parts.map((part) => part.size / total) };
  };
  let next = layout ? clean(layout) : null;
  let node = nextNode;
  for (const id of stackIds) {
    if (seen.has(id)) continue;
    const added: Layout = { type: 'stack', id };
    seen.add(id);
    if (!next) next = added;
    else if (next.type === 'split' && next.dir === 'row') {
      const share = 1 / (next.children.length + 1);
      next = { ...next, children: [...next.children, added], sizes: [...next.sizes.map((size) => size * (1 - share)), share] };
    } else {
      next = { type: 'split', id: `x${node}`, dir: 'row', children: [next, added], sizes: [0.5, 0.5] };
      node += 1;
    }
  }
  return { layout: next, nextNode: node };
}

/** What a pane shows of its session: the live terminal, the conversation, or the flow (who worked when). */
export type PaneMode = 'terminal' | 'conversation' | 'flow';

/**
 * What a pane can show. A sub-agent: its conversation. A session: its terminal
 * (while the host has it), its conversation (once it has a transcript) and its flow.
 */
export function paneModes(pane: Pick<Pane, 'agentId'>, session: { screen: boolean; transcripts: unknown[] }): PaneMode[] {
  if (pane.agentId) return ['conversation'];
  return [...(session.screen ? (['terminal'] as const) : []), ...(session.transcripts.length ? (['conversation'] as const) : []), 'flow'];
}

/** The mode a pane shows: the one chosen for it while it has that, else its first. */
export const shownMode = (chosen: PaneMode | undefined, modes: PaneMode[]): PaneMode => (chosen && modes.includes(chosen) ? chosen : (modes[0] ?? 'flow'));

/** Ctrl+`: the shortcut between a pane's terminal and its conversation. */
export const isModeShortcut = (key: { code: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean; shiftKey: boolean; isComposing?: boolean }) =>
  key.code === 'Backquote' && key.ctrlKey && !key.altKey && !key.metaKey && !key.shiftKey && !key.isComposing;

/** Where the shortcut takes a pane: the terminal to the conversation and back; from the flow, the terminal first. Null when there is nowhere to go. */
export function switchedMode(mode: PaneMode, modes: PaneMode[]): PaneMode | null {
  const next: PaneMode = mode === 'terminal' ? 'conversation' : 'terminal';
  if (modes.includes(next)) return next;
  return mode === 'flow' && modes.includes('conversation') ? 'conversation' : null;
}

export type Drag =
  | { kind: 'session'; id: string }
  | { kind: 'agent'; id: string; sessionId: string }
  | { kind: 'pane'; id: string }
  /** A piece of a session's conversation (an answer), to hand to a session delegated under it. */
  | { kind: 'item'; id: string; sessionId: string; text: string };

/** The session or sub-agent a drag carries, if it carries one. */
function dragTarget(drag: Drag): Target | null {
  if (drag.kind === 'session') return { sessionId: drag.id };
  if (drag.kind === 'agent') return { sessionId: drag.sessionId, agentId: drag.id };
  return null;
}

/** Whether the session delegated work may go to sits delegated under the session it comes from. */
const delegateOf = (ctx: DropContext, childId: string | undefined, parentId: string) => Boolean(childId) && ctx.delegates?.[childId!] === parentId;
/**
 * `pane`: the middle of a stack, by the pane on top of it: what is dropped shows in that pane, and a
 * pane dragged there joins the stack; `tabs`: the tabs of a stack, to join them; `edge`: a side of a
 * stack, to make a new stack there; `slot`: the workspace while it is empty.
 * `nest`: a session row in the tree, to place the dragged session under it; `root`: back at the top;
 * `delegate`: a chip of a session delegated under a pane's session, to hand it a piece of the conversation.
 */
export type DropTarget =
  | { type: 'pane'; id: string }
  | { type: 'tabs'; id: string }
  | { type: 'edge'; id: string; side: Side }
  | { type: 'slot' }
  | { type: 'composer' }
  | { type: 'nest'; id: string }
  | { type: 'root' }
  | { type: 'delegate'; id: string };

/** A session dropped on another, waiting for the user to choose how to link them. */
export interface PendingLink {
  childId: string;
  parentId: string;
}

export interface WorkspaceState {
  /** Every pane, whichever stack it is a tab of. */
  panes: Pane[];
  /** The stacks the panes are in, each pane in one, and how the stacks lie. */
  stacks: Stack[];
  layout: Layout | null;
  /** The pane that takes the typing: on top of its stack. */
  active: string | null;
  nextPane: number;
  /** The number the next stack or split is named with. */
  nextNode: number;
  drag: Drag | null;
  over: DropTarget | null;
  targets: string[];
  rowOpen: Record<string, boolean>;
  paneOpen: Record<string, boolean>;
  /** Per pane; a pane not listed shows the terminal. */
  paneMode: Record<string, PaneMode>;
  pending: PendingLink | null;
  /** A sub-agent to point out in its session's flow: picked in the tree, or the one a pane came back from. */
  flowFocus: { paneId: string; agentId: string } | null;
}

export const initialWorkspace: WorkspaceState = {
  panes: [],
  stacks: [],
  layout: null,
  active: null,
  nextPane: 1,
  nextNode: 1,
  drag: null,
  over: null,
  targets: [],
  rowOpen: {},
  paneOpen: {},
  paneMode: {},
  pending: null,
  flowFocus: null,
};

const LAYOUT_KEY = 'ah-layout';

const stackOf = (state: Pick<WorkspaceState, 'stacks'>, paneId: string | null): Stack | undefined => state.stacks.find((stack) => paneId !== null && stack.panes.includes(paneId));

const sameShape = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The stacks and the layout as they must be for the panes there are: every pane in one stack, no
 * stack without a pane, on top of each a pane of its own, the active pane on top of its stack, and
 * the layout made of these stacks and no others. Whatever changed the panes or the stacks ends here.
 */
function settle(state: WorkspaceState): WorkspaceState {
  const known = new Set(state.panes.map((pane) => pane.id));
  const placed = new Set<string>();
  let nextNode = state.nextNode;
  let stacks: Stack[] = [];
  for (const stack of state.stacks) {
    const panes: string[] = [];
    for (const id of stack.panes) {
      if (!known.has(id) || placed.has(id)) continue;
      placed.add(id);
      panes.push(id);
    }
    if (panes.length) stacks.push({ id: stack.id, panes, top: panes.includes(stack.top) ? stack.top : panes[0]! });
  }
  // A pane no stack has: with the first stack, or in one of its own when there is none.
  const stray = state.panes.filter((pane) => !placed.has(pane.id)).map((pane) => pane.id);
  if (stray.length && stacks.length) stacks = stacks.map((stack, i) => (i === 0 ? { ...stack, panes: [...stack.panes, ...stray] } : stack));
  else if (stray.length) {
    stacks = [{ id: `s${nextNode}`, panes: stray, top: stray[0]! }];
    nextNode += 1;
  }
  const tidied = tidy(state.layout, stacks.map((stack) => stack.id), nextNode);
  const order = stacksIn(tidied.layout);
  const active = state.active !== null && known.has(state.active) ? state.active : (stacks.find((stack) => stack.id === order[0])?.top ?? null);
  stacks = stacks.map((stack) => (active !== null && stack.panes.includes(active) && stack.top !== active ? { ...stack, top: active } : stack));
  return {
    ...state,
    // The same as before where nothing changed, so that nothing is drawn or saved again for it.
    stacks: sameShape(stacks, state.stacks) ? state.stacks : stacks,
    layout: sameShape(tidied.layout, state.layout) ? state.layout : tidied.layout,
    nextNode: tidied.nextNode,
    active,
  };
}

const isPane = (value: unknown): value is Pane => {
  const pane = value as Partial<Pane> | null;
  return typeof pane?.id === 'string' && typeof pane.sessionId === 'string' && (pane.agentId === undefined || typeof pane.agentId === 'string');
};

/** A layout as it was saved, held to its shape; which stacks it names is settled afterwards. */
function isLayout(value: unknown, depth = 0): value is Layout {
  const node = value as { type?: unknown; id?: unknown; dir?: unknown; children?: unknown; sizes?: unknown } | null;
  if (!node || typeof node.id !== 'string' || depth > 8) return false;
  if (node.type === 'stack') return true;
  return (
    node.type === 'split' &&
    (node.dir === 'row' || node.dir === 'column') &&
    Array.isArray(node.children) &&
    Array.isArray(node.sizes) &&
    node.sizes.length === node.children.length &&
    node.children.every((child) => isLayout(child, depth + 1))
  );
}

/** The largest number a stack or a split of a layout is named with. */
function lastNode(layout: Layout | null, stacks: Stack[]): number {
  const numbers = stacks.map((stack) => Number(stack.id.slice(1)) || 0);
  const walk = (node: Layout) => {
    numbers.push(Number(node.id.slice(1)) || 0);
    if (node.type === 'split') node.children.forEach(walk);
  };
  if (layout) walk(layout);
  return Math.max(0, ...numbers);
}

/**
 * The panes as the grid of before had them, when a pane was a place of its own: two to a row,
 * the rows one above the other.
 */
function fromGrid(panes: Pane[]): Pick<WorkspaceState, 'stacks' | 'layout' | 'nextNode'> {
  const stacks = panes.map((pane, i) => ({ id: `s${i + 1}`, panes: [pane.id], top: pane.id }));
  let node = stacks.length + 1;
  const rows: Layout[] = [];
  for (let i = 0; i < stacks.length; i += 2) {
    const pair: Layout[] = stacks.slice(i, i + 2).map((stack) => ({ type: 'stack', id: stack.id }));
    rows.push(pair.length === 1 ? pair[0]! : { type: 'split', id: `x${node++}`, dir: 'row', children: pair, sizes: [0.5, 0.5] });
  }
  const layout: Layout | null = rows.length <= 1 ? (rows[0] ?? null) : { type: 'split', id: `x${node++}`, dir: 'column', children: rows, sizes: rows.map(() => 1 / rows.length) };
  return { stacks, layout, nextNode: node };
}

/** Restores the layout this browser had, so a reload shows the same panes in the same places. */
export function loadWorkspace(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): WorkspaceState {
  try {
    const saved = JSON.parse(storage?.getItem(LAYOUT_KEY) ?? 'null') as Record<string, unknown> | null;
    if (!saved || !Array.isArray(saved.panes)) return initialWorkspace;
    const ids = new Set<string>();
    const panes = (saved.panes as unknown[])
      .filter(isPane)
      .filter((pane) => !ids.has(pane.id) && Boolean(ids.add(pane.id)))
      .map((pane) => paneOf(pane.id, pane))
      .slice(0, MAX_PANES);
    const active = panes.some((p) => p.id === saved.active) ? (saved.active as string) : null;
    const nextPane = Math.max(Number(saved.nextPane) || 1, ...panes.map((p) => Number(p.id.slice(1)) + 1 || 1));
    const modes = (saved.paneMode ?? {}) as Record<string, unknown>;
    const paneMode = Object.fromEntries(
      panes.filter((p) => modes[p.id] === 'conversation' || modes[p.id] === 'flow').map((p) => [p.id, modes[p.id] as PaneMode]),
    );
    // Saved before panes could share a place: each gets one, where the grid had it.
    if (!Array.isArray(saved.stacks)) return settle({ ...initialWorkspace, panes, active: active ?? panes[0]?.id ?? null, nextPane, paneMode, ...fromGrid(panes.slice(0, 4)) });
    const named = new Set<string>();
    const stacks = (saved.stacks as unknown[])
      .filter((value): value is Stack => {
        const stack = value as Partial<Stack> | null;
        return typeof stack?.id === 'string' && typeof stack.top === 'string' && Array.isArray(stack.panes) && stack.panes.every((id) => typeof id === 'string');
      })
      .filter((stack) => !named.has(stack.id) && Boolean(named.add(stack.id)))
      .slice(0, MAX_STACKS)
      .map((stack) => ({ id: stack.id, panes: [...stack.panes], top: stack.top }));
    const layout = isLayout(saved.layout) ? saved.layout : null;
    const nextNode = Math.max(Number(saved.nextNode) || 1, lastNode(layout, stacks) + 1);
    return settle({ ...initialWorkspace, panes, stacks, layout, active, nextPane, nextNode, paneMode });
  } catch {
    return initialWorkspace;
  }
}

export function saveWorkspace(state: WorkspaceState, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try {
    const paneMode = Object.fromEntries(state.panes.filter((p) => state.paneMode[p.id]).map((p) => [p.id, state.paneMode[p.id]]));
    const panes = state.panes.map(({ history: _history, ...pane }) => pane);
    storage?.setItem(LAYOUT_KEY, JSON.stringify({ panes, stacks: state.stacks, layout: state.layout, active: state.active, nextPane: state.nextPane, nextNode: state.nextNode, paneMode }));
  } catch {
    // private windows and blocked storage: the layout just isn't remembered
  }
}

export type Action =
  /** `mode`: show the session that way; `focusAgent`: point out this sub-agent in its flow. */
  | { type: 'open'; sessionId: string; agentId?: string; mode?: PaneMode; focusAgent?: string }
  /** Within a pane: show something else, with the way back. */
  | { type: 'drill'; paneId: string; sessionId: string; agentId?: string; mode?: PaneMode }
  | { type: 'back'; paneId: string }
  | { type: 'openNew'; sessionId: string; agentId?: string }
  | { type: 'focus'; paneId: string }
  | { type: 'closePane'; paneId: string }
  /** The parts of a split take these shares of its room from now on. */
  | { type: 'resize'; splitId: string; sizes: number[] }
  | { type: 'dragStart'; drag: Drag }
  | { type: 'dragOver'; over: DropTarget }
  | { type: 'clearOver' }
  | { type: 'dragEnd' }
  | { type: 'drop'; target: DropTarget }
  | { type: 'toggleRow'; id: string }
  | { type: 'togglePane'; id: string }
  | { type: 'setMode'; paneId: string; mode: PaneMode }
  | { type: 'removeTarget'; id: string }
  | { type: 'settleLink' }
  | { type: 'sync'; sessionIds: string[]; runningIds: string[] };

export interface DropContext {
  /** Sessions that can receive input (running, and AgentHouse's own). */
  runningIds: string[];
  /** The session each placed session sits under. */
  parents?: Record<string, string>;
  /** The same for the sessions delegated under another: work can be handed to them. */
  delegates?: Record<string, string>;
  /** Sessions started outside AgentHouse: shown, but placed under nothing, and nothing under them. */
  externalIds?: string[];
}

/** The same place to drop on: the same kind, of the same thing, and for an edge the same side. */
export const sameDrop = (a: DropTarget, b: DropTarget) => a.type === b.type && (!('id' in a) || !('id' in b) || a.id === b.id) && (a.type !== 'edge' || b.type !== 'edge' || a.side === b.side);

function sameTarget(a: DropTarget | null, b: DropTarget): boolean {
  return Boolean(a) && sameDrop(a!, b);
}

/** The pane a drag would move: the one dragged, or the one that already shows the session or sub-agent dragged. */
function movedBy(state: WorkspaceState, drag: Drag): Pane | undefined {
  if (drag.kind === 'pane') return state.panes.find((pane) => pane.id === drag.id);
  const target = dragTarget(drag);
  return target ? state.panes.find((pane) => shows(pane, target)) : undefined;
}

export function accepts(state: WorkspaceState, target: DropTarget, ctx: DropContext): boolean {
  const drag = state.drag;
  if (!drag) return false;
  // A piece of a conversation goes to a session delegated under the one it comes from, and nowhere else.
  if (drag.kind === 'item') {
    if (target.type === 'delegate') return delegateOf(ctx, target.id, drag.sessionId);
    if (target.type !== 'pane') return false;
    const pane = state.panes.find((p) => p.id === target.id);
    return !pane?.agentId && delegateOf(ctx, pane?.sessionId, drag.sessionId);
  }
  if (target.type === 'delegate') return false;
  // A session or a sub-agent shows in the pane it is dropped on; a pane joins that pane's stack, unless it is in it.
  if (target.type === 'pane') return drag.kind !== 'pane' || stackOf(state, drag.id) !== stackOf(state, target.id);
  if (target.type === 'tabs' || target.type === 'edge') {
    const from = stackOf(state, movedBy(state, drag)?.id ?? null);
    // Among the tabs of the stack it is in, a pane has nowhere to go; a session dropped there comes to the top.
    if (target.type === 'tabs') return drag.kind !== 'pane' || from?.id !== target.id;
    // A side of a stack makes a new stack there: not out of the one pane of that very stack, and
    // within the number of stacks there may be, unless the pane leaves a stack empty as it goes.
    const alone = from?.panes.length === 1;
    if (alone && from?.id === target.id) return false;
    return state.stacks.length < MAX_STACKS || alone;
  }
  if (drag.kind === 'pane') return false;
  // The workspace takes a first pane while it is empty.
  if (target.type === 'slot') return state.panes.length === 0;
  // One level of nesting: only under a session at the top, and not one with sessions under it.
  const parents = ctx.parents ?? {};
  if (target.type === 'nest') {
    if (drag.kind !== 'session' || drag.id === target.id || parents[target.id] || parents[drag.id] === target.id) return false;
    if (ctx.externalIds?.includes(drag.id) || ctx.externalIds?.includes(target.id)) return false;
    return !Object.values(parents).includes(drag.id);
  }
  if (target.type === 'root') return drag.kind === 'session' && Boolean(parents[drag.id]);
  // Only a session takes input; a sub-agent is reached through its session.
  return drag.kind === 'session' && ctx.runningIds.includes(drag.id) && !state.targets.includes(drag.id);
}

/**
 * What a drop asks of the server, besides what it does to the layout (`drop`,
 * below): a placed session let go over the top of the tree goes back to the top,
 * and a piece of a conversation let go over a delegate, its chip or its pane, is
 * work for that session.
 */
export type DropEffect = { type: 'unlink'; childId: string } | { type: 'delegate'; parentId: string; childId: string; text: string };

/** The effect of dropping what is dragged on a target, told before the drop ends the drag; null when it asks nothing, or is not taken. */
export function dropEffect(state: WorkspaceState, target: DropTarget, ctx: DropContext): DropEffect | null {
  const drag = state.drag;
  if (!drag || !accepts(state, target, ctx)) return null;
  if (drag.kind === 'session') return target.type === 'root' ? { type: 'unlink', childId: drag.id } : null;
  if (drag.kind !== 'item') return null;
  // Taken, so the target is a session delegated under the one the piece comes from: by its chip, or by its pane.
  const childId = target.type === 'delegate' ? target.id : target.type === 'pane' ? state.panes.find((p) => p.id === target.id)?.sessionId : undefined;
  return childId ? { type: 'delegate', parentId: drag.sessionId, childId, text: drag.text } : null;
}

/** A new pane for the target, on top: a tab of that stack, after the one that was on top; without a stack, in a new one. */
function addPane(state: WorkspaceState, target: Target, stackId?: string): WorkspaceState {
  const id = `p${state.nextPane}`;
  const into = state.stacks.find((stack) => stack.id === stackId);
  const next = { ...state, panes: [...state.panes, paneOf(id, target)], nextPane: state.nextPane + 1, active: id };
  if (!into) return settle({ ...next, stacks: [...state.stacks, { id: `s${state.nextNode}`, panes: [id], top: id }], nextNode: state.nextNode + 1 });
  const at = into.panes.indexOf(into.top) + 1;
  return settle({ ...next, stacks: state.stacks.map((stack) => (stack === into ? { ...stack, panes: [...stack.panes.slice(0, at), id, ...stack.panes.slice(at)], top: id } : stack)) });
}

/** The pane as a tab of that stack, on top of it; the stack it leaves closes when nothing is left in it. */
function moveTo(state: WorkspaceState, paneId: string, stackId: string): WorkspaceState {
  const stacks = state.stacks.map((stack) => {
    const others = stack.panes.filter((id) => id !== paneId);
    return stack.id === stackId ? { ...stack, panes: [...others, paneId], top: paneId } : { ...stack, panes: others };
  });
  return settle({ ...state, stacks, active: paneId });
}

/** The pane in a new stack next to that one, on that side. */
function splitOff(state: WorkspaceState, paneId: string, stackId: string, side: Side): WorkspaceState {
  if (!state.layout) return state;
  const id = `s${state.nextNode}`;
  const stacks = [...state.stacks.map((stack) => ({ ...stack, panes: stack.panes.filter((other) => other !== paneId) })), { id, panes: [paneId], top: paneId }];
  const layout = beside(state.layout, stackId, side, { type: 'stack', id }, `x${state.nextNode + 1}`);
  return settle({ ...state, stacks, layout, nextNode: state.nextNode + 2, active: paneId });
}

/** What a pane shows now, as a history entry. */
const entryOf = (state: WorkspaceState, pane: Pane): PaneEntry => ({
  sessionId: pane.sessionId,
  ...(pane.agentId ? { agentId: pane.agentId } : {}),
  mode: state.paneMode[pane.id] ?? null,
});

/**
 * The pane now shows the target, in its default view (the terminal for a
 * session); what it showed before, mode included, goes on its history.
 */
function replace(state: WorkspaceState, paneId: string, target: Target): WorkspaceState {
  const paneMode = { ...state.paneMode };
  delete paneMode[paneId];
  return {
    ...state,
    paneMode,
    panes: state.panes.map((p) => (p.id === paneId ? { ...paneOf(p.id, target), history: [...(p.history ?? []), entryOf(state, p)].slice(-HISTORY) } : p)),
  };
}

function withMode(state: WorkspaceState, paneId: string | null, mode: PaneMode | null | undefined): WorkspaceState {
  if (!paneId || mode === undefined) return state;
  const paneMode = { ...state.paneMode };
  if (mode === null) delete paneMode[paneId];
  else paneMode[paneId] = mode;
  return { ...state, paneMode };
}

/** Shows a session or sub-agent: the pane already showing it comes to the top, else the active pane shows it instead, else a first pane. */
function open(state: WorkspaceState, target: Target): WorkspaceState {
  const shown = state.panes.find((p) => shows(p, target));
  if (shown) return settle({ ...state, active: shown.id });
  const active = state.panes.find((p) => p.id === state.active);
  if (!active) return addPane(state, target);
  return replace(state, active.id, target);
}

/** Shows a session or sub-agent in a pane of its own: a new tab of the active pane's stack, so that no other pane changes its size. */
function openNew(state: WorkspaceState, target: Target): WorkspaceState {
  const shown = state.panes.find((p) => shows(p, target));
  if (shown) return settle({ ...state, active: shown.id });
  return addPane(state, target, stackOf(state, state.active)?.id);
}

function drop(state: WorkspaceState, target: DropTarget): WorkspaceState {
  const drag = state.drag;
  if (!drag) return state;
  if (drag.kind === 'pane') {
    // A pane goes where it is dropped: to a side of a stack as a stack of its own, else among that stack's tabs.
    if (target.type === 'edge') return splitOff(state, drag.id, target.id, target.side);
    const stack = target.type === 'tabs' ? target.id : target.type === 'pane' ? stackOf(state, target.id)?.id : undefined;
    return stack ? moveTo(state, drag.id, stack) : state;
  }
  // Handing work over is asked of the server (dropEffect); the layout stays.
  if (drag.kind === 'item') return state;
  // Linking asks the user first (nest); going back to the top is asked of the server (dropEffect).
  if (target.type === 'nest') return { ...state, pending: { childId: drag.id, parentId: target.id } };
  if (target.type === 'root') return state;
  const shown = dragTarget(drag)!;
  if (target.type === 'pane') {
    // Already a tab of that stack: it comes to the top. Else the pane on top shows it instead.
    const stack = stackOf(state, target.id);
    const tab = state.panes.find((pane) => stack?.panes.includes(pane.id) && shows(pane, shown));
    return tab ? settle({ ...state, active: tab.id }) : settle({ ...replace(state, target.id, shown), active: target.id });
  }
  if (target.type === 'slot') return addPane(state, shown);
  if (target.type === 'tabs' || target.type === 'edge') {
    // The pane that shows it already moves there; without one, a new pane, which is in no stack until it is put there.
    const existing = state.panes.find((pane) => shows(pane, shown));
    const id = existing?.id ?? `p${state.nextPane}`;
    const made = existing ? state : { ...state, panes: [...state.panes, paneOf(id, shown)], nextPane: state.nextPane + 1 };
    return target.type === 'tabs' ? moveTo(made, id, target.id) : splitOff(made, id, target.id, target.side);
  }
  return { ...state, targets: [...state.targets, drag.id] };
}

/** The agent pointed out in a flow, no longer for this pane. */
const unfocus = (state: WorkspaceState, paneId: string) => (state.flowFocus?.paneId === paneId ? null : state.flowFocus);

function toggle(map: Record<string, boolean>, id: string): Record<string, boolean> {
  return { ...map, [id]: !map[id] };
}

export function reducer(state: WorkspaceState, action: Action, ctx: DropContext = { runningIds: [] }): WorkspaceState {
  switch (action.type) {
    case 'open': {
      let next = open(state, action);
      // A pane already showing the session, switched to another mode: the old one is a step back.
      const shown = state.panes.find((p) => shows(p, action));
      if (shown && action.mode && (state.paneMode[shown.id] ?? null) !== action.mode) {
        next = { ...next, panes: next.panes.map((p) => (p.id === shown.id ? { ...p, history: [...(p.history ?? []), entryOf(state, p)].slice(-HISTORY) } : p)) };
      }
      const focus = action.focusAgent && next.active ? { paneId: next.active, agentId: action.focusAgent } : null;
      return { ...withMode(next, next.active, action.mode), flowFocus: focus ?? (action.mode && next.active ? unfocus(next, next.active) : next.flowFocus) };
    }
    case 'drill': {
      const pane = state.panes.find((p) => p.id === action.paneId);
      if (!pane) return state;
      const next = replace(state, pane.id, action);
      return settle({ ...withMode(next, pane.id, action.mode ?? null), active: pane.id, flowFocus: unfocus(state, pane.id) });
    }
    case 'back': {
      const pane = state.panes.find((p) => p.id === action.paneId);
      const previous = pane?.history?.at(-1);
      if (!pane || !previous) return state;
      const panes = state.panes.map((p) => (p.id === pane.id ? { ...paneOf(p.id, previous), history: p.history!.slice(0, -1) } : p));
      // Back from a sub-agent to its session: the agent it came from is pointed out.
      const from = pane.agentId && !previous.agentId && previous.sessionId === pane.sessionId ? { paneId: pane.id, agentId: pane.agentId } : null;
      return settle({ ...withMode({ ...state, panes }, pane.id, previous.mode), active: pane.id, flowFocus: from ?? unfocus(state, pane.id) });
    }
    case 'openNew':
      return openNew(state, action);
    case 'focus':
      // A tab that takes the typing comes to the top of its stack.
      return state.panes.some((p) => p.id === action.paneId) ? settle({ ...state, active: action.paneId }) : state;
    case 'closePane': {
      const stack = stackOf(state, action.paneId);
      // The tab after it takes its place, else the one before; with none left, its stack goes too.
      const at = stack?.panes.indexOf(action.paneId) ?? -1;
      const neighbor = stack?.panes[at + 1] ?? stack?.panes[at - 1] ?? null;
      const stacks = stack && neighbor && stack.top === action.paneId ? state.stacks.map((one) => (one === stack ? { ...one, top: neighbor } : one)) : state.stacks;
      const panes = state.panes.filter((p) => p.id !== action.paneId);
      return settle({ ...state, panes, stacks, active: state.active === action.paneId ? neighbor : state.active });
    }
    case 'resize': {
      const { splitId, sizes } = action;
      const total = sizes.reduce((sum, size) => sum + size, 0);
      if (!state.layout || !sizes.every((size) => size > 0)) return state;
      const set = (node: Layout): Layout => {
        if (node.type === 'stack') return node;
        if (node.id === splitId) return sizes.length === node.sizes.length ? { ...node, sizes: sizes.map((size) => size / total) } : node;
        const children = node.children.map(set);
        return children.every((child, i) => child === node.children[i]) ? node : { ...node, children };
      };
      const layout = set(state.layout);
      return layout === state.layout ? state : { ...state, layout };
    }
    case 'dragStart':
      return { ...state, drag: action.drag, over: null, pending: null };
    case 'dragOver':
      return sameTarget(state.over, action.over) ? state : { ...state, over: action.over };
    case 'clearOver':
      return state.over ? { ...state, over: null } : state;
    case 'dragEnd':
      return state.drag || state.over ? { ...state, drag: null, over: null } : state;
    case 'drop': {
      const next = accepts(state, action.target, ctx) ? drop(state, action.target) : state;
      return { ...next, drag: null, over: null };
    }
    case 'toggleRow':
      return { ...state, rowOpen: toggle(state.rowOpen, action.id) };
    case 'togglePane':
      return { ...state, paneOpen: toggle(state.paneOpen, action.id) };
    case 'setMode':
      return { ...state, paneMode: { ...state.paneMode, [action.paneId]: action.mode } };
    case 'removeTarget':
      return { ...state, targets: state.targets.filter((t) => t !== action.id) };
    case 'settleLink':
      return state.pending ? { ...state, pending: null } : state;
    case 'sync': {
      // Sessions removed elsewhere drop out of panes; ended ones stop receiving input.
      const known = new Set(action.sessionIds);
      const stale = (p: Pane) => p.history?.some((e) => !known.has(e.sessionId));
      // A step back to a removed session is dropped from the history too.
      const panes = state.panes.filter((p) => known.has(p.sessionId)).map((p) => (stale(p) ? { ...p, history: p.history!.filter((e) => known.has(e.sessionId)) } : p));
      const targets = state.targets.filter((t) => action.runningIds.includes(t));
      const active = panes.some((p) => p.id === state.active) ? state.active : (panes[0]?.id ?? null);
      const pending = state.pending && known.has(state.pending.childId) && known.has(state.pending.parentId) ? state.pending : null;
      const same = panes.length === state.panes.length && panes.every((p, i) => p === state.panes[i]);
      if (same && targets.length === state.targets.length && active === state.active && pending === state.pending) return state;
      // A stack whose panes all went goes with them, and the others take its room.
      return settle({ ...state, panes, targets, active: panes.some((p) => p.id === state.active) ? state.active : null, pending });
    }
    default:
      return state;
  }
}
