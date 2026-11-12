// Workspace layout and drag-and-drop rules, kept free of React and the DOM so
// they can be tested directly.

export const MAX_PANES = 4;

export interface Pane {
  id: string;
  sessionId: string;
  /** One of the session's sub-agents: the pane shows that agent's conversation. */
  agentId?: string;
}

/** What a pane shows: a session, or one of its sub-agents. */
export interface Target {
  sessionId: string;
  agentId?: string | undefined;
}

const shows = (pane: Pane, target: Target) => pane.sessionId === target.sessionId && (pane.agentId ?? null) === (target.agentId ?? null);
const paneOf = (id: string, target: Target): Pane => ({ id, sessionId: target.sessionId, ...(target.agentId ? { agentId: target.agentId } : {}) });

/** What a pane shows of its session: the live terminal, or the conversation read from the transcript. */
export type PaneMode = 'terminal' | 'conversation';

export type Drag = { kind: 'session'; id: string } | { kind: 'agent'; id: string; sessionId: string } | { kind: 'pane'; id: string };

/** The session or sub-agent a drag carries, if it carries one. */
function dragTarget(drag: Drag): Target | null {
  if (drag.kind === 'session') return { sessionId: drag.id };
  if (drag.kind === 'agent') return { sessionId: drag.sessionId, agentId: drag.id };
  return null;
}
/** `nest`: a session row in the tree, to place the dragged session under it; `root`: back at the top. */
export type DropTarget = { type: 'pane'; id: string } | { type: 'slot' } | { type: 'composer' } | { type: 'nest'; id: string } | { type: 'root' };

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
    const paneMode = Object.fromEntries(panes.filter((p) => saved.paneMode?.[p.id] === 'conversation').map((p) => [p.id, 'conversation' as const]));
    return { ...initialWorkspace, panes, active, nextPane, paneMode };
  } catch {
    return initialWorkspace;
  }
}

export function saveWorkspace(state: WorkspaceState, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try {
    const paneMode = Object.fromEntries(state.panes.filter((p) => state.paneMode[p.id]).map((p) => [p.id, state.paneMode[p.id]]));
    storage?.setItem(LAYOUT_KEY, JSON.stringify({ panes: state.panes, active: state.active, nextPane: state.nextPane, paneMode }));
  } catch {
    // private windows and blocked storage: the layout just isn't remembered
  }
}

export type Action =
  | { type: 'open'; sessionId: string; agentId?: string }
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
  /** Sessions that can receive input (running, not read-only). */
  runningIds: string[];
  /** The session each placed session sits under. */
  parents?: Record<string, string>;
}

const sameDrop = (a: DropTarget, b: DropTarget) => a.type === b.type && (!('id' in a) || !('id' in b) || a.id === b.id);

function sameTarget(a: DropTarget | null, b: DropTarget): boolean {
  return Boolean(a) && sameDrop(a!, b);
}

export function accepts(state: WorkspaceState, target: DropTarget, ctx: DropContext): boolean {
  const drag = state.drag;
  if (!drag) return false;
  if (target.type === 'pane') return drag.kind !== 'pane' || drag.id !== target.id;
  if (drag.kind === 'pane') return false;
  if (target.type === 'slot') return state.panes.length < MAX_PANES;
  // One level of nesting: only under a session at the top, and not one with sessions under it.
  const parents = ctx.parents ?? {};
  if (target.type === 'nest') {
    if (drag.kind !== 'session' || drag.id === target.id || parents[target.id] || parents[drag.id] === target.id) return false;
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

/** Shows a session or sub-agent: focuses the pane already showing it, else replaces the active pane, else adds one. */
function open(state: WorkspaceState, target: Target): WorkspaceState {
  const shown = state.panes.find((p) => shows(p, target));
  if (shown) return { ...state, active: shown.id };
  const active = state.panes.find((p) => p.id === state.active);
  if (!active) return addPane(state, target);
  return { ...state, panes: state.panes.map((p) => (p.id === active.id ? paneOf(p.id, target) : p)) };
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
  // Linking asks first (nest); going back to the top is done by whoever handles the drop (root).
  if (target.type === 'nest') return { ...state, pending: { childId: drag.id, parentId: target.id } };
  if (target.type === 'root') return state;
  const shown = dragTarget(drag)!;
  if (target.type === 'pane') return { ...state, panes: state.panes.map((p) => (p.id === target.id ? paneOf(p.id, shown) : p)), active: target.id };
  if (target.type === 'slot') return addPane(state, shown);
  return { ...state, targets: [...state.targets, drag.id] };
}

function toggle(map: Record<string, boolean>, id: string): Record<string, boolean> {
  return { ...map, [id]: !map[id] };
}

export function reducer(state: WorkspaceState, action: Action, ctx: DropContext = { runningIds: [] }): WorkspaceState {
  switch (action.type) {
    case 'open':
      return open(state, action);
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
      const panes = state.panes.filter((p) => known.has(p.sessionId));
      const targets = state.targets.filter((t) => action.runningIds.includes(t));
      const active = panes.some((p) => p.id === state.active) ? state.active : (panes[0]?.id ?? null);
      const pending = state.pending && known.has(state.pending.childId) && known.has(state.pending.parentId) ? state.pending : null;
      if (panes.length === state.panes.length && targets.length === state.targets.length && active === state.active && pending === state.pending) return state;
      return { ...state, panes, targets, active, pending };
    }
    default:
      return state;
  }
}
