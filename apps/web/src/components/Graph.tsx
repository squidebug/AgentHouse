import { Box, ButtonBase, Typography } from '@mui/material';
import { useMemo, useState, type ReactNode } from 'react';
import { isAgentBusy, type ConversationTurn, type DelegationInfo, type SessionInfo, type SessionLink } from '@agenthouse/protocol';
import { useTurns } from '../api/conversation';
import { t } from '../strings';
import { motion, v } from '../theme/tokens';
import { scheduleText, scheduleTitle, taskNote, taskTitle, taskType } from '../workspace/background';
import { agentBars, ago, place, sessionBars, timeWindow, type Bar } from '../workspace/flow';
import { forest, isBusy, layout, related, rowsOf, taskBars, toneOf, type GraphFilter, type GraphFolder, type GraphNode, type Layout, type Placed, type Sizes, type Tone } from '../workspace/graph';
import { AgentSubtitle, agentTitle, ExternalMark, SessionSubtitle } from './Details';
import { Axis, BAR_SX, Legend } from './FlowView';
import { ChevronIcon, ClockIcon, DelegateIcon, LinkIcon } from './icons';
import { useNow } from './now';
import { AgentStatusIcon, StatusIcon, TaskStatusIcon } from './StatusIcon';
import { switchSide, switchTrack } from './switch';

// A node is a row of the tree as a card: this wide and high, with this much room to the next one
// in its column and to the next column, where the lines run.
const SIZES: Sizes = { width: 232, height: 46, gap: 10, across: 96, folder: 24, after: 18, between: 8 };
// Each level of nesting moves a lane's name this far in.
const INDENT = 20;
// The lanes move every second while something works, and now and then otherwise.
const BUSY_TICK_MS = 1000;
const QUIET_TICK_MS = 15_000;

const small = { fontSize: 12, lineHeight: '16px' } as const;
const oneLine = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;
// A quiet line that folds nodes away or brings them back, as in the tree.
const foldSx = { gap: '6px', minHeight: 28, px: '8px', borderRadius: '6px', color: v.on2, transition: `background-color ${motion.fast}`, '&:hover': { bgcolor: v.hover }, ...small } as const;

const LINE: Record<NonNullable<Tone>, string> = { busy: v.primary, asks: v.warn };
const WORK_COLOR: Record<DelegationInfo['status'], string> = { running: v.primary, done: v.done, interrupted: v.on2, failed: v.error };

/** The work handed over a line of delegation: how it stands, and whether its answer went back. */
const workText = (work: DelegationInfo) => (work.delivery === 'none' ? t.delegation[work.status] : `${t.delegation[work.status]} · ${t.delivery[work.delivery]}`);

function titleOf(node: GraphNode): string {
  if (node.kind === 'session') return node.session.title;
  if (node.kind === 'agent') return agentTitle(node.agent);
  if (node.kind === 'task') return taskTitle(node.task);
  if (node.kind === 'schedule') return scheduleTitle(node.job);
  return node.folded > 0 ? t.finishedAgents(node.folded) : t.foldAgents;
}

/** Over: its name steps back, as in the tree. */
const isQuiet = (node: GraphNode) => (node.kind === 'session' ? node.session.state === 'exited' : node.kind === 'agent' ? !isAgentBusy(node.agent) : false);

/**
 * What a node shows of itself, as its row of the tree does: its state, its name, and under that its
 * model or what it is. `wide`: the words take the room there is, so that what follows them stands at the end.
 */
function Face({ node, wide = false }: { node: Exclude<GraphNode, { kind: 'fold' }>; wide?: boolean }) {
  const second = { ...small, ...oneLine, color: v.on2 } as const;
  return (
    <>
      {node.kind === 'session' && <StatusIcon status={node.session.status} />}
      {node.kind === 'agent' && <AgentStatusIcon agent={node.agent} />}
      {node.kind === 'task' && <TaskStatusIcon task={node.task} />}
      {node.kind === 'schedule' && <ClockIcon role="img" aria-label={t.scheduled} size={14} style={{ flex: 'none', color: v.on2 }} />}
      <Box component="span" sx={{ flex: wide ? 1 : '0 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column', textAlign: 'left' }}>
        <Box component="span" sx={{ ...oneLine, fontWeight: node.kind === 'session' ? 600 : 500, color: isQuiet(node) ? v.on2 : v.on }}>
          {titleOf(node)}
        </Box>
        {node.kind === 'session' && <SessionSubtitle session={node.session} />}
        {node.kind === 'agent' && <AgentSubtitle agent={node.agent} />}
        {node.kind === 'task' && (
          <Box component="span" sx={second}>
            {[taskType(node.task), taskNote(node.task)].filter(Boolean).join(' · ')}
          </Box>
        )}
        {node.kind === 'schedule' && (
          <Box component="span" sx={second}>
            {[scheduleText(node.job, Date.now()), node.job.runs ? t.runCount(node.job.runs) : null].filter(Boolean).join(' · ')}
          </Box>
        )}
      </Box>
      {node.kind === 'session' && node.session.external && <ExternalMark />}
    </>
  );
}

interface ViewProps {
  /** Shows a node's own view in the workspace; a fold opens or closes instead. */
  onOpen: (node: GraphNode) => void;
  allAgents: ReadonlySet<string>;
}

/** The finished sub-agents of a session, folded into one line or listed: the line that changes that. */
function AgentsFold({ node, allAgents, onOpen, sx }: ViewProps & { node: GraphNode; sx?: object }) {
  return (
    <ButtonBase onClick={() => onOpen(node)} aria-expanded={allAgents.has(node.session.id)} sx={{ ...foldSx, ...sx }}>
      <ChevronIcon open={allAgents.has(node.session.id)} size={14} />
      {titleOf(node)}
    </ButtonBase>
  );
}

/**
 * Who is under whom, as a tree on its side: a card for each session, sub-agent and thing a session
 * runs by itself, tied by a line to what it is under. A line to what works is primary, to what waits
 * for the user amber; delegation has an arrow and says how the work handed over stands, a group is
 * dashed. Pointed at, a node shows with what is above and under it, and the rest steps back.
 */
function MapView({ made, onOpen, allAgents }: ViewProps & { made: Layout }) {
  const [pointed, setPointed] = useState<string | null>(null);
  const lit = useMemo(() => (pointed ? related(made.placed, pointed) : null), [made, pointed]);
  const { width: wide, height: high, across } = SIZES;
  const faded = (...keys: string[]) => ({ opacity: lit && !keys.every((key) => lit.has(key)) ? 0.38 : 1, transition: `opacity ${motion.fast}` });
  const tied = made.placed.filter((at): at is Placed & { parent: Placed } => at.parent !== null);
  /** A line's ends, and a point along it: it leaves and arrives level, bending in the room between the columns. */
  const ends = (at: Placed & { parent: Placed }) => {
    const [x1, y1, x2, y2] = [at.parent.x + wide, at.parent.y + high / 2, at.x, at.y + high / 2];
    const along = (t0: number, a: number, b: number, c: number, d: number) => (1 - t0) ** 3 * a + 3 * (1 - t0) ** 2 * t0 * b + 3 * (1 - t0) * t0 ** 2 * c + t0 ** 3 * d;
    return { x1, y1, x2, y2, point: (t0: number) => ({ x: along(t0, x1, x1 + across / 2, x2 - across / 2, x2), y: along(t0, y1, y1, y2, y2) }) };
  };

  return (
    // What scrolls cuts off whatever is outside it: the padding is room for the cards' shadows.
    <Box sx={{ overflowX: 'auto', scrollbarWidth: 'thin', p: '4px 6px 8px', m: '-4px -6px -8px' }}>
      <Box role="group" aria-label={t.graphView.map} sx={{ position: 'relative', height: made.height, minWidth: made.width }}>
        <svg width={made.width} height={made.height} aria-hidden style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }}>
          {tied.map((at) => {
            const { node } = at;
            const { x1, y1, x2, y2 } = ends(at);
            const tone = toneOf(node);
            const color = tone ? LINE[tone] : v.outline;
            const delegated = node.kind === 'session' && node.link?.kind === 'delegate';
            const grouped = node.kind === 'session' && node.link?.kind === 'group';
            return (
              <g key={node.key} style={faded(node.key, at.parent.node.key)}>
                <path
                  d={`M ${x1} ${y1} C ${x1 + across / 2} ${y1}, ${x2 - across / 2} ${y2}, ${x2 - (delegated ? 7 : 0)} ${y2}`}
                  fill="none"
                  stroke={color}
                  strokeWidth={tone ? 2 : 1.5}
                  strokeDasharray={grouped ? '5 5' : undefined}
                />
                {delegated && <path d={`M ${x2} ${y2} l -8 -4.5 v 9 z`} fill={color} />}
              </g>
            );
          })}
        </svg>
        {tied.map((at) => {
          const { node } = at;
          if (node.kind !== 'session' || !node.work) return null;
          // On its line, near the end of it, where no other line passes.
          const { x, y } = ends(at).point(0.66);
          return (
            <Box
              key={node.key}
              component="span"
              sx={{ position: 'absolute', left: x, top: y, transform: 'translate(-50%, -50%)', p: '1px 6px', borderRadius: '9px', bgcolor: v.bg, color: WORK_COLOR[node.work.status], fontWeight: 500, whiteSpace: 'nowrap', pointerEvents: 'none', ...small, ...faded(node.key, at.parent.node.key) }}
            >
              {workText(node.work)}
            </Box>
          );
        })}
        {made.folders.map((folder) => (
          <Typography key={folder.cwd} title={folder.cwd} sx={{ position: 'absolute', left: 6, top: folder.y, color: v.on2, ...small }}>
            {folder.label}
          </Typography>
        ))}
        {made.placed.map(({ node, x, y }) => {
          const point = { onPointerEnter: () => setPointed(node.key), onPointerLeave: () => setPointed(null), onFocus: () => setPointed(node.key), onBlur: () => setPointed(null) };
          if (node.kind === 'fold') return <AgentsFold key={node.key} node={node} allAgents={allAgents} onOpen={onOpen} sx={{ position: 'absolute', left: x, top: y + (high - 28) / 2, ...faded(node.key) }} />;
          // What a session runs by itself is set into the page; what works under it is a card on it.
          const own = node.kind === 'task' || node.kind === 'schedule';
          return (
            <ButtonBase
              key={node.key}
              onClick={() => onOpen(node)}
              aria-label={t.open(titleOf(node))}
              {...point}
              sx={{
                position: 'absolute',
                left: x,
                top: y,
                width: wide,
                height: high,
                isolation: 'isolate',
                justifyContent: 'flex-start',
                gap: 1,
                px: '10px',
                borderRadius: '10px',
                bgcolor: own ? v.bg2 : v.surface,
                boxShadow: own ? 'none' : v.shadow1,
                '&::before': { content: '""', position: 'absolute', inset: 0, zIndex: -1, borderRadius: 'inherit', bgcolor: v.hover, opacity: 0, transition: `opacity ${motion.fast}` },
                '&:hover::before': { opacity: 1 },
                ...faded(node.key),
              }}
            >
              <Face node={node} wide />
            </ButtonBase>
          );
        })}
      </Box>
    </Box>
  );
}

/** The corner line in front of a lane under another, as in the tree. */
function Connector() {
  return <Box component="span" aria-hidden sx={{ flex: 'none', width: 8, height: 14, mt: '-10px', borderLeft: `1.5px solid ${v.outline}`, borderBottom: `1.5px solid ${v.outline}`, borderBottomLeftRadius: '5px' }} />;
}

const laneGrid = { display: 'grid', gridTemplateColumns: { xs: '180px minmax(0, 1fr)', md: '300px minmax(0, 1fr)' }, columnGap: '20px' } as const;

/** The stretches of time a node worked in, as far as they are known. */
function barsOf(node: GraphNode, turns: ReadonlyMap<string, ConversationTurn[]>, now: number): Bar[] {
  if (node.kind === 'session') return sessionBars(node.session, turns.get(node.session.id) ?? null, now);
  if (node.kind === 'agent') return agentBars(node.agent, now);
  return node.kind === 'task' ? taskBars(node.task, now) : [];
}

/**
 * When everything worked, all sessions on one sheet: on the left who is under whom, in the tree's
 * order, on the right a lane each over the same stretch of time. The pane's flow view shows one
 * session this way; here they lie side by side.
 */
function LanesView({ folders, onOpen, allAgents }: ViewProps & { folders: GraphFolder[] }) {
  const listed = folders.map((folder) => ({ ...folder, rows: rowsOf(folder.roots) }));
  const nodes = listed.flatMap((folder) => folder.rows.map((row) => row.node));
  // A session's turns come from its transcript: asked for where there is one.
  const turns = useTurns(nodes.flatMap((node) => (node.kind === 'session' && node.session.transcripts.length ? [node.session.id] : [])));
  // A bar grows while its node is at it; a prompt set for later has no bar of its own.
  const now = useNow(nodes.some((node) => node.kind !== 'schedule' && isBusy(node)) ? BUSY_TICK_MS : QUIET_TICK_MS);
  const bars = new Map(nodes.map((node) => [node.key, barsOf(node, turns, now)]));
  const window = timeWindow([...bars.values()].flat(), now);

  return (
    <Box sx={{ borderRadius: '12px', bgcolor: v.surface, boxShadow: v.shadow1, p: '4px 16px 10px' }}>
      <Box sx={{ ...laneGrid, alignItems: 'end', p: '10px 0 6px', borderBottom: `1px solid ${v.surface2}` }}>
        <Typography sx={{ color: v.on2, ...small }}>{t.recent(ago(window.to - window.from))}</Typography>
        <Axis window={window} />
      </Box>
      <Box role="list" aria-label={t.graphView.lanes}>
        {listed.map((folder) => (
          <Box key={folder.cwd} role="group" aria-label={folder.label}>
            <Typography title={folder.cwd} sx={{ p: '10px 0 2px', color: v.on2, ...small }}>
              {folder.label}
            </Typography>
            {folder.rows.map(({ node, depth }) => {
              const lines = (
                <Box component="span" sx={{ position: 'relative', display: 'block', height: 24 }}>
                  {[25, 50, 75].map((pct) => (
                    <Box key={pct} component="span" aria-hidden sx={{ position: 'absolute', left: `${pct}%`, top: -8, bottom: -8, width: '1px', bgcolor: v.surface2 }} />
                  ))}
                  {(bars.get(node.key) ?? []).map((bar, i) => {
                    const at = place(bar, window);
                    return at && <Box key={i} component="span" sx={{ position: 'absolute', top: 7, height: 10, boxSizing: 'border-box', left: `${at.left}%`, width: `${at.width}%`, borderRadius: '5px', ...BAR_SX[bar.kind] }} />;
                  })}
                </Box>
              );
              if (node.kind === 'fold') {
                return (
                  <Box key={node.key} role="listitem" sx={{ ...laneGrid, alignItems: 'center', minHeight: 32 }}>
                    <Box sx={{ pl: `${depth * INDENT + 14}px` }}>
                      <AgentsFold node={node} allAgents={allAgents} onOpen={onOpen} />
                    </Box>
                    {lines}
                  </Box>
                );
              }
              const link = node.kind === 'session' ? node.link : null;
              return (
                <Box key={node.key} role="listitem">
                  <ButtonBase
                    onClick={() => onOpen(node)}
                    aria-label={t.open(titleOf(node))}
                    sx={{ ...laneGrid, width: '100%', minHeight: 40, alignItems: 'center', borderRadius: '8px', transition: `background-color ${motion.fast}`, '&:hover': { bgcolor: v.hover } }}
                  >
                    <Box component="span" sx={{ minWidth: 0, display: 'flex', alignItems: 'center', gap: 1, pl: `${depth * INDENT}px` }}>
                      {depth > 0 && <Connector />}
                      <Face node={node} />
                      {link &&
                        (link.kind === 'delegate' ? (
                          <DelegateIcon role="img" aria-label={t.delegate} size={12} style={{ flex: 'none', color: v.primary }} />
                        ) : (
                          <LinkIcon role="img" aria-label={t.group} size={12} style={{ flex: 'none', color: v.on2 }} />
                        ))}
                    </Box>
                    {lines}
                  </ButtonBase>
                </Box>
              );
            })}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

/** What the three kinds of line mean. */
function LineLegend() {
  const sample = (label: string, line: ReactNode) => (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
      <svg width={26} height={10} aria-hidden style={{ overflow: 'visible' }}>
        {line}
      </svg>
      {label}
    </Box>
  );
  const stroke = { fill: 'none', stroke: v.outline, strokeWidth: 1.5 } as const;
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', color: v.on2, ...small }}>
      {sample(t.subagent, <path d="M 0 5 H 26" style={stroke} />)}
      {sample(
        t.delegate,
        <>
          <path d="M 0 5 H 19" style={stroke} />
          <path d="M 26 5 l -8 -4.5 v 9 z" style={{ fill: v.outline }} />
        </>,
      )}
      {sample(t.group, <path d="M 0 5 H 26" style={{ ...stroke, strokeDasharray: '5 5' }} />)}
    </Box>
  );
}

const VIEWS = ['map', 'lanes'] as const;
const FILTERS: ReadonlyArray<readonly [GraphFilter, string]> = [
  ['all', t.filterAll],
  ['running', t.filterRunning],
];

interface Props {
  sessions: SessionInfo[];
  links: SessionLink[];
  delegations: DelegationInfo[];
  /** Shows a session in the workspace, or one of its sub-agents in its flow there. */
  onOpen: (sessionId: string) => void;
  onOpenAgent: (sessionId: string, agentId: string) => void;
}

/**
 * Every session with what runs under it, in two views: who is under whom (a tree on its side) and
 * when each worked (lanes over time). Both list what the session tree lists, in its order; ended
 * sessions and many finished sub-agents fold away as they do there.
 */
export function Graph({ sessions, links, delegations, onOpen, onOpenAgent }: Props) {
  const [view, setView] = useState<(typeof VIEWS)[number]>('map');
  const [filter, setFilter] = useState<GraphFilter>('all');
  const [allAgents, setAllAgents] = useState<ReadonlySet<string>>(new Set());
  const [ended, setEnded] = useState(false);
  const { folders, foldedEnded } = forest(sessions, links, delegations, { filter, allAgents, ended });

  const open = (node: GraphNode) => {
    if (node.kind === 'fold') {
      setAllAgents((current) => {
        const next = new Set(current);
        if (!next.delete(node.session.id)) next.add(node.session.id);
        return next;
      });
    } else if (node.kind === 'agent') onOpenAgent(node.session.id, node.agent.id);
    // What a session runs by itself is looked at in that session.
    else onOpen(node.session.id);
  };
  const side = (chosen: boolean) => ({ ...switchSide(chosen), height: 28, px: '12px', fontSize: 13, fontWeight: 500 });

  return (
    <Box component="section" aria-label={t.screen.graph} sx={{ minHeight: '100%', display: 'flex', flexDirection: 'column', gap: '12px', p: '12px 16px 24px' }}>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 16px', minHeight: 36, pl: '6px' }}>
        {/* On the page, so their tracks have the page's fill. */}
        <Box role="group" aria-label={t.views} sx={{ ...switchTrack, bgcolor: v.bg2 }}>
          {VIEWS.map((one) => (
            <ButtonBase key={one} aria-pressed={view === one} onClick={() => setView(one)} sx={side(view === one)}>
              {t.graphView[one]}
            </ButtonBase>
          ))}
        </Box>
        <Box role="group" aria-label={t.filters} sx={{ ...switchTrack, bgcolor: v.bg2 }}>
          {FILTERS.map(([one, label]) => (
            <ButtonBase key={one} aria-pressed={filter === one} onClick={() => setFilter(one)} sx={side(filter === one)}>
              {label}
            </ButtonBase>
          ))}
        </Box>
        <Box sx={{ flex: 1 }} />
        {view === 'map' ? <LineLegend /> : <Legend />}
      </Box>

      {folders.length === 0 ? (
        <Typography sx={{ pl: '6px', color: v.on2 }}>{sessions.length ? t.none : t.noSessions}</Typography>
      ) : view === 'map' ? (
        <MapView made={layout(folders, SIZES)} onOpen={open} allAgents={allAgents} />
      ) : (
        <LanesView folders={folders} onOpen={open} allAgents={allAgents} />
      )}

      {foldedEnded > 0 && filter === 'all' && (
        <ButtonBase onClick={() => setEnded((open) => !open)} aria-expanded={ended} sx={{ ...foldSx, alignSelf: 'flex-start', px: '6px' }}>
          <ChevronIcon open={ended} size={14} />
          {t.endedSessions(foldedEnded)}
        </ButtonBase>
      )}
    </Box>
  );
}
