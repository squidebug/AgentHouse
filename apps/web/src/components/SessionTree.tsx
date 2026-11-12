import { Box, Button, ButtonBase, IconButton, Tooltip, Typography } from '@mui/material';
import type { AgentInfo, SessionInfo } from '@agenthouse/protocol';
import { t } from '../strings';
import { v } from '../theme/tokens';
import { agentRows, SHOWN_FINISHED } from '../workspace/agents';
import type { Dnd } from '../workspace/dnd';
import type { Action, WorkspaceState } from '../workspace/state';
import { AgentSubtitle, agentDetails, agentTitle, Details, SessionSubtitle, sessionDetails } from './Details';
import { ChevronIcon, Grip, PlusIcon } from './icons';
import { AgentStatusIcon, StatusIcon } from './StatusIcon';

// Each level of nesting moves a row this far in.
const INDENT = 18;

interface AgentRowProps {
  session: SessionInfo;
  agent: AgentInfo;
  depth: number;
  shown: boolean;
  state: WorkspaceState;
  dispatch: (action: Action) => void;
  dnd: Dnd;
}

/** A sub-agent under its session (or under the agent that started it): opens its own conversation. */
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
        <AgentStatusIcon agent={agent} />
        <ButtonBase
          onClick={() => dispatch({ type: 'open', sessionId: session.id, agentId: agent.id })}
          aria-label={`${title} 열기`}
          sx={{ flex: 1, minWidth: 0, flexDirection: 'column', alignItems: 'flex-start', textAlign: 'left', py: '2px', borderRadius: '6px' }}
        >
          <Typography noWrap sx={{ maxWidth: '100%', fontWeight: 500, color: agent.state === 'stopped' && !agent.asking ? v.on2 : v.on }}>
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

/** A session's sub-agents as nested rows; finished ones fold away when there are many. */
function AgentRows({ session, state, dispatch, dnd }: Omit<AgentRowProps, 'agent' | 'depth' | 'shown'>) {
  const allKey = `${session.id}#agents`;
  const all = Boolean(state.rowOpen[allKey]);
  const { rows, folded } = agentRows(session.agents, all);
  const finished = session.agents.filter((a) => a.state === 'stopped' && !a.asking).length;
  const shown = new Set(state.panes.filter((p) => p.sessionId === session.id && p.agentId).map((p) => p.agentId));
  return (
    <Box role="group" aria-label={`${session.title} ${t.subagent}`}>
      {rows.map(({ agent, depth }) => (
        <AgentRow key={agent.id} session={session} agent={agent} depth={depth} shown={shown.has(agent.id)} state={state} dispatch={dispatch} dnd={dnd} />
      ))}
      {(folded > 0 || (all && finished > SHOWN_FINISHED)) && (
        <ButtonBase
          onClick={() => dispatch({ type: 'toggleRow', id: allKey })}
          aria-expanded={all}
          sx={{ minHeight: 28, ml: `${30 + INDENT}px`, px: '6px', borderRadius: '6px', fontSize: 12, color: v.on2, '&:hover': { bgcolor: v.surface2 } }}
        >
          {folded > 0 ? t.finishedAgents(folded) : t.foldAgents}
        </ButtonBase>
      )}
    </Box>
  );
}

interface Props {
  sessions: SessionInfo[];
  state: WorkspaceState;
  dispatch: (action: Action) => void;
  dnd: Dnd;
  onNew: () => void;
  onEnd: (id: string) => void;
  onRemove: (id: string) => void;
}

function folderName(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd;
}

/** Sessions grouped by working folder, in the order they were started. */
function groupByFolder(sessions: SessionInfo[]): Array<{ cwd: string; label: string; sessions: SessionInfo[] }> {
  const groups = new Map<string, SessionInfo[]>();
  for (const session of sessions) groups.set(session.cwd, [...(groups.get(session.cwd) ?? []), session]);
  return [...groups].map(([cwd, list]) => ({ cwd, label: folderName(cwd), sessions: list }));
}

export function SessionTree({ sessions, state, dispatch, dnd, onNew, onEnd, onRemove }: Props) {
  const shown = new Set(state.panes.filter((p) => !p.agentId).map((p) => p.sessionId));

  return (
    <Box component="aside" aria-label={t.sessions} sx={{ flex: '1 1 272px', minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' }}>
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

      {groupByFolder(sessions).map((group) => (
        <Box key={group.cwd} role="group" aria-label={group.label}>
          <Tooltip title={group.cwd} placement="right">
            <Typography sx={{ p: '10px 6px 4px', fontSize: 12, lineHeight: '16px', color: v.on2 }}>{group.label}</Typography>
          </Tooltip>
          {group.sessions.map((session) => {
            const open = Boolean(state.rowOpen[session.id]);
            const dragged = dnd.dragging?.kind === 'session' && dnd.dragging.id === session.id;
            return (
              <Box key={session.id}>
                <Box
                  className="ah-row"
                  draggable
                  onDragStart={dnd.start({ kind: 'session', id: session.id })}
                  sx={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 1,
                    minHeight: 44,
                    p: '2px 4px',
                    borderRadius: '10px',
                    bgcolor: shown.has(session.id) ? v.surface : 'transparent',
                    opacity: dragged ? 0.45 : 1,
                    cursor: 'grab',
                  }}
                >
                  <Grip className="ah-grip" />
                  <StatusIcon status={session.status} />
                  <ButtonBase
                    onClick={() => dispatch({ type: 'open', sessionId: session.id })}
                    aria-label={`${session.title} 열기`}
                    sx={{ flex: 1, minWidth: 0, flexDirection: 'column', alignItems: 'flex-start', textAlign: 'left', py: '3px', borderRadius: '6px' }}
                  >
                    <Typography noWrap sx={{ maxWidth: '100%', fontWeight: 500, color: session.state === 'exited' ? v.on2 : v.on }}>
                      {session.title}
                    </Typography>
                    <SessionSubtitle session={session} />
                  </ButtonBase>
                  <IconButton
                    aria-label={`${session.title} ${t.details}`}
                    aria-expanded={open}
                    onClick={() => dispatch({ type: 'toggleRow', id: session.id })}
                    sx={{ width: 36, height: 36, color: v.on2 }}
                  >
                    <ChevronIcon open={open} size={16} />
                  </IconButton>
                </Box>
                {open && (
                  <Details items={sessionDetails(session)} inset={22}>
                    {session.state === 'running' ? (
                      <Button size="small" color="inherit" onClick={() => onEnd(session.id)} sx={{ minHeight: 28, px: 1.5, fontSize: 12, color: v.error }}>
                        {t.endSession}
                      </Button>
                    ) : (
                      <Button size="small" color="inherit" onClick={() => onRemove(session.id)} sx={{ minHeight: 28, px: 1.5, fontSize: 12 }}>
                        {t.removeSession}
                      </Button>
                    )}
                  </Details>
                )}
                {session.agents.length > 0 && <AgentRows session={session} state={state} dispatch={dispatch} dnd={dnd} />}
              </Box>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}
