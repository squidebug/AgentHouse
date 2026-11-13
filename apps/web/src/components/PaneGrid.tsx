import { Box, Button, ButtonBase, IconButton, Tooltip, Typography } from '@mui/material';
import { useCallback, useMemo, useRef, type DragEvent } from 'react';
import { isAgentBusy, type AgentInfo, type DelegationInfo, type SessionInfo, type SessionLink, type ThemeMode } from '@agenthouse/protocol';
import { t } from '../strings';
import { motion, v } from '../theme/tokens';
import { childAgents } from '../workspace/agents';
import type { Dnd } from '../workspace/dnd';
import type { FlowRow } from '../workspace/flow';
import { MAX_PANES, paneModes, shownMode, type Action, type Pane, type PaneMode, type WorkspaceState } from '../workspace/state';
import { ConversationView, type DelegateTarget, type DelegationView } from './ConversationView';
import { Boundary } from './Boundary';
import { AgentSubtitle, agentDetails, agentTitle, Details, SessionSubtitle, sessionDetails } from './Details';
import { FlowView } from './FlowView';
import { BackIcon, ChatIcon, ChevronIcon, CloseIcon, DelegateIcon, FlowIcon, Grip, PlusIcon, TerminalIcon } from './icons';
import { AgentStatusIcon, StatusIcon } from './StatusIcon';
import { switchSide, switchTrack } from './switch';
import { TerminalView } from './TerminalView';

// Chips for this many sub-agents at most; the tree has them all.
const MAX_CHIPS = 6;

/** Delegation: who works for whom, what was handed over, and how to hand more over or bring answers back. */
export interface DelegationProps {
  links: SessionLink[];
  delegations: DelegationInfo[];
  onDelegate: (parentId: string, childId: string, text: string) => void;
  onDeliver: (task: DelegationInfo, header: string) => void;
}

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
// Two columns at most, however wide the window: three or four panes make two rows, whose height is
// what the rows are sized for. A main area too narrow for two columns stacks the panes.
const COLUMNS = 'repeat(auto-fit, minmax(max(min(420px, 100%), calc((100% - 12px) / 2)), 1fr))';

export function PaneGrid({ state, dispatch, dnd, sessionById, mode, windowsBuild, onNew, ...delegation }: Props) {
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
      <Box sx={{ flex: 1, minWidth: 0, display: 'grid', gridTemplateColumns: COLUMNS, gridAutoRows: rowHeight, gap: '12px' }}>
        {state.panes.map((pane, index) => {
          const session = sessionById(pane.sessionId);
          return session ? (
            <PaneView
              key={pane.id}
              pane={pane}
              // The third of three has its row to itself.
              wide={state.panes.length === 3 && index === 2}
              session={session}
              state={state}
              dispatch={dispatch}
              dnd={dnd}
              theme={mode}
              windowsBuild={windowsBuild}
              sessionById={sessionById}
              {...delegation}
            />
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
          <Tooltip title={t.newSession} placement="left">
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
  { mode: 'flow', label: t.flow, Icon: FlowIcon },
] as const;

/** Terminal, conversation or flow, as a switch in the pane header; only the modes the session has. */
function ModeSwitch({ mode, modes, onChange }: { mode: PaneMode; modes: PaneMode[]; onChange: (mode: PaneMode) => void }) {
  return (
    <Box role="group" sx={{ flex: 'none', ...switchTrack }}>
      {MODES.filter((m) => modes.includes(m.mode)).map(({ mode: value, label, Icon }) => (
        <Tooltip key={value} title={value === 'flow' ? label : t.withModeShortcut(label)}>
          <IconButton
            aria-label={label}
            aria-pressed={mode === value}
            onClick={() => onChange(value)}
            sx={{ width: 30, height: 28, ...switchSide(mode === value) }}
          >
            <Icon size={16} />
          </IconButton>
        </Tooltip>
      ))}
    </Box>
  );
}

/** The sub-agents a pane's session or agent started, as chips: busy ones first, then the latest finished. */
const chipSx = { height: 28, display: 'inline-flex', alignItems: 'center', gap: '6px', px: '10px', borderRadius: '8px', bgcolor: v.surface2, fontSize: 12, fontWeight: 500, transition: `background-color ${motion.fast}`, '&:hover': { bgcolor: v.surface3 } } as const;

/** The sessions delegated under a pane's session: open one, or drop a piece of the conversation on it to hand it over. */
function DelegateChips({ delegates, dispatch, dnd, onDropText }: { delegates: SessionInfo[]; dispatch: (action: Action) => void; dnd: Dnd; onDropText: (childId: string, text: string) => void }) {
  if (!delegates.length) return null;
  return (
    <Box role="group" aria-label={t.delegate} sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px', p: '0 12px 8px 36px' }}>
      {delegates.map((child) => {
        const target = { type: 'delegate' as const, id: child.id };
        const over = dnd.isOver(target);
        return (
          <ButtonBase
            key={child.id}
            draggable
            onDragStart={dnd.start({ kind: 'session', id: child.id })}
            onDragOver={dnd.over(target)}
            onDrop={(event) => {
              const moving = dnd.dragging;
              const accepted = dnd.canDrop(target);
              dnd.drop(target)(event);
              if (accepted && moving?.kind === 'item') onDropText(child.id, moving.text);
            }}
            onClick={() => dispatch({ type: 'openNew', sessionId: child.id })}
            aria-label={`${child.title} ${t.delegate}`}
            sx={{ ...chipSx, boxShadow: over ? `0 0 0 2px ${v.primary}` : 'none', bgcolor: over ? v.dropBg : v.surface2 }}
          >
            <StatusIcon status={child.status} size={12} />
            <DelegateIcon size={13} style={{ flex: 'none', color: v.primary }} />
            {child.title}
          </ButtonBase>
        );
      })}
    </Box>
  );
}

function AgentChips({ session, parentId, dispatch, dnd }: { session: SessionInfo; parentId: string | null; dispatch: (action: Action) => void; dnd: Dnd }) {
  const children = childAgents(session.agents, parentId);
  if (!children.length) return null;
  const busy = children.filter(isAgentBusy);
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
            sx={chipSx}
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

interface PaneViewProps extends DelegationProps {
  pane: Pane;
  /** Spans the whole row. */
  wide: boolean;
  session: SessionInfo;
  state: WorkspaceState;
  dispatch: (action: Action) => void;
  dnd: Dnd;
  theme: ThemeMode;
  windowsBuild: number | null;
  sessionById: (id: string) => SessionInfo | undefined;
}

function PaneView({ pane, wide, session, state, dispatch, dnd, theme, windowsBuild, sessionById, links, delegations, onDelegate, onDeliver }: PaneViewProps) {
  const active = pane.id === state.active;
  const open = Boolean(state.paneOpen[pane.id]);
  const target = { type: 'pane' as const, id: pane.id };
  const dragged = dnd.dragging?.kind === 'pane' && dnd.dragging.id === pane.id;
  // A sub-agent's pane shows its conversation; it has no terminal of its own.
  const agentId = pane.agentId ?? null;
  const agent = agentId ? session.agents.find((a) => a.id === agentId) : undefined;
  const hasConversation = agentId ? Boolean(agent?.transcriptPath) : session.transcripts.length > 0;
  // An ended session from an earlier host has only its conversation (and flow) left.
  const modes = paneModes(pane, session);
  const mode = shownMode(state.paneMode[pane.id], modes);
  const focus = () => dispatch({ type: 'focus', paneId: pane.id });
  // An agent opened from a conversation takes this pane, with the way back.
  const openAgent = useCallback((id: string) => dispatch({ type: 'drill', paneId: pane.id, sessionId: session.id, agentId: id }), [dispatch, pane.id, session.id]);
  // As they are now, on every draw: `sessionById` is one function for good, so it cannot say when they changed.
  const placed = links
    .filter((l) => l.parentId === session.id)
    .map((l) => sessionById(l.childId))
    .filter((s): s is SessionInfo => Boolean(s));
  const openRow = useCallback(
    (row: FlowRow) => {
      if (row.kind === 'agent') dispatch({ type: 'drill', paneId: pane.id, sessionId: row.session.id, agentId: row.agent.id });
      else dispatch({ type: 'drill', paneId: pane.id, sessionId: row.session.id, mode: row.session.screen ? 'terminal' : 'conversation' });
    },
    [dispatch, pane.id],
  );
  const canGoBack = Boolean(pane.history?.length);
  // A session's pane (not a sub-agent's) hands work to the sessions delegated under it.
  const delegates = agentId ? [] : placed.filter((child) => links.some((l) => l.kind === 'delegate' && l.parentId === session.id && l.childId === child.id));
  // What the conversation needs of them is who they are and what they are called. Kept the same while
  // that is the same, so the conversation is not drawn again each time one of them reports a status.
  const delegateKey = delegates.map((child) => `${child.id}\n${child.title}`).join('\n\n');
  const targets = useMemo<DelegateTarget[]>(() => delegates.map(({ id, title }) => ({ id, title })), [delegateKey]);
  const handOver = useCallback((childId: string, text: string) => onDelegate(session.id, childId, text), [onDelegate, session.id]);
  // `dnd` is made anew on every draw; the newest one starts the drag.
  const dndRef = useRef(dnd);
  dndRef.current = dnd;
  const dragText = useCallback(
    (entryId: string, text: string) => (event: DragEvent) => dndRef.current.start({ kind: 'item', id: entryId, sessionId: session.id, text })(event),
    [session.id],
  );
  const titleOf = useCallback((id: string) => sessionById(id)?.title ?? id, [sessionById]);
  const handed = useMemo<DelegationView>(
    () => ({
      tasks: agentId ? [] : delegations.filter((d) => d.parentId === session.id),
      titleOf,
      onDeliver: (task) => onDeliver(task, t.delegationResult(titleOf(task.childId))),
    }),
    [agentId, delegations, session.id, titleOf, onDeliver],
  );
  const title = agentId ? (agent ? agentTitle(agent) : t.subagent) : session.title;

  return (
    <Box
      component="section"
      aria-label={title}
      onDragOver={dnd.over(target)}
      onDrop={(event) => {
        // A piece of a parent's conversation dropped on its delegate's pane is work for it.
        const moving = dnd.dragging;
        const accepted = dnd.canDrop(target);
        dnd.drop(target)(event);
        if (accepted && moving?.kind === 'item') onDelegate(moving.sessionId, session.id, moving.text);
      }}
      sx={{
        position: 'relative',
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        gridColumn: wide ? '1 / -1' : 'auto',
        borderRadius: '16px',
        bgcolor: v.surface,
        // A card; the one that takes the typing is a step higher, inside its outline.
        boxShadow: active ? `0 0 0 2px ${v.primary}, ${v.shadow2}` : `0 0 0 2px transparent, ${v.shadow1}`,
        transition: `box-shadow ${motion.base}`,
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
        {canGoBack && (
          <Tooltip title={t.back}>
            <IconButton aria-label={t.back} onClick={() => dispatch({ type: 'back', paneId: pane.id })} sx={{ flex: 'none', width: 32, height: 32, ml: '-6px', color: v.on2 }}>
              <BackIcon size={16} />
            </IconButton>
          </Tooltip>
        )}
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
        {modes.length > 1 && <ModeSwitch mode={mode} modes={modes} onChange={(next) => dispatch({ type: 'setMode', paneId: pane.id, mode: next })} />}
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
      <DelegateChips delegates={delegates} dispatch={dispatch} dnd={dnd} onDropText={handOver} />
      <AgentChips session={session} parentId={agentId} dispatch={dispatch} dnd={dnd} />
      <Box
        onPointerDown={mode !== 'terminal' ? focus : undefined}
        sx={{ flex: 1, minHeight: 0, m: '0 12px 12px', p: mode !== 'terminal' ? '4px 4px 4px 14px' : '8px 4px 4px 10px', borderRadius: '10px', bgcolor: v.termBg, boxShadow: v.well, overflow: 'hidden' }}
      >
        <Boundary resetKey={`${pane.sessionId}/${agentId}/${mode}`} fallback={<Typography sx={{ p: 1, color: v.termDim }}>{t.cannotShow}</Typography>}>
        {mode === 'flow' ? (
          <FlowView session={session} placed={placed} links={links} focusAgent={state.flowFocus?.paneId === pane.id ? state.flowFocus.agentId : null} onOpen={openRow} />
        ) : mode === 'conversation' && hasConversation ? (
          <ConversationView
            sessionId={session.id}
            agentId={agentId}
            onOpenAgent={openAgent}
            delegates={targets}
            onDelegate={handOver}
            onDragText={dragText}
            delegations={handed}
          />
        ) : agentId ? (
          <Typography sx={{ p: 1, color: v.termDim }}>{t.noConversation}</Typography>
        ) : session.screen ? (
          <TerminalView sessionId={session.id} mode={theme} windowsBuild={windowsBuild} onFocus={focus} autoFocus={active} />
        ) : (
          <Typography sx={{ p: 1, color: v.termDim }}>{t.noScreen}</Typography>
        )}
        </Boundary>
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
          {dnd.dragging?.kind === 'pane' ? t.swap : dnd.dragging?.kind === 'item' ? t.delegate : t.openHere}
        </Box>
      )}
    </Box>
  );
}
