import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { sameWindow, type AccountLimits, type RateWindow } from '@agenthouse/protocol';

const LINE_VERSION = 1;

// The usage screen shows a week and asks for the week before it too (a weekly window open when its
// first day began started up to seven days earlier). Nothing older than this is read for a request.
const MOST_DAYS = 31;

const monthOf = (at: number) => new Date(at).toISOString().slice(0, 7);

/** The months, as the files are named after them, from the one `from` is in to the one `to` is in. */
function monthsBetween(from: number, to: number): string[] {
  const months: string[] = [];
  const month = new Date(from);
  month.setUTCDate(1);
  month.setUTCHours(0, 0, 0, 0);
  while (month.getTime() <= to) {
    months.push(monthOf(month.getTime()));
    month.setUTCMonth(month.getUTCMonth() + 1);
  }
  return months;
}

/** A window whose reset time has passed says nothing about now. */
function current(window: RateWindow | null, now: number): RateWindow | null {
  return window && (window.resetsAt === null || window.resetsAt > now) ? window : null;
}

/** Drops windows that have reset since; null when none is left. */
export function stillValid(limits: AccountLimits, now = Date.now()): AccountLimits | null {
  const fiveHour = current(limits.fiveHour, now);
  const sevenDay = current(limits.sevenDay, now);
  return fiveHour || sevenDay ? { ...limits, fiveHour, sevenDay } : null;
}

/** A window as a line has it; null for none, and for anything that is not one. */
function windowOf(value: unknown): RateWindow | null {
  if (!value || typeof value !== 'object') return null;
  const { usedPct, resetsAt } = value as Record<string, unknown>;
  if (typeof usedPct !== 'number' || !Number.isFinite(usedPct)) return null;
  return { usedPct, resetsAt: typeof resetsAt === 'number' && Number.isFinite(resetsAt) ? resetsAt : null };
}

/** The entries of a month's file in the order they were written. A line cut short by a crash, or of another version, is left out. */
function entriesOf(text: string): AccountLimits[] {
  const entries: AccountLimits[] = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown> | null;
      if (entry?.v !== LINE_VERSION || (entry.vendor !== 'claude' && entry.vendor !== 'codex') || typeof entry.at !== 'number') continue;
      entries.push({ vendor: entry.vendor, fiveHour: windowOf(entry.fiveHour), sevenDay: windowOf(entry.sevenDay), at: entry.at });
    } catch {
      // a line cut short by a crash
    }
  }
  return entries;
}

/**
 * Plan usage as it changes, one JSON line per change, in a file per month
 * (usage/limits-YYYY-MM.jsonl). The last line of each account is what shows
 * after a restart, until a session reports again; the lines of the last days
 * are what the usage screen draws.
 */
export class LimitsLog {
  private readonly lastSeen = new Map<string, AccountLimits>();

  constructor(private readonly dir: string) {}

  private file(month: string): string {
    return path.join(this.dir, `limits-${month}.jsonl`);
  }

  /** The newest entry per account from this month's file, or last month's. */
  last(now = Date.now()): AccountLimits[] {
    const previous = new Date(now);
    previous.setUTCDate(1);
    previous.setUTCMonth(previous.getUTCMonth() - 1);
    for (const month of [monthOf(now), monthOf(previous.getTime())]) {
      let text: string;
      try {
        text = readFileSync(this.file(month), 'utf8');
      } catch {
        continue;
      }
      const latest = new Map<string, AccountLimits>();
      for (const entry of entriesOf(text)) latest.set(entry.vendor, entry);
      if (!latest.size) continue;
      for (const [vendor, limits] of latest) this.lastSeen.set(vendor, limits);
      return [...latest.values()].map((l) => stillValid(l, now)).filter((l): l is AccountLimits => l !== null);
    }
    return [];
  }

  /**
   * What the windows stood at whenever they changed since `from`, the oldest first: read from the
   * files of the months since then, a month back at most.
   */
  async since(from: number, now = Date.now()): Promise<AccountLimits[]> {
    const start = Math.max(from, now - MOST_DAYS * 24 * 3_600_000);
    const readings: AccountLimits[] = [];
    for (const month of monthsBetween(start, now)) {
      let text: string;
      try {
        text = await readFile(this.file(month), 'utf8');
      } catch {
        continue;
      }
      for (const entry of entriesOf(text)) {
        if (entry.at >= start) readings.push(entry);
      }
    }
    // Written in the order they came; a clock set back in between is the one thing that would undo that.
    return readings.sort((a, b) => a.at - b.at);
  }

  /** Appends the accounts whose windows changed since they were last written. */
  append(limits: AccountLimits[]): void {
    for (const entry of limits) {
      const before = this.lastSeen.get(entry.vendor);
      if (before && sameWindow(before.fiveHour, entry.fiveHour) && sameWindow(before.sevenDay, entry.sevenDay)) continue;
      this.lastSeen.set(entry.vendor, entry);
      try {
        mkdirSync(this.dir, { recursive: true, mode: 0o700 });
        appendFileSync(this.file(monthOf(entry.at)), `${JSON.stringify({ v: LINE_VERSION, ...entry })}\n`, { mode: 0o600 });
      } catch {
        // usage history is a convenience; the live value still shows
      }
    }
  }
}
