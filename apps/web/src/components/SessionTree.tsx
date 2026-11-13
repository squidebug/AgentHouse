import { Box, Button, ButtonBase, IconButton, Menu, MenuItem, Tooltip, Typography } from '@mui/material';
import { useState } from 'react';
import { isAgentBusy, type AgentInfo, type LinkKind, type SessionInfo, type SessionLink } from '@agenthouse/protocol';
import { t } from '../strings';
import { v } from '../theme/tokens';
import { agentRows, SHOWN_FINISHED } from '../workspace/agents';
import type { Dnd } from '../workspace/dnd';
import type { Action, WorkspaceState } from '../workspace/state';
import { sessionTree, type SessionNode } from '../workspace/tree';
import { AgentSubtitle, agentDetails, agentTitle, Details, SessionSubtitle, sessionDetails } from './Details';
import { ChevronIcon, DelegateIcon, Grip, LinkIcon, PlusIcon } from './icons';
import { AgentStatusIcon, StatusIcon } from './StatusIcon';

// Each level of nesting moves a row this far in.
const INDENT = 18;

const smallButton = { minHeight: 28, px: 1.5, fontSize: 12 } as const;

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
  shown: boolean;
  state: WorkspaceState;
  dispatch: (action: Action) => void;
  dnd: Dnd;
}

/** A sub-agent under its session (or under the agent that started it): opens its session's flow, with it pointed out. */
function AgentRow({ session, agent, depth, shown, state, dispatch, dnd }: AgentRowProps) {
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
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          minHeight: 40,
          p: `2px 4px 2px ${4 + depth * INDENT}px`,
          borderRadius: '10px',
          bgcolor: shown ? v.surface : 'transparent',
          opacity: dragged ? 0.45 : 1,
          cursor: 'grab',
        }}
      >
        <Grip className="ah-grip" />
        <Connector />
        <AgentStatusIcon agent={agent} />
        <ButtonBase
          onClick={() => dispatch({ type: 'open', sessionId: session.id, mode: 'flow', focusAgent: agent.id })}
          aria-label={t.open(title)}
          sx={{ flex: 1, minWidth: 0, flexDirection: 'column', alignItems: 'flex-start', textAlign: 'left', py: '2px', borderRadius: '6px' }}
        >
          <Typography noWrap sx={{ maxWidth: '100%', fontWeight: 500, color: isAgentBusy(agent) ? v.on : v.on2 }}>
            {title}
          </Typography>
          <AgentSubtitle agent={agent} />
        </ButtonBase>
        <IconButton aria-label={`${title} ${t.details}`} aria-expanded={open} onClick={() => dispatch({ type: 'toggleRow', id: key })} sx={{ width: 36, height: 36, color: v.on2 }}>
          <ChevronIcon open={open} size={16} />
        </IconButton>
      </Box>
      {open && <Details items={agentDetails(agent, session.agents, session)} inset={22 + depth * INDENT} />}
    </Box>
  );
}

/** A session's sub-agents as nested rows below it; finished ones fold away when there are many. */
function AgentRows({ session, base, state, dispatch, dnd }: Omit<AgentRowProps, 'agent' | 'depth' | 'shown'> & { base: number }) {
  const allKey = `${session.id}#agents`;
  const all = Boolean(state.rowOpen[allKey]);
  const { rows, folded } = agentRows(session.agents, all);
  const finished = session.agents.filter((a) => !isAgentBusy(a)).length;
  const shown = new Set(state.panes.filter((p) => p.sessionId === session.id && p.agentId).map((p) => p.agentId));
  return (
    <Box role="group" aria-label={`${session.title} ${t.subagent}`}>
      {rows.map(({ agent, depth }) => (
        <AgentRow key={agent.id} session={session} agent={agent} depth={base + depth} shown={shown.has(agent.id)} state={state} dispatch={dispatch} dnd={dnd} />
      ))}
      {(folded > 0 || (all && finished > SHOWN_FINISHED)) && (
        <ButtonBase
          onClick={() => dispatch({ type: 'toggleRow', id: allKey })}
          aria-expanded={all}
          sx={{ minHeight: 28, ml: `${30 + (base + 1) * INDENT}px`, px: '6px', borderRadius: '6px', fontSize: 12, color: v.on2, '&:hover': { bgcolor: v.surface2 } }}
        >
          {folded > 0 ? t.finishedAgents(folded) : t.foldAgents}
        </ButtonBase>
      )}
    </Box>
  );
}

/** "묶기" or "위임" without dragging: the sessions at the top this one can go under. */
function LinkMenu({ session, candidates, kind, onLink }: { session: SessionInfo; candidates: SessionInfo[]; kind: LinkKind; onLink: Props['onLink'] }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <Button size="small" color="inherit" aria-haspopup="menu" onClick={(event) => setAnchor(event.currentTarget)} sx={smallButton}>
        {kind === 'delegate' ? t.delegateAction : t.groupAction}
      </Button>
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}>
        {candidates.map((parent) => (
          <MenuItem
            key={parent.id}
            onClick={() => {
              setAnchor(null);
              onLink(session.id, parent.id, kind);
            }}
            sx={{ fontSize: 13 }}
          >
            {parent.title}
          </MenuItem>
        ))}
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
  onRemove: (id: string) => void;
  onLink: Props['onLink'];
}

/** A session row, what is under it (its sub-agents, the sessions placed under it), and the choice when one is dropped on it. */
function SessionBranch(props: BranchProps) {
  const { node, depth, tops, shown, byId, state, dispatch, dnd, onEnd, onRemove, onLink } = props;
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
  // Made only for an open row: the list is redrawn with every status any session reports.
  const details = open ? sessionDetails(session) : [];
  if (open && parent) details.splice(1, 0, { k: delegated ? t.delegate : t.group, v: parent.title });
  return (
    <Box>
      <Box
        className="ah-row"
        draggable
        onDragStart={dnd.start({ kind: 'session', id: session.id })}
        onDragOver={dnd.over(nest)}
        onDrop={dnd.drop(nest)}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          minHeight: 44,
          p: `2px 4px 2px ${4 + depth * INDENT}px`,
          borderRadius: '10px',
          bgcolor: over ? v.dropBg : shown.has(session.id) ? v.surface : 'transparent',
          boxShadow: over ? `inset 0 0 0 2px ${v.primary}` : 'none',
          opacity: dragged ? 0.45 : 1,
          cursor: 'grab',
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
          <Typography noWrap sx={{ maxWidth: '100%', fontWeight: 500, color: session.state === 'exited' ? v.on2 : v.on }}>
            {session.title}
          </Typography>
          <SessionSubtitle session={session} />
        </ButtonBase>
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
      {open && (
        <Details items={details} inset={22 + depth * INDENT}>
          {link ? (
            <Button size="small" color="inherit" onClick={() => onLink(session.id, null)} sx={smallButton}>
              {t.toTop}
            </Button>
          ) : (
            !node.children.length &&
            candidates.length > 0 && (
              <>
                <LinkMenu session={session} candidates={candidates} kind="delegate" onLink={onLink} />
                <LinkMenu session={session} candidates={candidates} kind="group" onLink={onLink} />
              </>
            )
          )}
          {session.state === 'running' ? (
            <Button size="small" color="inherit" onClick={() => onEnd(session.id)} sx={{ ...smallButton, color: v.error }}>
              {t.endSession}
            </Button>
          ) : (
            <Button size="small" color="inherit" onClick={() => onRemove(session.id)} sx={smallButton}>
              {t.removeSession}
            </Button>
          )}
        </Details>
      )}
      {pending && placing && (
        <Box role="group" aria-label={`${placing.title} → ${session.title}`} sx={{ display: 'flex', alignItems: 'center', gap: '6px', m: `0 4px 6px ${22 + depth * INDENT}px` }}>
          <Button
            size="small"
            onClick={() => {
              onLink(pending.childId, session.id, 'group');
              dispatch({ type: 'settleLink' });
            }}
            sx={{ ...smallButton, minHeight: 32, px: 1.75, bgcolor: v.surface2, color: v.on, fontWeight: 500, '&:hover': { bgcolor: v.surface3 } }}
          >
            {t.groupAction}
          </Button>
          <Button
            size="small"
            variant="contained"
            disableElevation
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
  onRemove: (id: string) => void;
  /** Takes these ended sessions off the list at once (after asking). */
  onRemoveEnded: (sessions: SessionInfo[]) => void;
  /** Places a session under another one (grouped, or delegated to), or back at the top (null). */
  onLink: (childId: string, parentId: string | null, kind?: LinkKind) => void;
}

// The row that folds the ended sessions away, in `rowOpen`.
const ENDED_KEY = '#ended';

export function SessionTree({ sessions, links, state, dispatch, dnd, onNew, onEnd, onRemove, onRemoveEnded, onLink }: Props) {
  const groups = sessionTree(sessions, links);
  const shown = new Set(state.panes.filter((p) => !p.agentId).map((p) => p.sessionId));
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const tops = groups.flatMap((g) => g.nodes.map((n) => n.session));
  const root = { type: 'root' as const };
  const toTop = dnd.canDrop(root);
  const branch = { tops, shown, byId, state, dispatch, dnd, onEnd, onRemove, onLink };
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
      sx={{ flex: '1 1 272px', minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', gap: '2px', overflowY: { md: 'auto' }, scrollbarWidth: 'thin' }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, p: '2px 4px 6px 6px' }}>
        <Typography component="h2" sx={{ fontSize: 13, fontWeight: 600 }}>
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
          <Tooltip title={group.cwd} placement="right">
            <Typography sx={{ p: '10px 6px 4px', fontSize: 12, lineHeight: '16px', color: v.on2 }}>{group.label}</Typography>
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
            sx={{ minHeight: 32, gap: '6px', px: '6px', borderRadius: '6px', fontSize: 12, color: v.on2, '&:hover': { bgcolor: v.surface2 } }}
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
          onDrop={(event) => {
            const moving = dnd.dragging;
            dnd.drop(root)(event);
            if (moving?.kind === 'session') onLink(moving.id, null);
          }}
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
  );
}
