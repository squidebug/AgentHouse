import { Box, Typography } from '@mui/material';
import { isAsking, type AgentInfo, type SessionInfo, type SessionStatus } from '@agenthouse/protocol';
import { t } from '../strings';
import { v } from '../theme/tokens';
import { elapsedMs } from '../workspace/agents';
import { compactCount, duration, modelName } from '../workspace/conversation';
import { PathText } from './PathText';

export interface Detail {
  k: string;
  v: string;
  /** A path: on a line of its own, cut at its start when it does not fit. */
  path?: boolean;
}

/** Collapsed views show only the model; everything else lives behind the expand toggle. */
export function modelLabel(session: SessionInfo): string {
  return session.telemetry.model ?? session.model ?? t.vendorName[session.vendor] ?? session.vendor;
}

/** "승인 대기 · Write", "작업 중 · Bash", "대기 · 중단됨". */
export function statusText(status: SessionStatus): string {
  const base = status.error && status.value !== 'exited' ? t.error : (t.status[status.value] ?? status.value);
  const detail = status.reason ? (t.reason[status.reason] ?? status.reason) : status.value === 'working' ? status.tool : null;
  return detail ? `${base} · ${detail}` : base;
}

/** What a collapsed row adds after the model: only states worth a glance. */
export function activity(session: SessionInfo): { text: string; color: string } | null {
  const { status } = session;
  if (isAsking(status.value)) return { text: statusText(status), color: v.warn };
  if (status.error && status.value !== 'exited') return { text: statusText(status), color: v.error };
  if (status.value === 'working') return { text: statusText(status), color: v.primary };
  // Nothing reports what it does: said in words, so the quiet icon is not taken for "idle".
  if (status.value === 'unobserved') return { text: statusText(status), color: v.on2 };
  return null;
}

/** The second line of a row or pane header: the model, plus the state when it is worth a glance. */
export function SessionSubtitle({ session }: { session: SessionInfo }) {
  const now = activity(session);
  return (
    <Typography noWrap sx={{ maxWidth: '100%', fontSize: 12, lineHeight: '16px', color: v.on2 }}>
      {modelLabel(session)}
      {now && (
        <Box component="span" sx={{ color: now.color, fontWeight: 500 }}>
          {` · ${now.text}`}
        </Box>
      )}
    </Typography>
  );
}

/** "작업 중 · Read", "승인 대기 · Write", "완료". */
export function agentStatusText(agent: AgentInfo): string {
  const base = t.agentState[agent.asking ? 'asking' : agent.state] ?? agent.state;
  return agent.tool && (agent.asking || agent.state === 'running') ? `${base} · ${agent.tool}` : base;
}

/** A sub-agent's row title: what it was asked to do, else its kind. */
export const agentTitle = (agent: AgentInfo) => agent.description ?? agent.agentType;

/** The second line of a sub-agent's row or pane: its kind and model, plus what it does when worth a glance. */
export function AgentSubtitle({ agent }: { agent: AgentInfo }) {
  const now = agent.asking ? { text: agentStatusText(agent), color: v.warn } : agent.state === 'running' && agent.tool ? { text: agent.tool, color: v.primary } : null;
  return (
    <Typography noWrap sx={{ maxWidth: '100%', fontSize: 12, lineHeight: '16px', color: v.on2 }}>
      {[agent.agentType, agent.model && modelName(agent.model)].filter(Boolean).join(' · ')}
      {now && (
        <Box component="span" sx={{ color: now.color, fontWeight: 500 }}>
          {` · ${now.text}`}
        </Box>
      )}
    </Typography>
  );
}

export function agentDetails(agent: AgentInfo, agents: AgentInfo[], session: SessionInfo, now = Date.now()): Detail[] {
  const parent = agent.parentId ? agents.find((a) => a.id === agent.parentId) : undefined;
  const list: Detail[] = [
    { k: t.statusLabel, v: agentStatusText(agent) },
    { k: t.agentType, v: agent.agentType },
  ];
  if (agent.model) list.push({ k: t.model, v: modelName(agent.model) });
  if (agent.tokens !== null) list.push({ k: t.tokens, v: compactCount(agent.tokens) });
  list.push({ k: t.elapsed, v: duration(elapsedMs(agent, now)) });
  list.push({ k: parent ? t.parentAgent : t.session, v: parent ? agentTitle(parent) : session.title });
  return list;
}

const compact = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

export function sessionDetails(session: SessionInfo): Detail[] {
  const { telemetry } = session;
  const list: Detail[] = [
    { k: t.statusLabel, v: statusText(session.status) },
    { k: t.cli, v: [t.vendorName[session.vendor], session.cli.version].filter(Boolean).join(' ') },
  ];
  const model = telemetry.model ?? session.model;
  if (model) list.push({ k: t.model, v: model });
  const effort = telemetry.effort ?? session.effort;
  if (effort) list.push({ k: t.effort, v: effort });
  if (telemetry.contextPct !== null) {
    const size = telemetry.contextWindow ? ` / ${compact(telemetry.contextWindow)}` : '';
    list.push({ k: t.context, v: `${Math.round(telemetry.contextPct)}%${size}` });
  }
  if (session.permissionMode) list.push({ k: t.permissionMode, v: session.permissionMode });
  if (telemetry.costUsd) list.push({ k: t.cost, v: `$${telemetry.costUsd.toFixed(2)}` });
  list.push({ k: t.size, v: `${session.cols}×${session.rows}` });
  list.push({ k: t.pid, v: String(session.pid) });
  if (session.exit?.code != null) list.push({ k: t.exitCode, v: String(session.exit.code) });
  // Last, on a line of its own across the columns.
  list.push({ k: t.path, v: session.cwd, path: true });
  return list;
}

// Every label starts its value at the same place: wide enough for 컨텍스트, 권한 모드, API 환산.
const LABEL_PX = 64;

/**
 * What a row or a pane shows when opened: a line per fact, its label in a
 * column of its own so the values line up, in as many columns as fit (one in
 * the tree, several in a pane). What can be done about it (`children`) sits
 * below a line, apart from what is only read.
 */
export function Details({ items, children, inset = 0 }: { items: Detail[]; children?: React.ReactNode; inset?: number }) {
  return (
    <Box sx={{ m: `0 4px 6px ${inset}px`, p: '8px 10px', borderRadius: '10px', bgcolor: v.surface2, fontSize: 12, lineHeight: '18px' }}>
      <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: '2px 20px' }}>
        {items.map((item) => (
          <Box key={item.k} sx={{ display: 'grid', gridTemplateColumns: `${LABEL_PX}px minmax(0, 1fr)`, columnGap: '8px', gridColumn: item.path ? '1 / -1' : 'auto' }}>
            <Box component="dt" sx={{ color: v.on2 }}>
              {item.k}
            </Box>
            <Box component="dd" sx={{ m: 0, minWidth: 0, overflowWrap: 'anywhere' }}>
              {item.path ? <PathText path={item.v} /> : item.v}
            </Box>
          </Box>
        ))}
      </Box>
      {children && <Box sx={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '2px', mt: '6px', mx: '-6px', pt: '4px', borderTop: `1px solid ${v.outline}` }}>{children}</Box>}
    </Box>
  );
}
