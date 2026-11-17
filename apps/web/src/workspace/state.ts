// Workspace layout and drag-and-drop rules, kept free of React and the DOM so
// they can be tested directly.

export const MAX_PANES = 4;

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
 * `nest`: a session row in the tree, to place the dragged session under it; `root`: back at the top;
 * `delegate`: a chip of a session delegated under a pane's session, to hand it a piece of the conversation.
 */
export type DropTarget =
  | { type: 'pane'; id: string }
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
  panes: Pane[];
  active: string | null;
  nextPane: number;
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
  active: null,
  nextPane: 1,
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

/** Restores the pane layout this browser had, so a reload shows the same panes. */
export function loadWorkspace(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): WorkspaceState {
  try {
    const saved = JSON.parse(storage?.getItem(LAYOUT_KEY) ?? 'null') as Partial<WorkspaceState> | null;
    if (!saved || !Array.isArray(saved.panes)) return initialWorkspace;
    const panes = saved.panes
      .filter((p): p is Pane => typeof p?.id === 'string' && typeof p?.sessionId === 'string' && (p.agentId === undefined || typeof p.agentId === 'string'))
      .map((p) => paneOf(p.id, p))
      .slice(0, MAX_PANES);
    const active = panes.some((p) => p.id === saved.active) ? (saved.active as string) : (panes[0]?.id ?? null);
    const nextPane = Math.max(Number(saved.nextPane) || 1, ...panes.map((p) => Number(p.id.slice(1)) + 1 || 1));
    const modes = (saved.paneMode ?? {}) as Record<string, unknown>;
    const paneMode = Object.fromEntries(
      panes.filter((p) => modes[p.id] === 'conversation' || modes[p.id] === 'flow').map((p) => [p.id, modes[p.id] as PaneMode]),
    );
    return { ...initialWorkspace, panes, active, nextPane, paneMode };
  } catch {
    return initialWorkspace;
  }
}

export function saveWorkspace(state: WorkspaceState, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try {
    const paneMode = Object.fromEntries(state.panes.filter((p) => state.paneMode[p.id]).map((p) => [p.id, state.paneMode[p.id]]));
    const panes = state.panes.map(({ history: _history, ...pane }) => pane);
    storage?.setItem(LAYOUT_KEY, JSON.stringify({ panes, active: state.active, nextPane: state.nextPane, paneMode }));
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

const sameDrop = (a: DropTarget, b: DropTarget) => a.type === b.type && (!('id' in a) || !('id' in b) || a.id === b.id);

function sameTarget(a: DropTarget | null, b: DropTarget): boolean {
  return Boolean(a) && sameDrop(a!, b);
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
  if (target.type === 'pane') return drag.kind !== 'pane' || drag.id !== target.id;
  if (drag.kind === 'pane') return false;
  if (target.type === 'slot') return state.panes.length < MAX_PANES;
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

function addPane(state: WorkspaceState, target: Target): WorkspaceState {
  const id = `p${state.nextPane}`;
  return { ...state, panes: [...state.panes, paneOf(id, target)], nextPane: state.nextPane + 1, active: id };
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

/** Shows a session or sub-agent: focuses the pane already showing it, else replaces the active pane, else adds one. */
function open(state: WorkspaceState, target: Target): WorkspaceState {
  const shown = state.panes.find((p) => shows(p, target));
  if (shown) return { ...state, active: shown.id };
  const active = state.panes.find((p) => p.id === state.active);
  if (!active) return addPane(state, target);
  return replace(state, active.id, target);
}

/** Shows a session or sub-agent in a new pane when there is room, else like `open`. */
function openNew(state: WorkspaceState, target: Target): WorkspaceState {
  const shown = state.panes.find((p) => shows(p, target));
  if (shown) return { ...state, active: shown.id };
  return state.panes.length < MAX_PANES ? addPane(state, target) : open(state, target);
}

function swap(state: WorkspaceState, fromId: string, toId: string): WorkspaceState {
  const panes = state.panes.slice();
  const from = panes.findIndex((p) => p.id === fromId);
  const to = panes.findIndex((p) => p.id === toId);
  if (from === -1 || to === -1) return state;
  [panes[from], panes[to]] = [panes[to]!, panes[from]!];
  return { ...state, panes };
}

function drop(state: WorkspaceState, target: DropTarget): WorkspaceState {
  const drag = state.drag;
  if (!drag) return state;
  if (drag.kind === 'pane') return target.type === 'pane' ? swap(state, drag.id, target.id) : state;
  // Handing work over is done by whoever handles the drop; the layout stays.
  if (drag.kind === 'item') return state;
  // Linking asks first (nest); going back to the top is done by whoever handles the drop (root).
  if (target.type === 'nest') return { ...state, pending: { childId: drag.id, parentId: target.id } };
  if (target.type === 'root') return state;
  const shown = dragTarget(drag)!;
  if (target.type === 'pane') return { ...replace(state, target.id, shown), active: target.id };
  if (target.type === 'slot') return addPane(state, shown);
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
      return { ...withMode(next, pane.id, action.mode ?? null), active: pane.id, flowFocus: unfocus(state, pane.id) };
    }
    case 'back': {
      const pane = state.panes.find((p) => p.id === action.paneId);
      const previous = pane?.history?.at(-1);
      if (!pane || !previous) return state;
      const panes = state.panes.map((p) => (p.id === pane.id ? { ...paneOf(p.id, previous), history: p.history!.slice(0, -1) } : p));
      // Back from a sub-agent to its session: the agent it came from is pointed out.
      const from = pane.agentId && !previous.agentId && previous.sessionId === pane.sessionId ? { paneId: pane.id, agentId: pane.agentId } : null;
      return { ...withMode({ ...state, panes }, pane.id, previous.mode), active: pane.id, flowFocus: from ?? unfocus(state, pane.id) };
    }
    case 'openNew':
      return openNew(state, action);
    case 'focus':
      return state.panes.some((p) => p.id === action.paneId) ? { ...state, active: action.paneId } : state;
    case 'closePane': {
      const panes = state.panes.filter((p) => p.id !== action.paneId);
      const active = state.active === action.paneId ? (panes[0]?.id ?? null) : state.active;
      return { ...state, panes, active };
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
      return { ...state, panes, targets, active, pending };
    }
    default:
      return state;
  }
}
