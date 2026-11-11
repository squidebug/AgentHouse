import { Box, ButtonBase, Popover, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import type { AccountLimits, RateWindow } from '@agenthouse/protocol';
import { t } from '../strings';
import { v } from '../theme/tokens';

const tone = (pct: number) => (pct >= 90 ? v.error : pct >= 75 ? v.warn : v.primary);

function resetText(at: number, now: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
  const day = new Date(now).toDateString() === date.toDateString() ? '' : `${date.toLocaleDateString('ko-KR', { month: 'long', day: 'numeric', weekday: 'short' })} `;
  const minutes = Math.max(0, Math.round((at - now) / 60_000));
  const hours = Math.floor(minutes / 60);
  const left = hours >= 24 ? `${Math.floor(hours / 24)}일 ${hours % 24}시간` : hours ? `${hours}시간 ${minutes % 60}분` : `${minutes}분`;
  return `${day}${time} ${t.resetsAt} · ${left} 후`;
}

function WindowRow({ label, window, now }: { label: string; window: RateWindow | null; now: number }) {
  if (!window) return null;
  const pct = Math.round(window.usedPct);
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      <Box sx={{ display: 'flex', alignItems: 'baseline' }}>
        <Typography sx={{ fontWeight: 500 }}>{label}</Typography>
        <Box sx={{ flex: 1 }} />
        <Typography sx={{ fontWeight: 600, color: tone(pct) }}>{pct}%</Typography>
      </Box>
      <Box role="meter" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} sx={{ height: 6, borderRadius: 3, bgcolor: v.surface3, overflow: 'hidden' }}>
        <Box sx={{ width: `${Math.min(100, pct)}%`, height: '100%', borderRadius: 3, bgcolor: tone(pct) }} />
      </Box>
      {window.resetsAt !== null && <Typography sx={{ fontSize: 12, lineHeight: '16px', color: v.on2 }}>{resetText(window.resetsAt, now)}</Typography>}
    </Box>
  );
}

/**
 * Plan usage, one number at rest: whichever window (5 hours or weekly) is
 * closer to its limit. The popover shows both with their reset times.
 */
export function LimitsChip({ limits }: { limits: AccountLimits[] }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!anchor) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [anchor]);

  const claude = limits.find((l) => l.vendor === 'claude');
  const windows: Array<{ label: string; window: RateWindow }> = [];
  if (claude?.fiveHour) windows.push({ label: t.fiveHour, window: claude.fiveHour });
  if (claude?.sevenDay) windows.push({ label: t.sevenDay, window: claude.sevenDay });
  const top = [...windows].sort((a, b) => b.window.usedPct - a.window.usedPct)[0];
  if (!claude || !top) return null;
  const pct = Math.round(top.window.usedPct);

  return (
    <>
      <ButtonBase
        onClick={(event) => setAnchor(event.currentTarget)}
        aria-label={`${t.usage} ${top.label} ${pct}%`}
        sx={{ height: 32, px: 1.25, gap: 0.75, borderRadius: '8px', fontSize: 12, color: v.on2, '&:hover': { bgcolor: v.surface2 } }}
      >
        <span>{top.label}</span>
        <Box component="span" sx={{ fontWeight: 600, color: tone(pct) }}>
          {pct}%
        </Box>
      </ButtonBase>
      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { width: 300, maxWidth: 'calc(100vw - 32px)', p: 2, display: 'flex', flexDirection: 'column', gap: 2 } } }}
      >
        <Typography sx={{ fontSize: 14, fontWeight: 600 }}>
          {t.vendorName.claude} {t.usage}
        </Typography>
        <WindowRow label={t.fiveHour} window={claude.fiveHour} now={now} />
        <WindowRow label={t.sevenDay} window={claude.sevenDay} now={now} />
      </Popover>
    </>
  );
}
