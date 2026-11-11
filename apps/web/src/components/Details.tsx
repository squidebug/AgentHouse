import { Box, Typography } from '@mui/material';
import type { SessionInfo, SessionStatus } from '@agenthouse/protocol';
import { t } from '../strings';
import { v } from '../theme/tokens';

export interface Detail {
  k: string;
  v: string;
  /** Wrap at path separators instead of in the middle of a folder name. */
  path?: boolean;
}

function withPathBreaks(path: string): React.ReactNode[] {
  return path.split(/(?<=[\\/])/).flatMap((part, i) => (i ? [<wbr key={i} />, part] : [part]));
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
  if (status.value === 'awaiting_permission' || status.value === 'awaiting_input') return { text: statusText(status), color: v.warn };
  if (status.error && status.value !== 'exited') return { text: statusText(status), color: v.error };
  if (status.value === 'working') return { text: statusText(status), color: v.primary };
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

const compact = (n: number) => (n >= 1_000_000 ? `${n / 1_000_000}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

export function sessionDetails(session: SessionInfo): Detail[] {
  const { telemetry } = session;
  const list: Detail[] = [
    { k: t.statusLabel, v: statusText(session.status) },
    { k: 'CLI', v: [t.vendorName[session.vendor], session.cli.version].filter(Boolean).join(' ') },
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
  list.push({ k: '경로', v: session.cwd, path: true });
  list.push({ k: '크기', v: `${session.cols}×${session.rows}` });
  list.push({ k: 'PID', v: String(session.pid) });
  if (session.exit) list.push({ k: '종료 코드', v: String(session.exit.code) });
  return list;
}

export function Details({ items, children, inset = 0 }: { items: Detail[]; children?: React.ReactNode; inset?: number }) {
  return (
    <Box
      sx={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        gap: '6px 14px',
        m: `0 4px 6px ${inset}px`,
        p: '8px 10px',
        borderRadius: '10px',
        bgcolor: v.surface2,
        fontSize: 12,
        lineHeight: '16px',
      }}
    >
      {items.map((item) => (
        <Box key={item.k} component="span" sx={{ display: 'inline-flex', gap: '6px', minWidth: 0, maxWidth: '100%' }}>
          <Box component="span" sx={{ color: v.on2, flex: 'none' }}>
            {item.k}
          </Box>
          <Box component="span" sx={{ fontWeight: 500, overflowWrap: 'anywhere' }}>
            {item.path ? withPathBreaks(item.v) : item.v}
          </Box>
        </Box>
      ))}
      {children}
    </Box>
  );
}
