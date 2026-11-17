import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { sameWindow, type AccountLimits, type RateWindow } from '@agenthouse/protocol';

const LINE_VERSION = 1;

const monthOf = (at: number) => new Date(at).toISOString().slice(0, 7);

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

/**
 * Plan usage as it changes, one JSON line per change, in a file per month
 * (usage/limits-YYYY-MM.jsonl). The last line of each account is what shows
 * after a restart, until a session reports again; the lines are kept for a
 * usage history.
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
      for (const line of text.split('\n')) {
        try {
          const entry = JSON.parse(line) as AccountLimits & { v?: unknown };
          if (entry.v === LINE_VERSION && typeof entry.vendor === 'string' && typeof entry.at === 'number') {
            latest.set(entry.vendor, { vendor: entry.vendor, fiveHour: entry.fiveHour ?? null, sevenDay: entry.sevenDay ?? null, at: entry.at });
          }
        } catch {
          // a line cut short by a crash
        }
      }
      if (!latest.size) continue;
      for (const [vendor, limits] of latest) this.lastSeen.set(vendor, limits);
      return [...latest.values()].map((l) => stillValid(l, now)).filter((l): l is AccountLimits => l !== null);
    }
    return [];
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
