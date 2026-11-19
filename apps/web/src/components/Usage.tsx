import { Box, ButtonBase, Typography } from '@mui/material';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from 'react';
import type { AccountLimits } from '@agenthouse/protocol';
import { api } from '../api/client';
import { t } from '../strings';
import { v } from '../theme/tokens';
import { askedSince, dayStart, daysOf, frameOf, inFrame, openWindow, paceOf, shareAt, toldBy, usedByDay, windowsOf, withLive, type Frame, type UsageWindow, type WindowKind } from '../workspace/usage';
import { Gauge, resetText, tone } from './LimitsChip';
import { useNow } from './now';
import { switchSide, switchTrack } from './switch';

// When a window starts over is told to the minute, and so is the time a graph points at.
const TICK_MS = 60_000;
// A graph is this high; its width is its card's.
const HEIGHT = 188;
// A share this near its limit is marked, in the color its gauge has then.
const NEAR = 75;
// Room for what a pointer is told: it goes to the pointer's left where it would not fit on its right.
const TIP_ROOM = 190;

const small = { fontSize: 12, lineHeight: '16px' } as const;

const dayText = (time: number, month = true) => new Date(time).toLocaleDateString('ko-KR', month ? { month: 'long', day: 'numeric', weekday: 'short' } : { day: 'numeric', weekday: 'short' });
const clockText = (time: number) => new Date(time).toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' });
const hourText = (time: number) => new Date(time).toLocaleTimeString('ko-KR', { hour: 'numeric' });

/**
 * The readings of the usage log the screen draws: asked for when it shows, when the live value
 * changes (a line was written) and when a day begins. A request that fails leaves what was there.
 */
function useReadings(since: number, live: string): AccountLimits[] {
  const [readings, setReadings] = useState<AccountLimits[]>([]);
  useEffect(() => {
    let gone = false;
    api
      .usage(since)
      .then((history) => {
        if (!gone) setReadings(history.readings);
      })
      .catch(() => {});
    return () => {
      gone = true;
    };
  }, [since, live]);
  return readings;
}

/** How wide an element is, as it is laid out: a graph is drawn to the pixel, not stretched. */
function useWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    const measure = () => setWidth(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

/** Where a graph draws: the scale has its numbers to the left, the days their names below, and the value now its number to the right. */
interface Plot {
  left: number;
  right: number;
  top: number;
  bottom: number;
}
const plotOf = (width: number): Plot => ({ left: 44, right: width - 48, top: 22, bottom: HEIGHT - 24 });
const across = (plot: Plot, frame: Frame) => (time: number) => plot.left + ((time - frame.from) / (frame.to - frame.from)) * (plot.right - plot.left);
const crisp = (at: number) => Math.round(at) + 0.5;

const textStyle = { fontSize: 12, fill: v.on2, fontVariantNumeric: 'tabular-nums' } as const;
const strongStyle = { ...textStyle, fill: v.on, fontWeight: 500 } as const;

/**
 * The days under a plot, and a hairline where one begins. The month is named with the first day and
 * where one begins; in a plot too narrow for the names, a day is its number.
 */
function Days({ plot, frame, today }: { plot: Plot; frame: Frame; today: number }) {
  const x = across(plot, frame);
  const named = (plot.right - plot.left) / frame.days.length >= 64;
  return (
    <>
      {frame.days.map((day, i) => (
        <g key={day}>
          {i > 0 && <line x1={crisp(x(day))} x2={crisp(x(day))} y1={plot.top} y2={plot.bottom} stroke={v.surface3} shapeRendering="crispEdges" />}
          <text x={x((day + (frame.days[i + 1] ?? frame.to)) / 2)} y={plot.bottom + 18} textAnchor="middle" style={day === today ? strongStyle : textStyle}>
            {named ? dayText(day, i === 0 || new Date(day).getDate() === 1) : new Date(day).getDate()}
          </text>
        </g>
      ))}
    </>
  );
}

/** The scale of a plot: a line at each mark, its number to the left. */
function Scale({ plot, marks, y }: { plot: Plot; marks: number[]; y: (pct: number) => number }) {
  return (
    <>
      {marks.map((mark) => (
        <g key={mark}>
          <line x1={plot.left} x2={plot.right} y1={crisp(y(mark))} y2={crisp(y(mark))} stroke={v.surface3} shapeRendering="crispEdges" />
          <text x={plot.left - 8} y={y(mark) + 4} textAnchor="end" style={textStyle}>
            {mark ? `${mark}%` : '0'}
          </text>
        </g>
      ))}
    </>
  );
}

/** A plot nothing was read for. */
function Nothing({ plot }: { plot: Plot }) {
  return (
    <text x={(plot.left + plot.right) / 2} y={(plot.top + plot.bottom) / 2 + 4} textAnchor="middle" style={textStyle}>
      {t.noReadings}
    </text>
  );
}

/** What a pointer is told, next to what it points at: the app's tooltip, with the numbers in a column. */
function Tip({ at, width, children }: { at: number; width: number; children: ReactNode }) {
  return (
    <Box
      role="tooltip"
      sx={{
        position: 'absolute',
        top: 4,
        ...(at + 12 + TIP_ROOM > width ? { right: width - at + 12 } : { left: at + 12 }),
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        p: '6px 10px',
        borderRadius: '8px',
        bgcolor: v.inverse,
        color: v.onInverse,
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
        zIndex: 2,
        ...small,
        '& b': { display: 'inline-block', minWidth: 38, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
      }}
    >
      {children}
    </Box>
  );
}

const share = (pct: number | null) => (pct === null ? '–' : `${pct}%`);

interface TimeChartProps {
  kind: WindowKind;
  windows: UsageWindow[];
  frame: Frame;
  now: number;
  /** The time pointed at, in this graph or the other one over time: both mark it. */
  pointed: number | null;
  /** What is told of that time, in the graph the pointer is over. */
  tip: ReactNode;
  onPoint: (time: number | null) => void;
}

/**
 * The share used of a kind of window over the days. Each window is a mark of its own: a line that
 * steps where a reading changed it, over a wash from its first reading to where it starts over.
 * The one still open says what it stands at; one that is over, the most it reached.
 */
function TimeChart({ kind, windows, frame, now, pointed, tip, onPoint }: TimeChartProps) {
  const [ref, width] = useWidth();
  const plot = plotOf(width);
  const x = across(plot, frame);
  const y = (pct: number) => plot.bottom - (Math.min(100, pct) / 100) * (plot.bottom - plot.top);
  const clip = `ah-usage-${kind}`;

  const drawn = useMemo(() => {
    const seen = windows.filter(inFrame(frame));
    const open = openWindow(windows, now);
    const top = seen.reduce<UsageWindow | null>((best, one) => (!best || one.peak > best.peak ? one : best), null);
    return (
      <>
        <g clipPath={`url(#${clip})`}>
          {seen.map((one) => {
            const first = one.points[0]!;
            const line = `M ${x(first.at)} ${y(first.pct)}${one.points
              .slice(1)
              .map((point) => ` H ${x(point.at)} V ${y(point.pct)}`)
              .join('')} H ${x(one.end)}`;
            return (
              <g key={one.resetsAt}>
                <path d={`${line} V ${y(0)} H ${x(first.at)} Z`} fill={v.primary} opacity={0.12} />
                <path d={line} fill="none" stroke={v.primary} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
              </g>
            );
          })}
          {seen.map((one) =>
            one === open ? (
              <circle key={one.resetsAt} cx={x(now)} cy={y(one.pct)} r={4} fill={tone(one.pct)} stroke={v.surface} strokeWidth={2} />
            ) : (
              // One that came near its limit is marked where it ended.
              one.peak >= NEAR && <circle key={one.resetsAt} cx={x(one.end)} cy={y(one.peak)} r={4} fill={tone(one.peak)} stroke={v.surface} strokeWidth={2} />
            ),
          )}
        </g>
        {seen.map((one) => {
          if (one === open) {
            return (
              <text key={one.resetsAt} x={x(now) + 9} y={y(one.pct) + 4} style={strongStyle}>
                {one.pct}%
              </text>
            );
          }
          // A weekly window says what it ended at; of the 5-hour ones, which are many, only the highest does.
          if (kind === 'sevenDay') {
            return (
              x(one.end) > plot.left + 44 && (
                <text key={one.resetsAt} x={x(one.end) - 8} y={y(one.peak) - 8} textAnchor="end" style={strongStyle}>
                  {one.peak}%
                </text>
              )
            );
          }
          return (
            one === top &&
            x(one.end) > plot.left + 16 && (
              <text key={one.resetsAt} x={x(one.end)} y={y(one.peak) - 10} textAnchor="middle" style={strongStyle}>
                {one.peak}%
              </text>
            )
          );
        })}
        {seen.length === 0 && <Nothing plot={plot} />}
      </>
    );
    // Drawn again when what it shows changes, not with every move of the pointer. Where things lie
    // (`plot`, `x`, `y`) comes from the width and the frame.
  }, [windows, frame, now, width, kind]);

  const onMove = (event: PointerEvent<HTMLDivElement>) => {
    const at = event.clientX - event.currentTarget.getBoundingClientRect().left;
    const time = Math.round((frame.from + ((at - plot.left) / (plot.right - plot.left)) * (frame.to - frame.from)) / TICK_MS) * TICK_MS;
    onPoint(at < plot.left || time < frame.from || time > now ? null : time);
  };
  const stood = pointed === null ? null : shareAt(windows, pointed);

  return (
    <Box ref={ref} onPointerMove={onMove} onPointerLeave={() => onPoint(null)} sx={{ position: 'relative', minWidth: 0, height: HEIGHT }}>
      {width > 0 && (
        <svg width={width} height={HEIGHT} role="img" aria-label={t.usageChart[kind]} style={{ display: 'block' }}>
          <defs>
            <clipPath id={clip}>
              <rect x={plot.left - 5} y={0} width={plot.right - plot.left + 11} height={HEIGHT} />
            </clipPath>
          </defs>
          <Scale plot={plot} marks={[0, 50, 100]} y={y} />
          <Days plot={plot} frame={frame} today={dayStart(now)} />
          {drawn}
          {pointed !== null && (
            <>
              <line x1={crisp(x(pointed))} x2={crisp(x(pointed))} y1={plot.top} y2={plot.bottom} stroke={v.on2} shapeRendering="crispEdges" />
              {stood !== null && <circle cx={x(pointed)} cy={y(stood)} r={4} fill={v.primary} stroke={v.surface} strokeWidth={2} />}
            </>
          )}
        </svg>
      )}
      {pointed !== null && tip && (
        <Tip at={x(pointed)} width={width}>
          {tip}
        </Tip>
      )}
    </Box>
  );
}

/** How much of the weekly window each day took: a column a day. */
function DayChart({ days, frame, now, any }: { days: Array<{ day: number; pct: number }>; frame: Frame; now: number; any: boolean }) {
  const [ref, width] = useWidth();
  const [over, setOver] = useState<number | null>(null);
  const plot = plotOf(width);
  const x = across(plot, frame);
  const most = days.reduce((top, one) => (one.pct > top.pct ? one : top));
  const ceiling = Math.max(10, Math.ceil(most.pct / 10) * 10);
  const y = (pct: number) => plot.bottom - (pct / ceiling) * (plot.bottom - plot.top);
  const today = dayStart(now);
  // Where a day lies under the plot, and the column in the middle of it.
  const bands = days.map((one, i) => {
    const from = x(one.day);
    const wide = x(frame.days[i + 1] ?? frame.to) - from;
    const thick = Math.min(16, Math.max(4, Math.floor(wide * 0.5)));
    return { ...one, from, wide, thick, at: from + (wide - thick) / 2 };
  });
  const pointed = over === null ? undefined : bands[over];

  return (
    <Box ref={ref} onPointerLeave={() => setOver(null)} sx={{ position: 'relative', minWidth: 0, height: HEIGHT }}>
      {width > 0 && (
        <svg width={width} height={HEIGHT} role="img" aria-label={t.usageChart.daily} style={{ display: 'block' }}>
          <Scale plot={plot} marks={[0, ceiling / 2, ceiling]} y={y} />
          <Days plot={plot} frame={frame} today={today} />
          {pointed && <rect x={pointed.from} y={plot.top} width={pointed.wide} height={plot.bottom - plot.top} fill={v.hover} />}
          {bands.map(({ day, pct, at, thick }) => {
            if (pct <= 0) return null;
            // Rounded where it ends, flat where it stands.
            const cap = Math.min(4, thick / 2, plot.bottom - y(pct));
            return (
              <g key={day}>
                <path
                  d={`M ${at} ${plot.bottom} V ${y(pct) + cap} Q ${at} ${y(pct)} ${at + cap} ${y(pct)} H ${at + thick - cap} Q ${at + thick} ${y(pct)} ${at + thick} ${y(pct) + cap} V ${plot.bottom} Z`}
                  fill={v.primary}
                />
                {(day === most.day || day === today) && (
                  <text x={at + thick / 2} y={y(pct) - 6} textAnchor="middle" style={strongStyle}>
                    {pct}%
                  </text>
                )}
              </g>
            );
          })}
          {!any && <Nothing plot={plot} />}
          {bands.map(({ day, from, wide }, i) => (
            <rect key={day} x={from} y={plot.top} width={wide} height={plot.bottom - plot.top} fill="transparent" onPointerEnter={() => setOver(i)} />
          ))}
        </svg>
      )}
      {pointed && (
        <Tip at={pointed.from + pointed.wide / 2 + 4} width={width}>
          <Box component="span" sx={{ opacity: 0.8 }}>
            {dayText(pointed.day)}
          </Box>
          <span>
            <b>{pointed.pct}%</b>
            {t.ofWeekly}
          </span>
        </Tip>
      )}
    </Box>
  );
}

/**
 * What a window stands at now: its number, its gauge when it is a share of a limit (`pct`), and what
 * is said of it under them. Without a number (`value` null) nothing is known of it now.
 */
function Tile({ title, value, pct, lines }: { title: string; value: ReactNode; pct: number | null; lines: Array<{ text: string; warn?: boolean } | null> }) {
  return (
    <Box sx={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: '6px', pb: '6px' }}>
      <Typography component="h3" sx={{ fontSize: 14, fontWeight: 600 }}>
        {title}
      </Typography>
      <Typography sx={{ fontSize: 18, lineHeight: '28px', fontWeight: 600, ...(value === null ? { color: v.on2 } : pct !== null && { color: tone(pct) }) }}>{value ?? '–'}</Typography>
      {pct !== null && <Gauge label={title} pct={pct} height={6} track={v.surface3} />}
      {lines.map(
        (line) =>
          line && (
            <Typography key={line.text} sx={{ ...small, ...(line.warn ? { color: v.warn, fontWeight: 500 } : { color: v.on2 }) }}>
              {line.text}
            </Typography>
          ),
      )}
    </Box>
  );
}

const cellSx = { p: '6px 12px 6px 0', borderTop: `1px solid ${v.surface3}` } as const;
const numberSx = { width: 96, pr: 0, textAlign: 'right', fontVariantNumeric: 'tabular-nums' } as const;

/** What a graph draws, in rows: what each row is of, and its number. */
function Rows({ heads, rows }: { heads: [string, string]; rows: Array<{ key: number; of: string; value: ReactNode }> }) {
  if (!rows.length) return <Typography sx={{ color: v.on2 }}>{t.noReadings}</Typography>;
  return (
    // As high as its rows: next to a taller neighbor in the card it is not stretched.
    <Box component="table" sx={{ alignSelf: 'start', width: '100%', maxWidth: 560, borderCollapse: 'collapse', fontSize: 13, lineHeight: '20px' }}>
      <thead>
        <tr>
          {heads.map((head, i) => (
            <Box key={head} component="th" scope="col" sx={{ p: '0 12px 6px 0', textAlign: 'left', fontWeight: 500, color: v.on2, ...small, ...(i > 0 && numberSx) }}>
              {head}
            </Box>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key}>
            <Box component="td" sx={cellSx}>
              {row.of}
            </Box>
            <Box component="td" sx={{ ...cellSx, ...numberSx, fontWeight: 500 }}>
              {row.value}
            </Box>
          </tr>
        ))}
      </tbody>
    </Box>
  );
}

/** A window's share in a row; one that came near its limit has the mark it has in the graph. */
function Reached({ pct }: { pct: number }) {
  return (
    <>
      {pct >= NEAR && <Box component="span" aria-hidden sx={{ display: 'inline-block', width: 8, height: 8, mr: '6px', borderRadius: '50%', bgcolor: tone(pct) }} />}
      {pct}%
    </>
  );
}

// A window is a card: what it stands at now, and next to that how it got there.
const cardSx = {
  display: 'grid',
  gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: '272px minmax(0, 1fr)' },
  gap: '12px',
  p: '16px 12px 10px 20px',
  borderRadius: '12px',
  bgcolor: v.surface,
  boxShadow: v.shadow1,
} as const;

const VIEWS = ['chart', 'table'] as const;

/**
 * Plan usage over the last seven days, from the usage log: the 5-hour window, the weekly window and
 * what each day took of the weekly one. On the left of each what it stands at now, on the right how
 * it went, as a graph or as the same in rows.
 */
export function Usage({ limits }: { limits: AccountLimits[] }) {
  const now = useNow(TICK_MS);
  const [view, setView] = useState<(typeof VIEWS)[number]>('chart');
  // The time pointed at, and which of the two graphs over time the pointer is over.
  const [pointed, setPointed] = useState<{ time: number; on: WindowKind } | null>(null);
  const today = dayStart(now);
  const frame = useMemo(() => frameOf(today), [today]);

  const live = useMemo(() => limits.filter((one) => one.vendor === 'claude'), [limits]);
  const logged = useReadings(askedSince(frame), JSON.stringify(live.map((one) => [one.fiveHour, one.sevenDay])));
  const readings = useMemo(() => withLive(logged, live).filter((one) => one.vendor === 'claude'), [logged, live]);
  const five = useMemo(() => windowsOf(readings, 'fiveHour', now), [readings, now]);
  const week = useMemo(() => windowsOf(readings, 'sevenDay', now), [readings, now]);
  const { days, today: usedToday, mean } = useMemo(() => daysOf(frame, usedByDay(week)), [frame, week]);
  const fiveNow = openWindow(five, now);
  const weekNow = openWindow(week, now);
  // What a day took is known from the readings of that day: with none in these days there is nothing to draw.
  const weekRead = week.some((one) => one.points.some((point) => point.at >= frame.from));
  const heading = weekNow ? paceOf(weekNow, now) : null;
  const pace = heading && ('atReset' in heading ? { text: t.paceAtReset(heading.atReset) } : { text: t.paceFull(`${dayText(heading.fullAt, false)} ${hourText(heading.fullAt)}`), warn: true });

  const charts = view === 'chart';
  const tip = pointed && (
    <>
      <Box component="span" sx={{ opacity: 0.8 }}>
        {dayText(pointed.time)} {clockText(pointed.time)}
      </Box>
      <span>
        <b>{share(shareAt(five, pointed.time))}</b>
        {t.fiveHour}
      </span>
      <span>
        <b>{share(shareAt(week, pointed.time))}</b>
        {t.sevenDay}
      </span>
    </>
  );
  const overTime = (kind: WindowKind, windows: UsageWindow[]) => (
    <TimeChart
      kind={kind}
      windows={windows}
      frame={frame}
      now={now}
      pointed={pointed?.time ?? null}
      tip={pointed?.on === kind ? tip : null}
      onPoint={(time) => setPointed(time === null ? null : { time, on: kind })}
    />
  );
  // The latest first, as rows are read.
  const rowsOf = (windows: UsageWindow[], of: (one: UsageWindow) => string) =>
    windows
      .filter(inFrame(frame))
      .reverse()
      .map((one) => ({ key: one.resetsAt, of: of(one), value: <Reached pct={toldBy(one, openWindow(windows, now))} /> }));

  return (
    <Box component="section" aria-label={t.screen.usage} sx={{ minHeight: '100%', display: 'flex', flexDirection: 'column', gap: '12px', p: '12px 16px 24px' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, minHeight: 36, pl: '6px' }}>
        <Typography component="h2" sx={{ fontSize: 14, fontWeight: 600 }}>
          {t.vendorName.claude}
        </Typography>
        <Box sx={{ flex: 1 }} />
        {/* On the page, so its track has the page's fill. */}
        <Box role="group" aria-label={t.views} sx={{ ...switchTrack, bgcolor: v.bg2 }}>
          {VIEWS.map((one) => (
            <ButtonBase key={one} aria-pressed={view === one} onClick={() => setView(one)} sx={{ ...switchSide(view === one), height: 28, px: '12px', fontSize: 13, fontWeight: 500 }}>
              {t.usageView[one]}
            </ButtonBase>
          ))}
        </Box>
      </Box>

      <Box role="group" aria-label={t.fiveHour} sx={cardSx}>
        <Tile title={t.fiveHour} value={fiveNow ? `${fiveNow.pct}%` : null} pct={fiveNow?.pct ?? null} lines={[fiveNow ? { text: resetText(fiveNow.resetsAt, now) } : null]} />
        {charts ? (
          overTime('fiveHour', five)
        ) : (
          <Rows heads={[t.usageHead.window, t.usageHead.peak]} rows={rowsOf(five, (one) => `${dayText(one.start)} ${clockText(one.start)} – ${clockText(one.resetsAt)}`)} />
        )}
      </Box>

      <Box role="group" aria-label={t.sevenDay} sx={cardSx}>
        <Tile title={t.sevenDay} value={weekNow ? `${weekNow.pct}%` : null} pct={weekNow?.pct ?? null} lines={[weekNow ? { text: resetText(weekNow.resetsAt, now) } : null, pace]} />
        {charts ? overTime('sevenDay', week) : <Rows heads={[t.usageHead.window, t.usageHead.end]} rows={rowsOf(week, (one) => `${dayText(one.start)} – ${dayText(one.resetsAt)}`)} />}
      </Box>

      <Box role="group" aria-label={t.daily} sx={cardSx}>
        <Tile
          title={t.daily}
          // Today's share is of the weekly window that is open: without one, nothing is known of today.
          value={
            weekNow ? (
              <>
                {usedToday}%{' '}
                <Box component="span" sx={{ fontSize: 13, fontWeight: 400, color: v.on2 }}>
                  {t.today}
                </Box>
              </>
            ) : null
          }
          pct={null}
          lines={[{ text: mean ? `${t.ofWeekly} · ${t.dailyMean(mean)}` : t.ofWeekly }]}
        />
        {charts ? (
          <DayChart days={days} frame={frame} now={now} any={weekRead} />
        ) : (
          <Rows heads={[t.usageHead.day, t.usageHead.used]} rows={[...days].reverse().map((one) => ({ key: one.day, of: dayText(one.day), value: one.pct ? `${one.pct}%` : '–' }))} />
        )}
      </Box>
    </Box>
  );
}
