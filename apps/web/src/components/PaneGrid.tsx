import { Box, Button, ButtonBase, IconButton, Tooltip, Typography } from '@mui/material';
import type { SessionInfo, ThemeMode } from '@agenthouse/protocol';
import { t } from '../strings';
import { v } from '../theme/tokens';
import type { Dnd } from '../workspace/dnd';
import { MAX_PANES, type Action, type Pane, type WorkspaceState } from '../workspace/state';
import { Details, SessionSubtitle, sessionDetails } from './Details';
import { ChevronIcon, CloseIcon, Grip, PlusIcon } from './icons';
import { StatusIcon } from './StatusIcon';
import { TerminalView } from './TerminalView';

interface Props {
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

export function PaneGrid({ state, dispatch, dnd, sessionById, mode, windowsBuild, onNew }: Props) {
  const canAdd = state.panes.length < MAX_PANES;
  const rows = state.panes.length > 2 ? 2 : 1;
  const rowHeight = `max(320px, calc((100vh - ${CHROME_PX + (rows - 1) * 12}px) / ${rows}))`;
  const draggingSession = dnd.dragging?.kind === 'session';
  const slotOver = dnd.isOver({ type: 'slot' });
  const slotDrop = { onDragOver: dnd.over({ type: 'slot' }), onDrop: dnd.drop({ type: 'slot' }) };

  if (!state.panes.length) {
    return (
      <Box
        {...slotDrop}
        sx={{
          height: `max(320px, calc(100vh - ${CHROME_PX}px))`,
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

  return (
    <Box sx={{ display: 'flex', alignItems: 'stretch', gap: '12px' }}>
      <Box sx={{ flex: 1, minWidth: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(420px, 100%), 1fr))', gridAutoRows: rowHeight, gap: '12px' }}>
        {state.panes.map((pane) => {
          const session = sessionById(pane.sessionId);
          return session ? (
            <PaneView key={pane.id} pane={pane} session={session} state={state} dispatch={dispatch} dnd={dnd} mode={mode} windowsBuild={windowsBuild} />
          ) : null;
        })}
      </Box>
      {canAdd && (
        // A narrow strip keeps the panes at full size; it is also where a dragged session makes a new pane.
        <Box
          {...slotDrop}
          sx={{
            flex: 'none',
            width: 56,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '16px',
            border: '1.5px dashed',
            borderColor: draggingSession ? v.primary : 'transparent',
            bgcolor: slotOver ? v.dropBg : 'transparent',
          }}
        >
          <Tooltip title={t.newPane} placement="left">
            <IconButton aria-label={t.newSession} onClick={onNew} sx={{ width: 44, height: 44, color: draggingSession ? v.primary : v.on2 }}>
              <PlusIcon size={20} />
            </IconButton>
          </Tooltip>
        </Box>
      )}
    </Box>
  );
}

interface PaneViewProps {
  pane: Pane;
  session: SessionInfo;
  state: WorkspaceState;
  dispatch: (action: Action) => void;
  dnd: Dnd;
  mode: ThemeMode;
  windowsBuild: number | null;
}

function PaneView({ pane, session, state, dispatch, dnd, mode, windowsBuild }: PaneViewProps) {
  const active = pane.id === state.active;
  const open = Boolean(state.paneOpen[pane.id]);
  const target = { type: 'pane' as const, id: pane.id };
  const dragged = dnd.dragging?.kind === 'pane' && dnd.dragging.id === pane.id;

  return (
    <Box
      component="section"
      aria-label={session.title}
      onDragOver={dnd.over(target)}
      onDrop={dnd.drop(target)}
      sx={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        borderRadius: '16px',
        bgcolor: v.surface,
        boxShadow: active ? `0 0 0 2px ${v.primary}` : 'none',
        opacity: dragged ? 0.5 : 1,
      }}
    >
      <Box
        className="ah-phead"
        draggable
        onDragStart={dnd.start({ kind: 'pane', id: pane.id })}
        sx={{ display: 'flex', alignItems: 'center', gap: '10px', p: '10px 8px 8px 10px', cursor: 'grab' }}
      >
        <Grip className="ah-grip" />
        <StatusIcon status={session.status} />
        <ButtonBase
          onClick={() => dispatch({ type: 'focus', paneId: pane.id })}
          sx={{ flex: 1, minWidth: 0, flexDirection: 'column', alignItems: 'flex-start', textAlign: 'left', borderRadius: '6px' }}
        >
          <Typography noWrap sx={{ maxWidth: '100%', fontSize: 14, lineHeight: '20px', fontWeight: 600 }}>
            {session.title}
          </Typography>
          <SessionSubtitle session={session} />
        </ButtonBase>
        {session.state === 'exited' && (
          <Box component="span" sx={{ flex: 'none', height: 26, px: 1.25, display: 'inline-flex', alignItems: 'center', borderRadius: '8px', bgcolor: v.surface2, fontSize: 12 }}>
            {t.exited}
          </Box>
        )}
        <IconButton
          aria-label={`${session.title} ${t.details}`}
          aria-expanded={open}
          onClick={() => dispatch({ type: 'togglePane', id: pane.id })}
          sx={{ width: 36, height: 36, color: v.on2 }}
        >
          <ChevronIcon open={open} size={16} />
        </IconButton>
        <IconButton aria-label={`${session.title} ${t.closePane}`} onClick={() => dispatch({ type: 'closePane', paneId: pane.id })} sx={{ width: 36, height: 36, color: v.on2 }}>
          <CloseIcon size={16} />
        </IconButton>
      </Box>
      {open && (
        <Box sx={{ px: '8px' }}>
          <Details items={sessionDetails(session)} />
        </Box>
      )}
      <Box sx={{ flex: 1, minHeight: 0, m: '0 12px 12px', p: '8px 4px 4px 10px', borderRadius: '10px', bgcolor: v.termBg, overflow: 'hidden' }}>
        <TerminalView sessionId={session.id} mode={mode} windowsBuild={windowsBuild} onFocus={() => dispatch({ type: 'focus', paneId: pane.id })} />
      </Box>
      {dnd.isOver(target) && (
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: '16px',
            border: `2px dashed ${v.primary}`,
            bgcolor: v.dropBg,
            color: v.primary,
            fontSize: 14,
            fontWeight: 600,
            pointerEvents: 'none',
          }}
        >
          {dnd.dragging?.kind === 'pane' ? t.swap : t.openHere}
        </Box>
      )}
    </Box>
  );
}
