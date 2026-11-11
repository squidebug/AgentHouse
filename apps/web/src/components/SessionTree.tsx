import { Box, Button, ButtonBase, IconButton, Tooltip, Typography } from '@mui/material';
import type { SessionInfo } from '@agenthouse/protocol';
import { t } from '../strings';
import { v } from '../theme/tokens';
import type { Dnd } from '../workspace/dnd';
import type { Action, WorkspaceState } from '../workspace/state';
import { Details, modelLabel, sessionDetails } from './Details';
import { ChevronIcon, Grip, PlusIcon } from './icons';
import { StatusIcon } from './StatusIcon';

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
  const shown = new Set(state.panes.map((p) => p.sessionId));

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
                  <StatusIcon state={session.state} />
                  <ButtonBase
                    onClick={() => dispatch({ type: 'open', sessionId: session.id })}
                    aria-label={`${session.title} 열기`}
                    sx={{ flex: 1, minWidth: 0, flexDirection: 'column', alignItems: 'flex-start', textAlign: 'left', py: '3px', borderRadius: '6px' }}
                  >
                    <Typography noWrap sx={{ maxWidth: '100%', fontWeight: 500, color: session.state === 'exited' ? v.on2 : v.on }}>
                      {session.title}
                    </Typography>
                    <Typography noWrap sx={{ maxWidth: '100%', fontSize: 12, lineHeight: '16px', color: v.on2 }}>
                      {modelLabel(session)}
                    </Typography>
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
              </Box>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}
