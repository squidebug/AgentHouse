import { Box, Button, ButtonBase, IconButton, Tooltip, Typography } from '@mui/material';
import { useCallback } from 'react';
import type { AgentInfo, SessionInfo, ThemeMode } from '@agenthouse/protocol';
import { t } from '../strings';
import { v } from '../theme/tokens';
import { childAgents } from '../workspace/agents';
import type { Dnd } from '../workspace/dnd';
import { MAX_PANES, type Action, type Pane, type PaneMode, type WorkspaceState } from '../workspace/state';
import { ConversationView } from './ConversationView';
import { AgentSubtitle, agentDetails, agentTitle, Details, SessionSubtitle, sessionDetails } from './Details';
import { ChatIcon, ChevronIcon, CloseIcon, Grip, PlusIcon, TerminalIcon } from './icons';
import { AgentStatusIcon, StatusIcon } from './StatusIcon';
import { TerminalView } from './TerminalView';

// Chips for this many sub-agents at most; the tree has them all.
const MAX_CHIPS = 6;

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
  const draggingSession = dnd.dragging?.kind === 'session' || dnd.dragging?.kind === 'agent';
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
            <PaneView key={pane.id} pane={pane} session={session} state={state} dispatch={dispatch} dnd={dnd} theme={mode} windowsBuild={windowsBuild} />
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

const MODES = [
  { mode: 'terminal', label: t.terminal, Icon: TerminalIcon },
  { mode: 'conversation', label: t.conversation, Icon: ChatIcon },
] as const;

/** Terminal or conversation, as a two-part switch in the pane header. */
function ModeSwitch({ mode, onChange }: { mode: PaneMode; onChange: (mode: PaneMode) => void }) {
  return (
    <Box role="group" sx={{ flex: 'none', display: 'inline-flex', p: '2px', borderRadius: '10px', bgcolor: v.surface2 }}>
      {MODES.map(({ mode: value, label, Icon }) => (
        <Tooltip key={value} title={label}>
          <IconButton
            aria-label={label}
            aria-pressed={mode === value}
            onClick={() => onChange(value)}
            sx={{ width: 30, height: 28, borderRadius: '8px', color: mode === value ? v.on : v.on2, bgcolor: mode === value ? v.surface : 'transparent', '&:hover': { bgcolor: mode === value ? v.surface : v.surface3 } }}
          >
            <Icon size={16} />
          </IconButton>
        </Tooltip>
      ))}
    </Box>
  );
}

/** The sub-agents a pane's session or agent started, as chips: busy ones first, then the latest finished. */
function AgentChips({ session, parentId, dispatch, dnd }: { session: SessionInfo; parentId: string | null; dispatch: (action: Action) => void; dnd: Dnd }) {
  const children = childAgents(session.agents, parentId);
  if (!children.length) return null;
  const busy = children.filter((a) => a.state === 'running' || a.asking);
  const finished = children.filter((a) => !busy.includes(a)).reverse();
  const chips = [...busy, ...finished].slice(0, MAX_CHIPS);
  return (
    <Box role="group" aria-label={t.subagent} sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', p: '0 12px 8px 36px' }}>
      {chips.map((agent: AgentInfo) => (
        <Tooltip key={agent.id} title={agentTitle(agent)}>
          <ButtonBase
            draggable
            onDragStart={dnd.start({ kind: 'agent', id: agent.id, sessionId: session.id })}
            onClick={() => dispatch({ type: 'openNew', sessionId: session.id, agentId: agent.id })}
            aria-label={`${agentTitle(agent)} ${t.openConversation}`}
            sx={{ height: 28, display: 'inline-flex', alignItems: 'center', gap: '6px', px: '10px', borderRadius: '8px', bgcolor: v.surface2, fontSize: 12, fontWeight: 500, '&:hover': { bgcolor: v.surface3 } }}
          >
            <AgentStatusIcon agent={agent} size={12} />
            {agent.agentType}
          </ButtonBase>
        </Tooltip>
      ))}
      {children.length > chips.length && <Typography sx={{ fontSize: 12, color: v.on2 }}>{t.moreAgents(children.length - chips.length)}</Typography>}
    </Box>
  );
}

interface PaneViewProps {
  pane: Pane;
  session: SessionInfo;
  state: WorkspaceState;
  dispatch: (action: Action) => void;
  dnd: Dnd;
  theme: ThemeMode;
  windowsBuild: number | null;
}

function PaneView({ pane, session, state, dispatch, dnd, theme, windowsBuild }: PaneViewProps) {
  const active = pane.id === state.active;
  const open = Boolean(state.paneOpen[pane.id]);
  const target = { type: 'pane' as const, id: pane.id };
  const dragged = dnd.dragging?.kind === 'pane' && dnd.dragging.id === pane.id;
  // A sub-agent's pane shows its conversation; it has no terminal of its own.
  const agentId = pane.agentId ?? null;
  const agent = agentId ? session.agents.find((a) => a.id === agentId) : undefined;
  const hasConversation = agentId ? Boolean(agent?.transcriptPath) : session.transcripts.length > 0;
  // An ended session from an earlier host has only its conversation left.
  const mode: PaneMode = agentId || !session.screen ? 'conversation' : hasConversation ? (state.paneMode[pane.id] ?? 'terminal') : 'terminal';
  const focus = () => dispatch({ type: 'focus', paneId: pane.id });
  const openAgent = useCallback((id: string) => dispatch({ type: 'openNew', sessionId: session.id, agentId: id }), [dispatch, session.id]);
  const title = agentId ? (agent ? agentTitle(agent) : t.subagent) : session.title;

  return (
    <Box
      component="section"
      aria-label={title}
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
        {agent ? <AgentStatusIcon agent={agent} /> : <StatusIcon status={session.status} />}
        <ButtonBase
          onClick={() => dispatch({ type: 'focus', paneId: pane.id })}
          sx={{ flex: 1, minWidth: 0, flexDirection: 'column', alignItems: 'flex-start', textAlign: 'left', borderRadius: '6px' }}
        >
          <Typography noWrap sx={{ maxWidth: '100%', fontSize: 14, lineHeight: '20px', fontWeight: 600 }}>
            {title}
          </Typography>
          {agentId ? agent && <AgentSubtitle agent={agent} /> : <SessionSubtitle session={session} />}
        </ButtonBase>
        {!agentId && session.state === 'exited' && (
          <Box component="span" sx={{ flex: 'none', height: 26, px: 1.25, display: 'inline-flex', alignItems: 'center', borderRadius: '8px', bgcolor: v.surface2, fontSize: 12 }}>
            {t.exited}
          </Box>
        )}
        {!agentId && session.screen && hasConversation && <ModeSwitch mode={mode} onChange={(next) => dispatch({ type: 'setMode', paneId: pane.id, mode: next })} />}
        <IconButton
          aria-label={`${title} ${t.details}`}
          aria-expanded={open}
          onClick={() => dispatch({ type: 'togglePane', id: pane.id })}
          sx={{ width: 36, height: 36, color: v.on2 }}
        >
          <ChevronIcon open={open} size={16} />
        </IconButton>
        <IconButton aria-label={`${title} ${t.closePane}`} onClick={() => dispatch({ type: 'closePane', paneId: pane.id })} sx={{ width: 36, height: 36, color: v.on2 }}>
          <CloseIcon size={16} />
        </IconButton>
      </Box>
      {open && (
        <Box sx={{ px: '8px' }}>
          <Details items={agent ? agentDetails(agent, session.agents, session) : sessionDetails(session)} />
        </Box>
      )}
      <AgentChips session={session} parentId={agentId} dispatch={dispatch} dnd={dnd} />
      <Box
        onPointerDown={mode === 'conversation' ? focus : undefined}
        sx={{ flex: 1, minHeight: 0, m: '0 12px 12px', p: mode === 'conversation' ? '4px 4px 4px 14px' : '8px 4px 4px 10px', borderRadius: '10px', bgcolor: v.termBg, overflow: 'hidden' }}
      >
        {mode === 'conversation' && hasConversation ? (
          <ConversationView sessionId={session.id} agentId={agentId} onOpenAgent={openAgent} />
        ) : agentId ? (
          <Typography sx={{ p: 1, color: v.termDim }}>{t.noConversation}</Typography>
        ) : session.screen ? (
          <TerminalView sessionId={session.id} mode={theme} windowsBuild={windowsBuild} onFocus={focus} />
        ) : (
          <Typography sx={{ p: 1, color: v.termDim }}>{t.noScreen}</Typography>
        )}
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
