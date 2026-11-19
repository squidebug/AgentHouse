// A stack of the workspace as a card: its panes as tabs where its name was, and
// the pane on top drawn under them (its terminal, its conversation or its
// flow). Where what is dragged over it would land is shown on it.
import { Box, ButtonBase, IconButton, Tooltip, Typography } from '@mui/material';
import { useCallback, useMemo, useRef, type DragEvent } from 'react';
import { isAgentBusy, type AgentInfo, type DelegationInfo, type SessionInfo, type SessionLink, type ThemeMode } from '@agenthouse/protocol';
import { t } from '../strings';
import { motion, v } from '../theme/tokens';
import { childAgents } from '../workspace/agents';
import { halves } from '../workspace/arrange';
import type { Dnd } from '../workspace/dnd';
import type { FlowRow } from '../workspace/flow';
import { paneModes, shownMode, type Action, type DropTarget, type Pane, type PaneMode, type Side, type Stack, type WorkspaceState } from '../workspace/state';
import { ConversationView, type DelegateTarget, type DelegationView } from './ConversationView';
import { Boundary } from './Boundary';
import { AgentSubtitle, agentDetails, agentTitle, Details, ExternalMark, SessionSubtitle, sessionDetails } from './Details';
import { FlowView } from './FlowView';
import { BackIcon, ChatIcon, ChevronIcon, CloseIcon, DelegateIcon, FlowIcon, Grip, TerminalIcon } from './icons';
import { AgentStatusIcon, StatusIcon } from './StatusIcon';
import { switchSide, switchTrack } from './switch';
import { TerminalView } from './TerminalView';

// Chips for this many sub-agents at most; the tree has them all.
const MAX_CHIPS = 6;
// The head of a stack is about this high: over it, what is dragged lands among the tabs.
const HEAD_PX = 54;
// This near a side of a stack, what is dragged lands on that side, as a stack of its own.
const EDGE = 0.22;
// A stack this narrow keeps the room of its head for the name: the grip and the details toggle give way.
const SLIM = '@container ah-stack (max-width: 380px)';

/** Delegation: who works for whom, what was handed over, and how to hand more over or bring answers back. */
export interface DelegationProps {
  links: SessionLink[];
  delegations: DelegationInfo[];
  onDelegate: (parentId: string, childId: string, text: string) => void;
  onDeliver: (task: DelegationInfo, header: string) => void;
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
function DelegateChips({ delegates, dispatch, dnd }: { delegates: SessionInfo[]; dispatch: (action: Action) => void; dnd: Dnd }) {
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
            onDrop={dnd.drop(target)}
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


/** A pane of a stack, with the session it shows (its own, or the one its sub-agent belongs to). */
export interface Tab {
  pane: Pane;
  session: SessionInfo;
}

const agentOf = ({ pane, session }: Tab) => (pane.agentId ? session.agents.find((agent) => agent.id === pane.agentId) : undefined);
const titleOf = (tab: Tab) => (tab.pane.agentId ? (agentOf(tab) ? agentTitle(agentOf(tab)!) : t.subagent) : tab.session.title);

/** What a pane is called, as a row of the tree calls it: its state, its name, and its model under that. */
function Name({ tab, on }: { tab: Tab; on: boolean }) {
  const agent = agentOf(tab);
  return (
    <>
      {agent ? <AgentStatusIcon agent={agent} /> : <StatusIcon status={tab.session.status} />}
      <Box component="span" sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start', textAlign: 'left' }}>
        <Typography noWrap sx={{ maxWidth: '100%', fontWeight: on ? 600 : 500 }}>
          {titleOf(tab)}
        </Typography>
        {tab.pane.agentId ? agent && <AgentSubtitle agent={agent} /> : <SessionSubtitle session={tab.session} />}
      </Box>
    </>
  );
}

/** Where a tab would be added: shown in the row of tabs, or after the name of a stack with one pane, while something is held over it. */
function TabSlot({ height }: { height: number }) {
  return (
    <Box
      aria-hidden
      sx={{
        flex: '0 3 170px',
        minWidth: 64,
        height,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '10px',
        outline: `2px dashed ${v.primary}`,
        outlineOffset: '-2px',
        bgcolor: v.dropBg,
        color: v.primary,
        fontWeight: 600,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      {t.addTab}
    </Box>
  );
}

/**
 * The panes of a stack as tabs, where the name of a stack with one pane is. The one on top is a
 * chip in the row and has the cross that closes it; any of them is dragged by itself to another place.
 */
function Tabs({ tabs, top, landing, dispatch, dnd }: { tabs: Tab[]; top: string; landing: boolean; dispatch: (action: Action) => void; dnd: Dnd }) {
  return (
    <Box role="tablist" aria-label={t.tabs} sx={{ flex: 1, minWidth: 0, display: 'flex', gap: '4px', overflowX: 'auto', scrollbarWidth: 'none' }}>
      {tabs.map((tab) => {
        const on = tab.pane.id === top;
        const dragged = dnd.dragging?.kind === 'pane' && dnd.dragging.id === tab.pane.id;
        return (
          <ButtonBase
            key={tab.pane.id}
            component="div"
            role="tab"
            aria-selected={on}
            aria-label={titleOf(tab)}
            // A tab among many has little room for its name.
            title={titleOf(tab)}
            draggable
            onDragStart={dnd.start({ kind: 'pane', id: tab.pane.id })}
            onClick={() => dispatch({ type: 'focus', paneId: tab.pane.id })}
            sx={{
              // The one that shows keeps its words longest: among many, or in a narrow stack, the others
              // give way down to their state alone.
              flex: on ? '0 1 240px' : '0 3 170px',
              minWidth: on ? 96 : 34,
              height: 40,
              justifyContent: 'flex-start',
              gap: 1,
              p: '0 6px 0 10px',
              cursor: 'grab',
              opacity: dragged ? 0.5 : 1,
              borderRadius: '10px',
              // A fill tells the one that shows, in either mode: on a card, a key the tone of the card would not.
              bgcolor: on ? v.surface2 : 'transparent',
              transition: `background-color ${motion.fast}`,
              '&:hover': { bgcolor: on ? v.surface3 : v.hover },
            }}
          >
            <Name tab={tab} on={on} />
            {on && (
              <IconButton
                aria-label={`${titleOf(tab)} ${t.closeTab}`}
                onClick={(event) => {
                  event.stopPropagation();
                  dispatch({ type: 'closePane', paneId: tab.pane.id });
                }}
                sx={{ flex: 'none', width: 28, height: 28, color: v.on2 }}
              >
                <CloseIcon size={14} />
              </IconButton>
            )}
          </ButtonBase>
        );
      })}
      {landing && <TabSlot height={40} />}
    </Box>
  );
}

const HALF = {
  left: { left: 0, top: 0, bottom: 0, width: '50%' },
  right: { right: 0, top: 0, bottom: 0, width: '50%' },
  top: { top: 0, left: 0, right: 0, height: '50%' },
  bottom: { bottom: 0, left: 0, right: 0, height: '50%' },
} satisfies Record<Side, object>;

/** Where what is dragged would land in a stack: the half of it that would be a stack of its own, or all of it. */
function Landing({ over, drag }: { over: Extract<DropTarget, { type: 'edge' | 'pane' }>; drag: Dnd['dragging'] }) {
  const where = over.type === 'edge' ? HALF[over.side] : { inset: 0 };
  const says = over.type === 'edge' ? t.openSide[over.side] : drag?.kind === 'pane' ? t.addTab : drag?.kind === 'item' ? t.delegate : t.openHere;
  return (
    <Box
      aria-hidden
      sx={{
        position: 'absolute',
        ...where,
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
      {says}
    </Box>
  );
}

interface Props extends DelegationProps {
  stack: Stack;
  /** Its panes in the order of the tabs, each with its session; never empty. */
  tabs: Tab[];
  state: WorkspaceState;
  dispatch: (action: Action) => void;
  dnd: Dnd;
  theme: ThemeMode;
  windowsBuild: number | null;
  sessionById: (id: string) => SessionInfo | undefined;
}

export function PaneStack({ stack, tabs, state, dispatch, dnd, theme, windowsBuild, sessionById, links, delegations, onDelegate, onDeliver }: Props) {
  // Only the pane on top is drawn. A terminal under another tab is taken down, and put up again from
  // the screen the session host keeps when its tab is picked: it is never left in a box without a size.
  const shown = tabs.find((tab) => tab.pane.id === stack.top) ?? tabs[0]!;
  const { pane, session } = shown;
  const single = tabs.length === 1;
  const active = pane.id === state.active;
  const open = Boolean(state.paneOpen[pane.id]);
  const dragged = single && dnd.dragging?.kind === 'pane' && dnd.dragging.id === pane.id;
  // A sub-agent's pane shows its conversation; it has no terminal of its own.
  const agentId = pane.agentId ?? null;
  const agent = agentOf(shown);
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
  const nameOf = useCallback((id: string) => sessionById(id)?.title ?? id, [sessionById]);
  const handed = useMemo<DelegationView>(
    () => ({
      tasks: agentId ? [] : delegations.filter((d) => d.parentId === session.id),
      titleOf: nameOf,
      onDeliver: (task) => onDeliver(task, t.delegationResult(nameOf(task.childId))),
    }),
    [agentId, delegations, session.id, nameOf, onDeliver],
  );
  const title = titleOf(shown);

  /**
   * Where something dragged over the stack would land: among the tabs over its head, on a side
   * near that side (a stack of its own there, while the two halves would be large enough to be
   * stacks), else in the pane on top. A place that does not take what is dragged gives way to the
   * middle, which a piece of a conversation is always for.
   */
  const landing = (event: DragEvent<HTMLElement>): DropTarget => {
    const box = event.currentTarget.getBoundingClientRect();
    const across = (event.clientX - box.left) / box.width;
    const down = (event.clientY - box.top - HEAD_PX) / (box.height - HEAD_PX);
    const middle: DropTarget = { type: 'pane', id: pane.id };
    const side = (to: Side): DropTarget => (halves(to, box.width, box.height) ? { type: 'edge', id: stack.id, side: to } : middle);
    const wanted: DropTarget =
      down < 0 ? { type: 'tabs', id: stack.id } : across < EDGE ? side('left') : across > 1 - EDGE ? side('right') : down < EDGE ? side('top') : down > 1 - EDGE ? side('bottom') : middle;
    return dnd.canDrop(wanted) ? wanted : middle;
  };
  const over = state.over;
  const here = over && ((over.type === 'pane' && over.id === pane.id) || ((over.type === 'tabs' || over.type === 'edge') && over.id === stack.id));
  const mine = here ? (over as Extract<DropTarget, { type: 'pane' | 'tabs' | 'edge' }>) : null;

  return (
    <Box
      component="section"
      aria-label={title}
      onDragOver={(event) => dnd.over(landing(event))(event)}
      // A session or a sub-agent shows here, or beside it; a pane joins the tabs or goes to a side; and a
      // piece of a parent's conversation dropped on its delegate's pane is work for it.
      onDrop={(event) => dnd.drop(landing(event))(event)}
      sx={{
        position: 'relative',
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 0,
        minHeight: 0,
        // What is in it follows its own width, which the user shares out, not the window's.
        containerType: 'inline-size',
        containerName: 'ah-stack',
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
        // A stack of one pane is dragged by its head; with tabs, each tab is dragged by itself.
        draggable={single}
        onDragStart={single ? dnd.start({ kind: 'pane', id: pane.id }) : undefined}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: single ? '10px' : '6px',
          p: single ? '10px 8px 8px 10px' : '7px 8px 7px 8px',
          cursor: single ? 'grab' : 'default',
          [SLIM]: { gap: '6px', '& .ah-grip': { display: 'none' } },
        }}
      >
        {single && <Grip className="ah-grip" />}
        {canGoBack && (
          <Tooltip title={t.back}>
            <IconButton aria-label={t.back} onClick={() => dispatch({ type: 'back', paneId: pane.id })} sx={{ flex: 'none', width: 32, height: 32, ml: single ? '-6px' : 0, color: v.on2 }}>
              <BackIcon size={16} />
            </IconButton>
          </Tooltip>
        )}
        {single ? (
          <>
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
            {/* No higher than the buttons of the head, which keeps its height. */}
            {mine?.type === 'tabs' && <TabSlot height={36} />}
          </>
        ) : (
          <Tabs tabs={tabs} top={pane.id} landing={mine?.type === 'tabs'} dispatch={dispatch} dnd={dnd} />
        )}
        {!agentId && session.state === 'exited' && (
          <Box component="span" sx={{ flex: 'none', height: 26, px: 1.25, display: 'inline-flex', alignItems: 'center', borderRadius: '8px', bgcolor: v.surface2, fontSize: 12 }}>
            {t.exited}
          </Box>
        )}
        {!agentId && session.external && <ExternalMark big />}
        {modes.length > 1 && <ModeSwitch mode={mode} modes={modes} onChange={(next) => dispatch({ type: 'setMode', paneId: pane.id, mode: next })} />}
        <IconButton
          aria-label={`${title} ${t.details}`}
          aria-expanded={open}
          onClick={() => dispatch({ type: 'togglePane', id: pane.id })}
          // In a narrow stack it stays only while the details are open, to close them: the tree has them too.
          sx={{ flex: 'none', width: 36, height: 36, color: v.on2, ...(open ? {} : { [SLIM]: { display: 'none' } }) }}
        >
          <ChevronIcon open={open} size={16} />
        </IconButton>
        {single && (
          <IconButton aria-label={`${title} ${t.closePane}`} onClick={() => dispatch({ type: 'closePane', paneId: pane.id })} sx={{ width: 36, height: 36, color: v.on2 }}>
            <CloseIcon size={16} />
          </IconButton>
        )}
      </Box>
      {open && (
        <Box sx={{ px: '8px' }}>
          <Details items={agent ? agentDetails(agent, session.agents, session) : sessionDetails(session)} />
        </Box>
      )}
      <DelegateChips delegates={delegates} dispatch={dispatch} dnd={dnd} />
      <AgentChips session={session} parentId={agentId} dispatch={dispatch} dnd={dnd} />
      <Box
        role={single ? undefined : 'tabpanel'}
        onPointerDown={mode !== 'terminal' ? focus : undefined}
        sx={{ flex: 1, minHeight: 0, m: '0 12px 12px', p: mode !== 'terminal' ? '4px 4px 4px 14px' : '8px 4px 4px 10px', borderRadius: '10px', bgcolor: v.termBg, boxShadow: v.well, overflow: 'hidden' }}
      >
        <Boundary resetKey={`${pane.id}/${pane.sessionId}/${agentId}/${mode}`} fallback={<Typography sx={{ p: 1, color: v.termDim }}>{t.cannotShow}</Typography>}>
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
      {mine && mine.type !== 'tabs' && <Landing over={mine} drag={dnd.dragging} />}
    </Box>
  );
}
