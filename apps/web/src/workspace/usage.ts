// The usage screen: what the plan's windows stood at over the last days, read
// from the readings of the usage log. Kept free of React so it can be tested directly.
import type { AccountLimits } from '@agenthouse/protocol';

const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
/** The screen shows this many days, today the last of them. */
export const DAYS_SHOWN = 7;
/** How long a window of each kind lasts. */
const LASTS = { fiveHour: 5 * HOUR, sevenDay: 7 * DAY } as const;
export type WindowKind = keyof typeof LASTS;

export function dayStart(time: number): number {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** The days the screen shows, each by its start, and the time they span. */
export interface Frame {
  from: number;
  to: number;
  days: number[];
}

export function frameOf(now: number): Frame {
  const day = new Date(dayStart(now));
  day.setDate(day.getDate() - (DAYS_SHOWN - 1));
  const days: number[] = [];
  for (let n = 0; n < DAYS_SHOWN; n += 1) {
    days.push(day.getTime());
    day.setDate(day.getDate() + 1);
  }
  return { from: days[0]!, to: day.getTime(), days };
}

/**
 * From when the readings are asked for: a weekly window open when the first day began started up
 * to seven days before it, and every reading of a window that shows is needed to draw it.
 */
export const askedSince = (frame: Frame): number => frame.from - LASTS.sevenDay;

/** The readings with the live value after them: what a session reported a moment ago is in the log, but may not have been read from it yet. */
export function withLive(readings: AccountLimits[], live: AccountLimits[]): AccountLimits[] {
  const last = readings.at(-1)?.at ?? 0;
  return [...readings, ...live.filter((entry) => entry.at > last)];
}

/** From `at` on a window stood at `pct`. */
export interface Point {
  at: number;
  pct: number;
}

/** One window of the plan, as the readings tell of it. */
export interface UsageWindow {
  start: number;
  resetsAt: number;
  /** Where its share used changed, the oldest first; never empty. */
  points: Point[];
  /** What it stands at: its latest reading, which is what the top bar's chip says of the one still open. */
  pct: number;
  /** The most it reached: what one that has started over is told by. */
  peak: number;
  /** Until when it is drawn: when it starts over, now for the one still open, or when the next one was first read of. */
  end: number;
}

/**
 * The windows of a kind that the readings tell of, in the order they were first read of, each
 * with its readings as they came. A share used only grows until its window starts over, so a
 * lower one is an older reading told again by a session that had not asked since: it shows as it
 * was reported, and the next reading of any session puts it right. A reading of a window that had
 * started over by then says nothing at all.
 */
export function windowsOf(readings: AccountLimits[], kind: WindowKind, now: number): UsageWindow[] {
  const found = new Map<number, UsageWindow>();
  for (const reading of readings) {
    const window = reading[kind];
    // Without a time to start over it has no place.
    if (!window || window.resetsAt === null || window.resetsAt <= reading.at) continue;
    const pct = Math.round(window.usedPct);
    let one = found.get(window.resetsAt);
    if (!one) found.set(window.resetsAt, (one = { start: window.resetsAt - LASTS[kind], resetsAt: window.resetsAt, points: [], pct, peak: pct, end: Math.min(window.resetsAt, now) }));
    if (one.points.at(-1)?.pct !== pct) one.points.push({ at: reading.at, pct });
    one.pct = pct;
    one.peak = Math.max(one.peak, pct);
  }
  const windows = [...found.values()];
  // A window whose time to start over was moved is told of as another one from then on.
  windows.forEach((one, i) => {
    const next = windows[i + 1];
    if (next) one.end = Math.min(one.end, next.points[0]!.at);
  });
  return windows;
}

/** The one still open, if any: the latest, unless it has started over. */
export function openWindow(windows: UsageWindow[], now: number): UsageWindow | undefined {
  const last = windows.at(-1);
  return last && last.resetsAt > now ? last : undefined;
}

/** The number a window is told by: what it stands at while it is open, the most it reached once it is over. */
export const toldBy = (one: UsageWindow, open: UsageWindow | undefined): number => (one === open ? one.pct : one.peak);

/** Drawn in the frame: it was read of before the frame ends and lasted into it. */
export const inFrame =
  (frame: Frame) =>
  (one: UsageWindow): boolean =>
    one.end > frame.from && one.points[0]!.at < frame.to;

/**
 * How much of the weekly window each day took, by the day's start: what the window grew by from
 * one reading to the next, on the day of the later one. A window's first reading adds nothing: it
 * tells what was used before the window was looked at, not when. Nor does what only makes up for
 * an older reading told again: a share counts once, when the window first reaches it.
 */
export function usedByDay(weeks: UsageWindow[]): Map<number, number> {
  const used = new Map<number, number>();
  for (const week of weeks) {
    let reached = week.points[0]!.pct;
    for (const point of week.points) {
      if (point.pct <= reached) continue;
      const day = dayStart(point.at);
      used.set(day, (used.get(day) ?? 0) + point.pct - reached);
      reached = point.pct;
    }
  }
  return used;
}

/** What the windows stood at at a time, as the readings told it then; null where none was open, or none read of yet. */
export function shareAt(windows: UsageWindow[], time: number): number | null {
  for (let n = windows.length - 1; n >= 0; n -= 1) {
    const one = windows[n]!;
    if (time < one.points[0]!.at || time >= one.resetsAt) continue;
    let pct = one.points[0]!.pct;
    for (const point of one.points) {
      if (point.at > time) break;
      pct = point.pct;
    }
    return pct;
  }
  return null;
}

/** Where a window is heading: what it stands at when it starts over, or when it is full before that. */
export type Pace = { atReset: number } | { fullAt: number };

/**
 * Where the open weekly window is heading at the rate it has gone since it began. Nothing in its
 * first day (too early to tell), while nothing is used, and once it is full.
 */
export function paceOf(week: Pick<UsageWindow, 'start' | 'resetsAt' | 'pct'>, now: number): Pace | null {
  const gone = now - week.start;
  if (gone < DAY || now >= week.resetsAt || week.pct <= 0 || week.pct >= 100) return null;
  const rate = week.pct / gone;
  const atReset = rate * (week.resetsAt - week.start);
  return atReset < 100 ? { atReset: Math.round(atReset) } : { fullAt: week.start + 100 / rate };
}

/** What each day of the frame took of the weekly window, today's share, and the mean of the days that took any. */
export function daysOf(frame: Frame, used: Map<number, number>): { days: Array<{ day: number; pct: number }>; today: number; mean: number } {
  const days = frame.days.map((day) => ({ day, pct: used.get(day) ?? 0 }));
  const some = days.filter((one) => one.pct > 0);
  return { days, today: days.at(-1)!.pct, mean: some.length ? Math.round(some.reduce((sum, one) => sum + one.pct, 0) / some.length) : 0 };
}
