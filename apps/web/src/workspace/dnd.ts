import type { DragEvent } from 'react';
import { accepts, dropEffect, sameDrop, type Action, type Drag, type DropContext, type DropTarget, type WorkspaceState } from './state';

/** Native HTML drag-and-drop wired to the workspace reducer. */
export interface Dnd {
  dragging: Drag | null;
  start: (drag: Drag) => (event: DragEvent) => void;
  over: (target: DropTarget) => (event: DragEvent) => void;
  /** Everything a drop on this target does: to the layout, and what it asks of the server. */
  drop: (target: DropTarget) => (event: DragEvent) => void;
  isOver: (target: DropTarget) => boolean;
  canDrop: (target: DropTarget) => boolean;
}

/** What a drop asks of the server (DropEffect), as the page asks it. */
export interface DropRequests {
  /** A placed session goes back to the top. */
  onUnlink: (childId: string) => void;
  /** A piece of a conversation is work for a session delegated under the one it comes from. */
  onDelegate: (parentId: string, childId: string, text: string) => void;
}

export function makeDnd(state: WorkspaceState, dispatch: (action: Action) => void, ctx: DropContext, requests: DropRequests): Dnd {
  const isOver = (target: DropTarget) => state.over !== null && sameDrop(state.over, target);
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
      // Told from the state as it is: the drop ends the drag it is told from.
      const effect = dropEffect(state, target, ctx);
      dispatch({ type: 'drop', target });
      if (effect?.type === 'unlink') requests.onUnlink(effect.childId);
      else if (effect?.type === 'delegate') requests.onDelegate(effect.parentId, effect.childId, effect.text);
    },
  };
}
