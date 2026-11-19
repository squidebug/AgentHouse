// The workspace's stacks where the user put them: side by side or one above
// the other, each with its share of the room, and between two of them a divider
// that moves that share. What a stack is, is PaneStack's; where each lies is
// worked out in workspace/arrange.ts.
import { Box, Button, Typography } from '@mui/material';
import { useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import type { SessionInfo, ThemeMode } from '@agenthouse/protocol';
import { t } from '../strings';
import { motion, v } from '../theme/tokens';
import { arrange, dragged, GAP_PX, MIN_HEIGHT_PX, MIN_WIDTH_PX, shared, type Box as Place, type DividerAt, type Span } from '../workspace/arrange';
import type { Dnd } from '../workspace/dnd';
import type { Action, WorkspaceState } from '../workspace/state';
import { PlusIcon } from './icons';
import { PaneStack, type DelegationProps, type Tab } from './PaneStack';

interface Props extends DelegationProps {
  state: WorkspaceState;
  dispatch: (action: Action) => void;
  dnd: Dnd;
  sessionById: (id: string) => SessionInfo | undefined;
  mode: ThemeMode;
  windowsBuild: number | null;
  onNew: () => void;
}

// App bar, paddings and the composer take roughly this much of the viewport.
const CHROME_PX = 196;
// A step of the keyboard on a divider, and the least it leaves a part, as shares of their split.
const STEP = 0.02;
const LEAST = 0.1;
// A main area too narrow for two stacks side by side has them all one above the other, each as wide as it is.
const NARROW = '@container ah-panes (max-width: 851px)';

const length = ({ share, px }: Span) => {
  const fixed = `${Math.round(px * 100) / 100}px`;
  return share ? `calc(${Math.round(share * 1e6) / 1e4}% + ${fixed})` : fixed;
};
/**
 * A box of the workspace, handed to the style sheet as values: a divider that is dragged changes
 * them many times a second, and no rule is made for each.
 */
const placedAt = (box: Place) => ({ '--ah-box-left': length(box.left), '--ah-box-top': length(box.top), '--ah-box-width': length(box.width), '--ah-box-height': length(box.height) }) as CSSProperties;
const PLACED = { position: 'absolute', left: 'var(--ah-box-left)', top: 'var(--ah-box-top)', width: 'var(--ah-box-width)', height: 'var(--ah-box-height)' } as const;

/**
 * The room between two parts of a split. Dragged, it gives one of them what it takes from the other;
 * a double click shares their room evenly, and the arrow keys move it by a step. The terminals in
 * them tell their PTYs once the dragging stops.
 */
function Divider({ at, dispatch }: { at: DividerAt; dispatch: (action: Action) => void }) {
  const [held, setHeld] = useState(false);
  const { split, index } = at;
  const row = split.dir === 'row';
  const first = split.sizes[index] ?? 0;
  const both = first + (split.sizes[index + 1] ?? 0);
  const resize = (sizes: number[] | null) => {
    if (sizes) dispatch({ type: 'resize', splitId: split.id, sizes });
  };
  const drag = (event: PointerEvent<HTMLDivElement>) => {
    // Its place is told in shares of the workspace, which is what it lies in.
    const whole = event.currentTarget.parentElement!.getBoundingClientRect();
    resize(row ? dragged(at, event.clientX - whole.left, whole.width, GAP_PX, MIN_WIDTH_PX) : dragged(at, event.clientY - whole.top, whole.height, GAP_PX, MIN_HEIGHT_PX));
  };
  const onKey = (event: KeyboardEvent) => {
    const steps: Record<string, number> = row ? { ArrowLeft: -STEP, ArrowRight: STEP } : { ArrowUp: -STEP, ArrowDown: STEP };
    const step = steps[event.key];
    if (step === undefined) return;
    event.preventDefault();
    resize(shared(split.sizes, index, first + step, LEAST));
  };
  return (
    <Box
      role="separator"
      aria-label={t.resizePanes}
      aria-orientation={row ? 'vertical' : 'horizontal'}
      aria-valuenow={both > 0 ? Math.round((first / both) * 100) : 50}
      aria-valuemin={0}
      aria-valuemax={100}
      tabIndex={0}
      style={placedAt(at.box)}
      // Nothing under the pointer is selected while it is dragged.
      onMouseDown={(event) => event.preventDefault()}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        setHeld(true);
      }}
      onPointerMove={(event) => held && drag(event)}
      onPointerUp={() => setHeld(false)}
      onLostPointerCapture={() => setHeld(false)}
      onDoubleClick={() => resize(shared(split.sizes, index, both / 2))}
      onKeyDown={onKey}
      sx={{
        ...PLACED,
        cursor: row ? 'col-resize' : 'row-resize',
        touchAction: 'none',
        userSelect: 'none',
        outline: 'none',
        // A line in the room between the two, while it is under the pointer, held, or has the keyboard.
        '&::after': {
          content: '""',
          position: 'absolute',
          ...(row ? { left: 4, width: 4, top: 16, bottom: 16 } : { top: 4, height: 4, left: 16, right: 16 }),
          borderRadius: '2px',
          bgcolor: held ? v.primary : v.outline,
          opacity: held ? 1 : 0,
          transition: `opacity ${motion.fast}`,
        },
        '&:hover::after': { opacity: 1 },
        '&:focus-visible::after': { opacity: 1, bgcolor: v.primary },
        [NARROW]: { display: 'none' },
      }}
    />
  );
}

export function PaneGrid({ state, dispatch, dnd, sessionById, mode, windowsBuild, onNew, ...delegation }: Props) {
  const draggingSession = dnd.dragging?.kind === 'session' || dnd.dragging?.kind === 'agent';
  const slot = { type: 'slot' as const };
  const slotOver = dnd.isOver(slot);
  const height = `max(320px, calc(100vh - ${CHROME_PX}px))`;

  if (!state.layout) {
    return (
      <Box
        onDragOver={dnd.over(slot)}
        onDrop={dnd.drop(slot)}
        sx={{
          height,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: '16px',
          border: '1.5px dashed',
          borderColor: slotOver ? v.primary : v.outline,
          bgcolor: slotOver ? v.dropBg : 'transparent',
        }}
      >
        {draggingSession ? (
          <Typography sx={{ fontSize: 14, fontWeight: 600, color: v.primary }}>{t.dropHere}</Typography>
        ) : (
          <Button onClick={onNew} startIcon={<PlusIcon size={18} />} sx={{ color: v.on2 }}>
            {t.newSession}
          </Button>
        )}
      </Box>
    );
  }

  const { stacks, dividers } = arrange(state.layout, GAP_PX);
  // One stack keeps the whole room at any width. Several, in an area too narrow for them, lie one
  // above the other in the order they are read, each half as high as the room there is.
  const several = stacks.length > 1;
  const narrowed = several ? { [NARROW]: { position: 'static', width: 'auto', height: `max(320px, calc((100vh - ${CHROME_PX + GAP_PX}px) / 2))` } } : {};
  return (
    // The stacks follow the width of this area, not of the window: the tree beside it takes its own.
    <Box sx={{ containerType: 'inline-size', containerName: 'ah-panes', minWidth: 0 }}>
      <Box sx={{ position: 'relative', height, ...(several ? { [NARROW]: { height: 'auto', display: 'flex', flexDirection: 'column', gap: `${GAP_PX}px` } } : {}) }}>
        {stacks.map(({ id, box }) => {
          const stack = state.stacks.find((one) => one.id === id);
          const tabs = (stack?.panes ?? []).flatMap((paneId): Tab[] => {
            const pane = state.panes.find((one) => one.id === paneId);
            const session = pane && sessionById(pane.sessionId);
            return pane && session ? [{ pane, session }] : [];
          });
          // Its sessions are not listed yet (the first list is on its way): its room is kept.
          if (!stack || !tabs.length) return null;
          return (
            // One element for a stack as long as there is that stack: however the splits around it change,
            // it is moved and sized, and its terminal stays up.
            <Box key={id} style={placedAt(box)} sx={{ ...PLACED, display: 'flex', ...narrowed }}>
              <PaneStack stack={stack} tabs={tabs} state={state} dispatch={dispatch} dnd={dnd} theme={mode} windowsBuild={windowsBuild} sessionById={sessionById} {...delegation} />
            </Box>
          );
        })}
        {dividers.map((at) => (
          <Divider key={`${at.split.id}/${at.index}`} at={at} dispatch={dispatch} />
        ))}
      </Box>
    </Box>
  );
}
