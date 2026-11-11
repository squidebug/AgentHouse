import { Box } from '@mui/material';
import type { SessionInfo } from '@agenthouse/protocol';
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
  return session.model ?? t.vendorName[session.vendor] ?? session.vendor;
}

export function sessionDetails(session: SessionInfo): Detail[] {
  const list: Detail[] = [{ k: 'CLI', v: [t.vendorName[session.vendor], session.cli.version].filter(Boolean).join(' ') }];
  if (session.model) list.push({ k: t.model, v: session.model });
  if (session.effort) list.push({ k: t.effort, v: session.effort });
  if (session.permissionMode) list.push({ k: t.permissionMode, v: session.permissionMode });
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
