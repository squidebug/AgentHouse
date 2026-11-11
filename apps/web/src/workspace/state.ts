// Workspace layout and drag-and-drop rules, kept free of React and the DOM so
// they can be tested directly.

export const MAX_PANES = 4;

export interface Pane {
  id: string;
  sessionId: string;
}

export type Drag = { kind: 'session'; id: string } | { kind: 'pane'; id: string };
export type DropTarget = { type: 'pane'; id: string } | { type: 'slot' } | { type: 'composer' };

export interface WorkspaceState {
  panes: Pane[];
  active: string | null;
  nextPane: number;
  drag: Drag | null;
  over: DropTarget | null;
  targets: string[];
  rowOpen: Record<string, boolean>;
  paneOpen: Record<string, boolean>;
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
};

const LAYOUT_KEY = 'ah-layout';

/** Restores the pane layout this browser had, so a reload shows the same panes. */
export function loadWorkspace(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): WorkspaceState {
  try {
    const saved = JSON.parse(storage?.getItem(LAYOUT_KEY) ?? 'null') as Partial<WorkspaceState> | null;
    if (!saved || !Array.isArray(saved.panes)) return initialWorkspace;
    const panes = saved.panes.filter((p): p is Pane => typeof p?.id === 'string' && typeof p?.sessionId === 'string').slice(0, MAX_PANES);
    const active = panes.some((p) => p.id === saved.active) ? (saved.active as string) : (panes[0]?.id ?? null);
    const nextPane = Math.max(Number(saved.nextPane) || 1, ...panes.map((p) => Number(p.id.slice(1)) + 1 || 1));
    return { ...initialWorkspace, panes, active, nextPane };
  } catch {
    return initialWorkspace;
  }
}

export function saveWorkspace(state: WorkspaceState, storage: Pick<Storage, 'setItem'> | undefined = globalThis.localStorage): void {
  try {
    storage?.setItem(LAYOUT_KEY, JSON.stringify({ panes: state.panes, active: state.active, nextPane: state.nextPane }));
  } catch {
    // private windows and blocked storage: the layout just isn't remembered
  }
}

export type Action =
  | { type: 'open'; sessionId: string }
  | { type: 'openNew'; sessionId: string }
  | { type: 'focus'; paneId: string }
  | { type: 'closePane'; paneId: string }
  | { type: 'dragStart'; drag: Drag }
  | { type: 'dragOver'; over: DropTarget }
  | { type: 'clearOver' }
  | { type: 'dragEnd' }
  | { type: 'drop'; target: DropTarget }
  | { type: 'toggleRow'; id: string }
  | { type: 'togglePane'; id: string }
  | { type: 'removeTarget'; id: string }
  | { type: 'sync'; sessionIds: string[]; runningIds: string[] };

export interface DropContext {
  /** Sessions that can receive input (running, not read-only). */
  runningIds: string[];
}

function sameTarget(a: DropTarget | null, b: DropTarget): boolean {
  return Boolean(a) && a!.type === b.type && (a!.type !== 'pane' || b.type !== 'pane' || a!.id === b.id);
}

export function accepts(state: WorkspaceState, target: DropTarget, ctx: DropContext): boolean {
  const drag = state.drag;
  if (!drag) return false;
  if (target.type === 'pane') return drag.kind === 'session' || drag.id !== target.id;
  if (drag.kind !== 'session') return false;
  if (target.type === 'slot') return state.panes.length < MAX_PANES;
  return ctx.runningIds.includes(drag.id) && !state.targets.includes(drag.id);
}

function addPane(state: WorkspaceState, sessionId: string): WorkspaceState {
  const id = `p${state.nextPane}`;
  return { ...state, panes: [...state.panes, { id, sessionId }], nextPane: state.nextPane + 1, active: id };
}

/** Shows a session: focuses the pane already showing it, else replaces the active pane, else adds one. */
function open(state: WorkspaceState, sessionId: string): WorkspaceState {
  const shown = state.panes.find((p) => p.sessionId === sessionId);
  if (shown) return { ...state, active: shown.id };
  const active = state.panes.find((p) => p.id === state.active);
  if (!active) return addPane(state, sessionId);
  return { ...state, panes: state.panes.map((p) => (p.id === active.id ? { ...p, sessionId } : p)) };
}

/** Shows a session in a new pane when there is room, else like `open`. */
function openNew(state: WorkspaceState, sessionId: string): WorkspaceState {
  const shown = state.panes.find((p) => p.sessionId === sessionId);
  if (shown) return { ...state, active: shown.id };
  return state.panes.length < MAX_PANES ? addPane(state, sessionId) : open(state, sessionId);
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
  if (target.type === 'pane') {
    if (drag.kind === 'pane') return swap(state, drag.id, target.id);
    return { ...state, panes: state.panes.map((p) => (p.id === target.id ? { ...p, sessionId: drag.id } : p)), active: target.id };
  }
  if (target.type === 'slot') return addPane(state, drag.id);
  return { ...state, targets: [...state.targets, drag.id] };
}

function toggle(map: Record<string, boolean>, id: string): Record<string, boolean> {
  return { ...map, [id]: !map[id] };
}

export function reducer(state: WorkspaceState, action: Action, ctx: DropContext = { runningIds: [] }): WorkspaceState {
  switch (action.type) {
    case 'open':
      return open(state, action.sessionId);
    case 'openNew':
      return openNew(state, action.sessionId);
    case 'focus':
      return state.panes.some((p) => p.id === action.paneId) ? { ...state, active: action.paneId } : state;
    case 'closePane': {
      const panes = state.panes.filter((p) => p.id !== action.paneId);
      const active = state.active === action.paneId ? (panes[0]?.id ?? null) : state.active;
      return { ...state, panes, active };
    }
    case 'dragStart':
      return { ...state, drag: action.drag, over: null };
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
    case 'removeTarget':
      return { ...state, targets: state.targets.filter((t) => t !== action.id) };
    case 'sync': {
      // Sessions removed elsewhere drop out of panes; ended ones stop receiving input.
      const known = new Set(action.sessionIds);
      const panes = state.panes.filter((p) => known.has(p.sessionId));
      const targets = state.targets.filter((t) => action.runningIds.includes(t));
      const active = panes.some((p) => p.id === state.active) ? state.active : (panes[0]?.id ?? null);
      if (panes.length === state.panes.length && targets.length === state.targets.length && active === state.active) return state;
      return { ...state, panes, targets, active };
    }
    default:
      return state;
  }
}
