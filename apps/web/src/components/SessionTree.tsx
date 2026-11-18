import { Box, Button, ButtonBase, Collapse, IconButton, Menu, MenuItem, Tooltip, Typography } from '@mui/material';
import { useState } from 'react';
import { isAgentBusy, isTaskRunning, type AgentInfo, type LinkKind, type SessionInfo, type SessionLink } from '@agenthouse/protocol';
import { t } from '../strings';
import { motion, v } from '../theme/tokens';
import { agentRows, SHOWN_FINISHED } from '../workspace/agents';
import { scheduleText, scheduleTitle, SHOWN_ENDED, taskNote, taskRows, taskTitle, taskType } from '../workspace/background';
import type { Dnd } from '../workspace/dnd';
import { canResume } from '../workspace/sessions';
import type { Action, WorkspaceState } from '../workspace/state';
import { sessionTree, type SessionNode } from '../workspace/tree';
import { AgentSubtitle, agentDetails, agentTitle, Details, ExternalMark, scheduleDetails, SessionSubtitle, sessionDetails, taskDetails, type Detail } from './Details';
import { ChevronIcon, ClockIcon, DelegateIcon, Grip, LinkIcon, PlusIcon } from './icons';
import { keySx } from './key';
import { LibraryButtons } from './Library';
import { AgentStatusIcon, StatusIcon, TaskStatusIcon } from './StatusIcon';

// Each level of nesting moves a row this far in.
const INDENT = 18;

const smallButton = { minHeight: 28, px: 1.5, fontSize: 12 } as const;

/**
 * What can be done about a session, in its opened details: keys that stand out of the tray they lie
 * in, with a face and a shadow of their own, and a step up under the pointer.
 */
const actionButton = { ...smallButton, fontWeight: 500, ...keySx } as const;

/**
 * A row. The row of what a pane shows is a card on the page; the others lie flat on it. Under the
 * pointer every row takes the same veil, laid between its face and what is on it, so it reads the
 * same on a card as on the page.
 */
const rowSx = (card: boolean) =>
  ({
    position: 'relative',
    isolation: 'isolate',
    display: 'flex',
    alignItems: 'center',
    gap: 1,
    // Apart from the row above: two cards never touch, and a card's shadow has somewhere to fall.
    mt: '4px',
    borderRadius: '10px',
    bgcolor: card ? v.surface : 'transparent',
    boxShadow: card ? v.shadow1 : 'none',
    transition: `background-color ${motion.fast}, box-shadow ${motion.base}`,
    cursor: 'grab',
    '&::before': { content: '""', position: 'absolute', inset: 0, zIndex: -1, borderRadius: 'inherit', bgcolor: v.hover, opacity: 0, transition: `opacity ${motion.fast}` },
    '&:hover::before': { opacity: 1 },
  }) as const;

// A quiet line of the tree that folds rows away or brings them back.
const foldSx = { borderRadius: '6px', fontSize: 12, color: v.on2, transition: `background-color ${motion.fast}`, '&:hover': { bgcolor: v.hover } } as const;

/** The corner line in front of a nested row. */
function Connector() {
  return (
    <Box
      component="span"
      aria-hidden
      sx={{ flex: 'none', width: 8, height: 16, mt: '-10px', borderLeft: `1.5px solid ${v.outline}`, borderBottom: `1.5px solid ${v.outline}`, borderBottomLeftRadius: '5px' }}
    />
  );
}

interface AgentRowProps {
  session: SessionInfo;
  agent: AgentInfo;
  depth: number;
  /** A pane shows it. */
  shown: boolean;
  /** The pane that takes the typing does. */
  current: boolean;
  state: WorkspaceState;
  dispatch: (action: Action) => void;
  dnd: Dnd;
}

/** A sub-agent under its session (or under the agent that started it): opens its session's flow, with it pointed out. */
function AgentRow({ session, agent, depth, shown, current, state, dispatch, dnd }: AgentRowProps) {
  const key = `${session.id}/${agent.id}`;
  const open = Boolean(state.rowOpen[key]);
  const dragged = dnd.dragging?.kind === 'agent' && dnd.dragging.id === agent.id;
  const title = agentTitle(agent);
  return (
    <Box>
      <Box
        className="ah-row"
        draggable
        onDragStart={dnd.start({ kind: 'agent', id: agent.id, sessionId: session.id })}
        sx={{ ...rowSx(shown), minHeight: 40, p: `2px 4px 2px ${4 + depth * INDENT}px`, opacity: dragged ? 0.45 : 1 }}
      >
        <Grip className="ah-grip" />
        <Connector />
        <AgentStatusIcon agent={agent} />
        <ButtonBase
          onClick={() => dispatch({ type: 'open', sessionId: session.id, mode: 'flow', focusAgent: agent.id })}
          aria-label={t.open(title)}
          sx={{ flex: 1, minWidth: 0, flexDirection: 'column', alignItems: 'flex-start', textAlign: 'left', py: '2px', borderRadius: '6px' }}
        >
          <Typography noWrap sx={{ maxWidth: '100%', fontWeight: current ? 600 : 500, color: isAgentBusy(agent) ? v.on : v.on2 }}>
            {title}
          </Typography>
          <AgentSubtitle agent={agent} />
        </ButtonBase>
        <IconButton aria-label={`${title} ${t.details}`} aria-expanded={open} onClick={() => dispatch({ type: 'toggleRow', id: key })} sx={{ width: 36, height: 36, color: v.on2 }}>
          <ChevronIcon open={open} size={16} />
        </IconButton>
      </Box>
      <Collapse in={open} unmountOnExit>
        <Details page items={() => agentDetails(agent, session.agents, session)} inset={22 + depth * INDENT} />
      </Collapse>
    </Box>
  );
}

/** A session's sub-agents as nested rows below it; finished ones fold away when there are many. */
function AgentRows({ session, base, state, dispatch, dnd }: Omit<AgentRowProps, 'agent' | 'depth' | 'shown' | 'current'> & { base: number }) {
  const allKey = `${session.id}#agents`;
  const all = Boolean(state.rowOpen[allKey]);
  const { rows, folded } = agentRows(session.agents, all);
  const finished = session.agents.filter((a) => !isAgentBusy(a)).length;
  const panes = state.panes.filter((p) => p.sessionId === session.id && p.agentId);
  const shown = new Set(panes.map((p) => p.agentId));
  const current = panes.find((p) => p.id === state.active)?.agentId;
  return (
    <Box role="group" aria-label={`${session.title} ${t.subagent}`}>
      {rows.map(({ agent, depth }) => (
        <AgentRow key={agent.id} session={session} agent={agent} depth={base + depth} shown={shown.has(agent.id)} current={agent.id === current} state={state} dispatch={dispatch} dnd={dnd} />
      ))}
      {(folded > 0 || (all && finished > SHOWN_FINISHED)) && (
        <ButtonBase
          onClick={() => dispatch({ type: 'toggleRow', id: allKey })}
          aria-expanded={all}
          sx={{ ...foldSx, minHeight: 28, mt: '2px', ml: `${30 + (base + 1) * INDENT}px`, px: '6px' }}
        >
          {folded > 0 ? t.finishedAgents(folded) : t.foldAgents}
        </ButtonBase>
      )}
    </Box>
  );
}

interface WorkRowProps {
  /** Its key among the opened rows. */
  id: string;
  depth: number;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  /** Over: its title steps back, like an ended session's. */
  quiet: boolean;
  details: () => Detail[];
  state: WorkspaceState;
  dispatch: (action: Action) => void;
}

/**
 * Something a session left running or set for later, under it like a sub-agent. There is nothing of
 * its own to show in a pane, so the row neither drags nor opens one: it opens its details.
 */
function WorkRow({ id, depth, icon, title, subtitle, quiet, details, state, dispatch }: WorkRowProps) {
  const open = Boolean(state.rowOpen[id]);
  return (
    <Box>
      <Box className="ah-row" sx={{ ...rowSx(false), cursor: 'default', minHeight: 40, p: `2px 4px 2px ${4 + depth * INDENT}px` }}>
        {/* Where a row that drags has its grip. */}
        <Box component="span" aria-hidden sx={{ flex: 'none', width: 8 }} />
        <Connector />
        {icon}
        <ButtonBase
          onClick={() => dispatch({ type: 'toggleRow', id })}
          aria-label={`${title} ${t.details}`}
          aria-expanded={open}
          sx={{ flex: 1, minWidth: 0, justifyContent: 'flex-start', gap: 1, textAlign: 'left', py: '2px', borderRadius: '6px' }}
        >
          <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            <Typography noWrap sx={{ maxWidth: '100%', fontWeight: 500, color: quiet ? v.on2 : v.on }}>
              {title}
            </Typography>
            <Typography noWrap sx={{ maxWidth: '100%', fontSize: 12, lineHeight: '16px', color: v.on2 }}>
              {subtitle}
            </Typography>
          </Box>
          <Box component="span" sx={{ flex: 'none', width: 36, height: 36, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: v.on2 }}>
            <ChevronIcon open={open} size={16} />
          </Box>
        </ButtonBase>
      </Box>
      <Collapse in={open} unmountOnExit>
        <Details page items={details} inset={22 + depth * INDENT} />
      </Collapse>
    </Box>
  );
}

/** A session's background tasks (ended ones fold away when there are many) and the prompts scheduled for it. */
function WorkRows({ session, depth, state, dispatch }: { session: SessionInfo; depth: number; state: WorkspaceState; dispatch: (action: Action) => void }) {
  const allKey = `${session.id}#tasks`;
  const all = Boolean(state.rowOpen[allKey]);
  const { rows, folded } = taskRows(session.tasks, all);
  const ended = session.tasks.filter((task) => !isTaskRunning(task)).length;
  const now = Date.now();
  const common = { depth, state, dispatch };
  return (
    <Box role="group" aria-label={`${session.title} ${t.backgroundWork}`}>
      {rows.map((task) => (
        <WorkRow
          key={task.id}
          id={`${session.id}/task/${task.id}`}
          icon={<TaskStatusIcon task={task} />}
          title={taskTitle(task)}
          subtitle={[taskType(task), taskNote(task)].filter(Boolean).join(' · ')}
          quiet={!isTaskRunning(task)}
          details={() => taskDetails(task)}
          {...common}
        />
      ))}
      {(folded > 0 || (all && ended > SHOWN_ENDED)) && (
        <ButtonBase onClick={() => dispatch({ type: 'toggleRow', id: allKey })} aria-expanded={all} sx={{ ...foldSx, minHeight: 28, mt: '2px', ml: `${30 + depth * INDENT}px`, px: '6px' }}>
          {folded > 0 ? t.finishedAgents(folded) : t.foldAgents}
        </ButtonBase>
      )}
      {session.schedules.map((job) => (
        <WorkRow
          key={job.id}
          id={`${session.id}/schedule/${job.id}`}
          icon={<ClockIcon role="img" aria-label={t.scheduled} size={14} style={{ flex: 'none', color: v.on2 }} />}
          title={scheduleTitle(job)}
          subtitle={[scheduleText(job, now), job.runs ? t.runCount(job.runs) : null].filter(Boolean).join(' · ')}
          quiet={false}
          details={() => scheduleDetails(job)}
          {...common}
        />
      ))}
    </Box>
  );
}

/**
 * "아래로 넣기" without dragging: the session at the top to go under, then how, as after a drop: grouped
 * with it, or delegated to. One menu after the other, each with the keyboard on its first line.
 */
function NestMenu({ session, candidates, onLink }: { session: SessionInfo; candidates: SessionInfo[]; onLink: Props['onLink'] }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [parent, setParent] = useState<SessionInfo | null>(null);
  const close = () => {
    setAnchor(null);
    setParent(null);
  };
  const place = (kind: LinkKind) => {
    if (parent) onLink(session.id, parent.id, kind);
    close();
  };
  return (
    <>
      <Button size="small" color="inherit" aria-haspopup="menu" onClick={(event) => setAnchor(event.currentTarget)} sx={actionButton}>
        {t.nest}
      </Button>
      <Menu anchorEl={anchor} open={Boolean(anchor) && !parent} onClose={close} slotProps={{ list: { 'aria-label': t.nestUnder } }}>
        {candidates.map((candidate) => (
          <MenuItem key={candidate.id} onClick={() => setParent(candidate)} sx={{ fontSize: 13 }}>
            {candidate.title}
          </MenuItem>
        ))}
      </Menu>
      <Menu anchorEl={anchor} open={Boolean(anchor) && Boolean(parent)} onClose={close} slotProps={{ list: { 'aria-label': `${session.title} → ${parent?.title ?? ''}` } }}>
        <MenuItem onClick={() => place('group')} sx={{ gap: 1, fontSize: 13 }}>
          <LinkIcon size={14} style={{ flex: 'none', color: v.on2 }} />
          {t.groupAction}
        </MenuItem>
        <MenuItem onClick={() => place('delegate')} sx={{ gap: 1, fontSize: 13 }}>
          <DelegateIcon size={14} style={{ flex: 'none', color: v.primary }} />
          {t.delegateAction}
        </MenuItem>
      </Menu>
    </>
  );
}

interface BranchProps {
  node: SessionNode;
  depth: number;
  /** Sessions at the top: where a session can be placed. */
  tops: SessionInfo[];
  shown: Set<string>;
  byId: Map<string, SessionInfo>;
  state: WorkspaceState;
  dispatch: (action: Action) => void;
  dnd: Dnd;
  onEnd: (id: string) => void;
  onResume: (id: string) => void;
  onRemove: (id: string) => void;
  onLink: Props['onLink'];
}

/** A session row, what is under it (its sub-agents, the sessions placed under it), and the choice when one is dropped on it. */
function SessionBranch(props: BranchProps) {
  const { node, depth, tops, shown, byId, state, dispatch, dnd, onEnd, onResume, onRemove, onLink } = props;
  const { session, link } = node;
  const open = Boolean(state.rowOpen[session.id]);
  const dragged = dnd.dragging?.kind === 'session' && dnd.dragging.id === session.id;
  const nest = { type: 'nest' as const, id: session.id };
  const over = dnd.isOver(nest);
  const parent = link ? byId.get(link.parentId) : undefined;
  const pending = state.pending?.parentId === session.id ? state.pending : null;
  const placing = pending ? byId.get(pending.childId) : undefined;
  const candidates = tops.filter((s) => s.id !== session.id);
  const delegated = link?.kind === 'delegate';
  // The pane that takes the typing shows this session.
  const current = state.panes.some((p) => p.id === state.active && p.sessionId === session.id && !p.agentId);
  // Asked for only while the row is open: the list is redrawn with every status any session reports.
  const details = () => {
    const list = sessionDetails(session);
    if (parent) list.splice(1, 0, { k: delegated ? t.delegate : t.group, v: parent.title });
    return list;
  };
  return (
    <Box>
      <Box
        className="ah-row"
        draggable
        onDragStart={dnd.start({ kind: 'session', id: session.id })}
        onDragOver={dnd.over(nest)}
        onDrop={dnd.drop(nest)}
        sx={{
          ...rowSx(shown.has(session.id)),
          minHeight: 44,
          p: `2px 4px 2px ${4 + depth * INDENT}px`,
          ...(over && { bgcolor: v.dropBg, boxShadow: `inset 0 0 0 2px ${v.primary}` }),
          opacity: dragged ? 0.45 : 1,
        }}
      >
        <Grip className="ah-grip" />
        {depth > 0 && <Connector />}
        <StatusIcon status={session.status} />
        <ButtonBase
          onClick={() => dispatch({ type: 'open', sessionId: session.id })}
          aria-label={t.open(session.title)}
          sx={{ flex: 1, minWidth: 0, flexDirection: 'column', alignItems: 'flex-start', textAlign: 'left', py: '3px', borderRadius: '6px' }}
        >
          <Typography noWrap sx={{ maxWidth: '100%', fontWeight: current ? 600 : 500, color: session.state === 'exited' ? v.on2 : v.on }}>
            {session.title}
          </Typography>
          <SessionSubtitle session={session} />
        </ButtonBase>
        {session.external && <ExternalMark />}
        {link &&
          (delegated ? (
            <DelegateIcon role="img" aria-label={t.delegate} size={14} style={{ flex: 'none', color: v.primary }} />
          ) : (
            <LinkIcon role="img" aria-label={t.group} size={14} style={{ flex: 'none', color: v.on2 }} />
          ))}
        <IconButton aria-label={`${session.title} ${t.details}`} aria-expanded={open} onClick={() => dispatch({ type: 'toggleRow', id: session.id })} sx={{ width: 36, height: 36, color: v.on2 }}>
          <ChevronIcon open={open} size={16} />
        </IconButton>
      </Box>
      <Collapse in={open} unmountOnExit>
        <Details page items={details} inset={22 + depth * INDENT}>
          {/* A session only watched is read and nothing more: its details have no keys. */}
          {session.external ? undefined : (
            <>
              {canResume(session) && (
                <Button size="small" color="inherit" onClick={() => onResume(session.id)} sx={actionButton}>
                  {t.resumeSession}
                </Button>
              )}
              {link ? (
                <Button size="small" color="inherit" onClick={() => onLink(session.id, null)} sx={actionButton}>
                  {t.toTop}
                </Button>
              ) : (
                !node.children.length &&
                candidates.length > 0 && (
                  <NestMenu session={session} candidates={candidates} onLink={onLink} />
                )
              )}
              {/* What ends or removes the session stands apart, at the other end of the line: of a line of its own when the others fill one. */}
              {session.state === 'running' ? (
                <Button size="small" color="inherit" onClick={() => onEnd(session.id)} sx={{ ...actionButton, ml: 'auto', color: v.error }}>
                  {t.endSession}
                </Button>
              ) : (
                <Button size="small" color="inherit" onClick={() => onRemove(session.id)} sx={{ ...actionButton, ml: 'auto' }}>
                  {t.removeSession}
                </Button>
              )}
            </>
          )}
        </Details>
      </Collapse>
      {pending && placing && (
        <Box role="group" aria-label={`${placing.title} → ${session.title}`} sx={{ display: 'flex', alignItems: 'center', gap: '6px', m: `4px 4px 2px ${22 + depth * INDENT}px` }}>
          <Button
            size="small"
            onClick={() => {
              onLink(pending.childId, session.id, 'group');
              dispatch({ type: 'settleLink' });
            }}
            // Filled, on the page: a step up under the pointer, like the filled button next to it.
            sx={{ ...smallButton, minHeight: 32, px: 1.75, bgcolor: v.bg2, color: v.on, fontWeight: 500, transition: `box-shadow ${motion.fast}`, '&:hover': { bgcolor: v.bg2, boxShadow: v.shadow1 } }}
          >
            {t.groupAction}
          </Button>
          <Button
            size="small"
            variant="contained"
            onClick={() => {
              onLink(pending.childId, session.id, 'delegate');
              dispatch({ type: 'settleLink' });
            }}
            sx={{ ...smallButton, minHeight: 32, px: 1.75, bgcolor: v.primary, color: v.onPrimary, fontWeight: 500 }}
          >
            {t.delegateAction}
          </Button>
          <Button size="small" color="inherit" onClick={() => dispatch({ type: 'settleLink' })} sx={{ ...smallButton, minHeight: 32, color: v.on2 }}>
            {t.cancel}
          </Button>
        </Box>
      )}
      {session.agents.length > 0 && <AgentRows session={session} base={depth} state={state} dispatch={dispatch} dnd={dnd} />}
      {(session.tasks.length > 0 || session.schedules.length > 0) && <WorkRows session={session} depth={depth + 1} state={state} dispatch={dispatch} />}
      {node.children.map((child) => (
        <SessionBranch key={child.session.id} {...props} node={child} depth={depth + 1} />
      ))}
    </Box>
  );
}

interface Props {
  sessions: SessionInfo[];
  links: SessionLink[];
  state: WorkspaceState;
  dispatch: (action: Action) => void;
  dnd: Dnd;
  onNew: () => void;
  onEnd: (id: string) => void;
  /** Starts an ended session again where its conversation stopped. */
  onResume: (id: string) => void;
  onRemove: (id: string) => void;
  /** Takes these ended sessions off the list at once (after asking). */
  onRemoveEnded: (sessions: SessionInfo[]) => void;
  /** Places a session under another one (grouped, or delegated to), or back at the top (null). */
  onLink: (childId: string, parentId: string | null, kind?: LinkKind) => void;
}

// The row that folds the ended sessions away, in `rowOpen`.
const ENDED_KEY = '#ended';

export function SessionTree({ sessions, links, state, dispatch, dnd, onNew, onEnd, onResume, onRemove, onRemoveEnded, onLink }: Props) {
  const groups = sessionTree(sessions, links);
  const shown = new Set(state.panes.filter((p) => !p.agentId).map((p) => p.sessionId));
  const byId = new Map(sessions.map((s) => [s.id, s]));
  // What a session can be placed under: one at the top that AgentHouse runs itself.
  const tops = groups.flatMap((g) => g.nodes.map((n) => n.session)).filter((s) => !s.external);
  const root = { type: 'root' as const };
  const toTop = dnd.canDrop(root);
  const branch = { tops, shown, byId, state, dispatch, dnd, onEnd, onResume, onRemove, onLink };
  // Ended sessions stay listed until removed and would bury the running ones: those at the top with
  // nothing under them and no pane showing them fold into one row, like finished sub-agents.
  const folds = (node: SessionNode) => node.session.state === 'exited' && !node.children.length && !shown.has(node.session.id);
  const ended = groups.flatMap((g) => g.nodes.filter(folds));
  const endedOpen = Boolean(state.rowOpen[ENDED_KEY]);
  const listed = endedOpen ? groups : groups.map((g) => ({ ...g, nodes: g.nodes.filter((n) => !folds(n)) })).filter((g) => g.nodes.length);

  return (
    <Box
      component="aside"
      aria-label={t.sessions}
      sx={{
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        // The padding is room for the shadows of the rows that are cards, which what scrolls would cut
        // off. The margin takes the room back and the basis grows by as much (272 + 2 × 6), so the tree
        // is where it was and as wide, and so are the panes next to it.
        flex: { xs: '1 1 272px', md: '1 1 284px' },
        p: { md: '0 6px 6px' },
        m: { md: '0 -6px -6px' },
      }}
    >
      {/* The rows scroll; what is at the foot of the tree stays where it is. The scrolling part reaches into the room for the shadows. */}
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '2px', overflowY: { md: 'auto' }, scrollbarWidth: 'thin', mx: { md: '-6px' }, px: { md: '6px' }, pb: { md: '6px' } }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: '2px 4px 6px 6px' }}>
          <Typography component="h2" sx={{ fontSize: 14, fontWeight: 600 }}>
            {t.sessions}
          </Typography>
          <Typography sx={{ color: v.on2 }}>{sessions.length}</Typography>
          <Box sx={{ flex: 1 }} />
          <Tooltip title={t.newSession}>
            <IconButton aria-label={t.newSession} onClick={onNew} size="small" sx={{ width: 36, height: 36 }}>
              <PlusIcon />
            </IconButton>
          </Tooltip>
        </Box>

        {listed.map((group) => (
          <Box key={group.cwd} role="group" aria-label={group.label}>
            {/* The rows keep their own distance from the folder's name; a folder stands further from the one before. */}
            <Tooltip title={group.cwd} placement="right">
              <Typography sx={{ p: '14px 6px 2px', fontSize: 12, lineHeight: '16px', fontWeight: 500, color: v.on2 }}>{group.label}</Typography>
            </Tooltip>
            {group.nodes.map((node) => (
              <SessionBranch key={node.session.id} node={node} depth={0} {...branch} />
            ))}
          </Box>
        ))}

        {ended.length > 0 && (
          <Box sx={{ flex: 'none', display: 'flex', alignItems: 'center', gap: 1, mt: '6px', pl: '2px' }}>
            <ButtonBase
              onClick={() => dispatch({ type: 'toggleRow', id: ENDED_KEY })}
              aria-expanded={endedOpen}
              sx={{ ...foldSx, minHeight: 32, gap: '6px', px: '6px' }}
            >
              <ChevronIcon open={endedOpen} size={14} />
              {t.endedSessions(ended.length)}
            </ButtonBase>
            <Box sx={{ flex: 1 }} />
            <Button size="small" color="inherit" onClick={() => onRemoveEnded(ended.map((node) => node.session))} sx={{ ...smallButton, color: v.on2 }}>
              {t.removeAll}
            </Button>
          </Box>
        )}

        {toTop && (
          // While a placed session is dragged: drop it here to bring it back to the top.
          <Box
            onDragOver={dnd.over(root)}
            onDrop={dnd.drop(root)}
            sx={{
              mt: '6px',
              minHeight: 44,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: '10px',
              border: '1.5px dashed',
              borderColor: dnd.isOver(root) ? v.primary : v.outline,
              bgcolor: dnd.isOver(root) ? v.dropBg : 'transparent',
              color: v.on2,
            }}
          >
            {t.toTop}
          </Box>
        )}
      </Box>
      <LibraryButtons sessions={sessions} activeCwd={sessions.find((session) => session.id === state.panes.find((pane) => pane.id === state.active)?.sessionId)?.cwd} />
    </Box>
  );
}
