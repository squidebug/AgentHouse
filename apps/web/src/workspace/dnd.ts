import type { DragEvent } from 'react';
import { accepts, type Action, type Drag, type DropContext, type DropTarget, type WorkspaceState } from './state';

/** Native HTML drag-and-drop wired to the workspace reducer. */
export interface Dnd {
  dragging: Drag | null;
  start: (drag: Drag) => (event: DragEvent) => void;
  over: (target: DropTarget) => (event: DragEvent) => void;
  drop: (target: DropTarget) => (event: DragEvent) => void;
  isOver: (target: DropTarget) => boolean;
  canDrop: (target: DropTarget) => boolean;
}

export function makeDnd(state: WorkspaceState, dispatch: (action: Action) => void, ctx: DropContext): Dnd {
  const isOver = (target: DropTarget) => {
    const over = state.over;
    if (!over || over.type !== target.type) return false;
    return over.type !== 'pane' || target.type !== 'pane' || over.id === target.id;
  };
  return {
    dragging: state.drag,
    isOver,
    canDrop: (target) => accepts(state, target, ctx),
    start: (drag) => (event) => {
      event.stopPropagation(); // a chip inside a draggable header starts its own drag
      try {
        event.dataTransfer.setData('text/plain', drag.id);
        event.dataTransfer.effectAllowed = 'move';
      } catch {
        // some browsers restrict dataTransfer here; the reducer state drives the drop
      }
      dispatch({ type: 'dragStart', drag });
    },
    over: (target) => (event) => {
      if (!accepts(state, target, ctx)) return; // bubbles to the root, which clears the highlight
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'move';
      if (!isOver(target)) dispatch({ type: 'dragOver', over: target });
    },
    drop: (target) => (event) => {
      event.preventDefault();
      event.stopPropagation();
      dispatch({ type: 'drop', target });
    },
  };
}
