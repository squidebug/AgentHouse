import { Box, ButtonBase, Typography } from '@mui/material';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { isAsking, type SessionInfo, type SessionLink } from '@agenthouse/protocol';
import { useConversation } from '../api/conversation';
import { t } from '../strings';
import { v } from '../theme/tokens';
import { agentBars, ago, flowRows, labelPlace, place, sessionBars, ticks, timeWindow, type Bar, type BarKind, type FlowFilter, type FlowRow, type TimeWindow } from '../workspace/flow';
import { agentTitle } from './Details';
import { DelegateIcon, LinkIcon } from './icons';
import { AgentStatusIcon, StatusIcon } from './StatusIcon';

// The time track sits this far in from a lane's edges; the axis lines up with it.
const INSET = 8;

const BAR_SX: Record<BarKind, object> = {
  working: { bgcolor: v.primary },
  waiting: { background: `repeating-linear-gradient(135deg, ${v.warn} 0 4px, ${v.warnContainer} 4px 7px)` },
  done: { border: `1.5px solid ${v.done}` },
};

const busyRow = (row: FlowRow) =>
  row.kind === 'agent' ? row.agent.state === 'running' || row.agent.asking : row.session.status.value === 'working' || isAsking(row.session.status.value);

/** The time, moving every second while something works. */
function useNow(ticking: boolean): number {
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);
  return ticking ? tick : Date.now();
}

function Legend() {
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', fontSize: 12, lineHeight: '16px', color: v.on2 }}>
      {(['working', 'waiting', 'done'] as const).map((kind) => (
        <Box key={kind} component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
          <Box component="span" sx={{ width: 18, height: 8, boxSizing: 'border-box', borderRadius: '4px', ...BAR_SX[kind] }} />
          {t.legend[kind]}
        </Box>
      ))}
    </Box>
  );
}

function Axis({ window }: { window: TimeWindow }) {
  return (
    <Box aria-hidden sx={{ position: 'relative', height: 16, fontSize: 12, lineHeight: '16px', color: v.on2, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
      {ticks(window).map(({ pct, ago: before }) => (
        <Box
          key={pct}
          component="span"
          sx={{
            position: 'absolute',
            ...(pct === 0 ? { left: 0 } : pct === 100 ? { right: 0, fontWeight: 500, color: v.on } : { left: `${pct}%`, transform: 'translateX(-50%)' }),
            // Narrow panes keep the ends only.
            display: pct === 0 || pct === 100 || pct === 50 ? 'inline' : { xs: 'none', md: 'inline' },
          }}
        >
          {pct === 100 ? t.now : pct === 0 ? t.before(ago(before)) : ago(before)}
        </Box>
      ))}
    </Box>
  );
}

/** One lane of the graph: its name over its first bar, then its bars. */
function Lane({ row, bars, window, highlight, onOpen }: { row: FlowRow; bars: Bar[]; window: TimeWindow; highlight: boolean; onOpen: (row: FlowRow) => void }) {
  const title = row.kind === 'agent' ? agentTitle(row.agent) : row.session.title;
  const quiet = row.kind === 'agent' ? row.agent.state === 'stopped' && !row.agent.asking : row.session.state === 'exited';
  const label = labelPlace(bars, window);
  const offset = 'left' in label ? label.left : label.right;
  const link = row.kind === 'session' ? row.link : null;
  return (
    <ButtonBase
      onClick={() => onOpen(row)}
      aria-label={t.open(title)}
      sx={{ display: 'block', width: '100%', height: 40, borderRadius: '8px', bgcolor: highlight ? v.dropBg : 'transparent', '&:hover': { bgcolor: highlight ? v.dropBg : v.surface2 } }}
    >
      <Box component="span" sx={{ position: 'relative', display: 'block', height: '100%', mx: `${INSET}px` }}>
        <Box
          component="span"
          sx={{
            position: 'absolute',
            top: 4,
            ...('left' in label ? { left: `${label.left}%` } : { right: `${label.right}%` }),
            maxWidth: `${100 - offset}%`,
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            fontSize: 12,
            lineHeight: '16px',
            fontWeight: row.kind === 'session' ? 600 : 500,
            color: quiet ? v.on2 : v.on,
          }}
        >
          {row.kind === 'agent' ? <AgentStatusIcon agent={row.agent} size={12} /> : <StatusIcon status={row.session.status} size={12} />}
          <Box component="span" sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {title}
          </Box>
          {link &&
            (link.kind === 'delegate' ? (
              <DelegateIcon role="img" aria-label={t.delegate} size={12} style={{ flex: 'none', color: v.primary }} />
            ) : (
              <LinkIcon role="img" aria-label={t.group} size={12} style={{ flex: 'none', color: v.on2 }} />
            ))}
        </Box>
        {bars.map((bar, i) => {
          const at = place(bar, window);
          if (!at) return null;
          return (
            <Box
              key={i}
              component="span"
              sx={{ position: 'absolute', top: 24, height: 10, boxSizing: 'border-box', left: `${at.left}%`, width: `${at.width}%`, borderRadius: '5px', ...BAR_SX[bar.kind] }}
            />
          );
        })}
      </Box>
    </ButtonBase>
  );
}

interface Props {
  session: SessionInfo;
  /** The sessions placed under this one (grouped or delegated). */
  placed: SessionInfo[];
  links: SessionLink[];
  /** A sub-agent to point out: picked in the tree, or the one the pane came back from. */
  focusAgent: string | null;
  /** Shows a lane's own view: a sub-agent's conversation, a session's terminal. */
  onOpen: (row: FlowRow) => void;
}

/**
 * When everything under this session works, as a graph: a lane for the
 * session, each of its sub-agents and the sessions placed under it, in the
 * order the tree lists them, live. Who is under whom is the tree's to show.
 */
export function FlowView({ session, placed, links, focusAgent, onOpen }: Props) {
  const [filter, setFilter] = useState<FlowFilter>('all');
  const turns = useConversation(session.transcripts.length ? session.id : null, null, true).turns;
  const rows = flowRows(session, placed, links, filter);
  const now = useNow(rows.some(busyRow));
  const bars = new Map(rows.map((row) => [row.key, row.kind === 'agent' ? agentBars(row.agent, now) : sessionBars(row.session, row.session.id === session.id ? turns : null, now)]));
  const window = timeWindow([...bars.values()].flat(), now);
  const focused = useRef<HTMLDivElement>(null);

  // The agent picked in the tree is brought into view.
  useLayoutEffect(() => {
    focused.current?.scrollIntoView({ block: 'nearest' });
  }, [focusAgent]);

  const filterButton = (value: FlowFilter, label: string) => (
    <ButtonBase
      aria-pressed={filter === value}
      onClick={() => setFilter(value)}
      sx={{ height: 28, px: 1.5, borderRadius: '8px', fontSize: 12, fontWeight: 500, bgcolor: filter === value ? v.surface : 'transparent', color: filter === value ? v.on : v.on2 }}
    >
      {label}
    </ButtonBase>
  );

  return (
    <Box sx={{ height: '100%', overflowY: 'auto', pr: '8px', color: v.on }}>
      <Box sx={{ position: 'sticky', top: 0, zIndex: 2, bgcolor: v.termBg }}>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 14px', p: '4px 0 8px' }}>
          <Box role="group" aria-label={t.flow} sx={{ display: 'inline-flex', p: '2px', borderRadius: '10px', bgcolor: v.surface2 }}>
            {filterButton('all', t.filterAll)}
            {filterButton('running', t.filterRunning)}
          </Box>
          <Typography sx={{ fontSize: 12, color: v.on2 }}>{t.recent(ago(window.to - window.from))}</Typography>
          <Box sx={{ flex: 1 }} />
          <Legend />
        </Box>
        <Box sx={{ mx: `${INSET}px`, pb: '6px', borderBottom: `1px solid ${v.surface2}` }}>
          <Axis window={window} />
        </Box>
      </Box>
      <Box role="list" aria-label={`${session.title} ${t.flow}`} sx={{ position: 'relative', py: '4px' }}>
        <Box aria-hidden sx={{ position: 'absolute', top: 0, bottom: 0, left: INSET, right: INSET, pointerEvents: 'none' }}>
          {[25, 50, 75].map((pct) => (
            <Box key={pct} component="span" sx={{ position: 'absolute', left: `${pct}%`, top: 0, bottom: 0, width: '1px', bgcolor: v.surface2 }} />
          ))}
        </Box>
        {rows.map((row) => {
          const highlight = row.kind === 'agent' && row.agent.id === focusAgent;
          return (
            <Box key={row.key} role="listitem" aria-current={highlight ? 'true' : undefined} ref={highlight ? focused : undefined}>
              <Lane row={row} bars={bars.get(row.key) ?? []} window={window} highlight={highlight} onOpen={onOpen} />
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
