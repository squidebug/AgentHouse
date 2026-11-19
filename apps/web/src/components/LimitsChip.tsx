import { Box, ButtonBase, Popover, Typography } from '@mui/material';
import { useEffect, useState } from 'react';
import type { AccountLimits, RateWindow } from '@agenthouse/protocol';
import { t } from '../strings';
import { motion, v } from '../theme/tokens';

/** A window whose reset time has passed no longer tells the usage. */
export const fresh = (window: RateWindow | null, now: number) => (window && (window.resetsAt === null || window.resetsAt > now) ? window : null);

/** How near a limit a share of it is: the color of a gauge, and of its number. */
export const tone = (pct: number) => (pct >= 90 ? v.error : pct >= 75 ? v.warn : v.primary);

export function resetText(at: number, now: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(t.locale, { hour: 'numeric', minute: '2-digit' });
  const day = new Date(now).toDateString() === date.toDateString() ? '' : `${date.toLocaleDateString(t.locale, { month: 'long', day: 'numeric', weekday: 'short' })} `;
  const minutes = Math.max(0, Math.round((at - now) / 60_000));
  const hours = Math.floor(minutes / 60);
  const { day: days, hour, minute } = t.unit;
  const left = hours >= 24 ? `${Math.floor(hours / 24)}${days} ${hours % 24}${hour}` : hours ? `${hours}${hour} ${minutes % 60}${minute}` : `${minutes}${minute}`;
  return `${t.resetsAt(`${day}${time}`)} · ${t.later(left)}`;
}

/** A share of something as a thin bar, in the color of how near its limit it is; as wide as its row unless given a width. */
export function Gauge({ label, pct, width, height, track }: { label: string; pct: number; width?: number; height: number; track: string }) {
  return (
    <Box role="meter" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} sx={{ flex: 'none', width, height, borderRadius: `${height / 2}px`, bgcolor: track, overflow: 'hidden' }}>
      <Box sx={{ width: `${Math.min(100, pct)}%`, height: '100%', borderRadius: 'inherit', bgcolor: tone(pct) }} />
    </Box>
  );
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
      <Gauge label={label} pct={pct} height={6} track={v.surface3} />
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
  const at = Math.max(now, Date.now());
  const fiveHour = fresh(claude?.fiveHour ?? null, at);
  const sevenDay = fresh(claude?.sevenDay ?? null, at);
  const windows: Array<{ label: string; window: RateWindow }> = [];
  if (fiveHour) windows.push({ label: t.fiveHour, window: fiveHour });
  if (sevenDay) windows.push({ label: t.sevenDay, window: sevenDay });
  const top = [...windows].sort((a, b) => b.window.usedPct - a.window.usedPct)[0];
  if (!claude || !top) return null;
  const pct = Math.round(top.window.usedPct);

  return (
    <>
      <ButtonBase
        onClick={(event) => setAnchor(event.currentTarget)}
        aria-label={`${t.usage} ${top.label} ${pct}%`}
        sx={{ height: 32, px: 1.25, gap: 0.75, borderRadius: '8px', fontSize: 12, color: v.on2, transition: `background-color ${motion.fast}`, '&:hover': { bgcolor: v.hover } }}
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
        <WindowRow label={t.fiveHour} window={fiveHour} now={now} />
        <WindowRow label={t.sevenDay} window={sevenDay} now={now} />
      </Popover>
    </>
  );
}
