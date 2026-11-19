import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AccountLimits } from '@agenthouse/protocol';
import { askedSince, DAY, daysOf, frameOf, inFrame, openWindow, paceOf, shareAt, toldBy, usedByDay, windowsOf, withLive } from '../src/workspace/usage';

const HOUR = 3_600_000;
// A Wednesday afternoon, in whatever zone the test runs.
const at = (day: number, hour = 0, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();
const NOW = at(18, 14, 20);
const reading = (time: number, five: [number, number | null] | null, week: [number, number | null] | null = null): AccountLimits => ({
  vendor: 'claude',
  fiveHour: five && { usedPct: five[0], resetsAt: five[1] },
  sevenDay: week && { usedPct: week[0], resetsAt: week[1] },
  at: time,
});

test('the frame is the seven days that end with today, and the readings are asked for from a week before it', () => {
  const frame = frameOf(NOW);
  assert.deepEqual(frame.days, [12, 13, 14, 15, 16, 17, 18].map((day) => at(day)));
  assert.deepEqual([frame.from, frame.to], [at(12), at(19)]);
  assert.deepEqual(frameOf(at(18)).days, frame.days, 'from its first moment a day is today');
  assert.equal(askedSince(frame), at(12) - 7 * DAY);
});

test('readings become windows: one per time of starting over, a point where its share changed', () => {
  const first = at(18, 3);
  const second = at(18, 15);
  const windows = windowsOf(
    [
      reading(at(17, 22, 10), [4, first]),
      reading(at(17, 22, 30), [4, first]),
      reading(at(17, 23, 5), [9, first]),
      reading(at(18, 10, 2), [0, second]),
      reading(at(18, 10, 2) + 1, null),
      reading(at(18, 11, 0), [31, null]),
      reading(at(18, 12, 0), [40, second]),
    ],
    'fiveHour',
    NOW,
  );
  assert.deepEqual(windows, [
    { start: first - 5 * HOUR, resetsAt: first, points: [{ at: at(17, 22, 10), pct: 4 }, { at: at(17, 23, 5), pct: 9 }], pct: 9, peak: 9, end: first },
    { start: second - 5 * HOUR, resetsAt: second, points: [{ at: at(18, 10, 2), pct: 0 }, { at: at(18, 12, 0), pct: 40 }], pct: 40, peak: 40, end: NOW },
  ]);
  assert.equal(openWindow(windows, NOW), windows[1]);
  assert.equal(openWindow(windows, second), undefined, 'it has started over');
  assert.equal(openWindow([], NOW), undefined);
  assert.deepEqual(windowsOf([reading(at(18, 9), null, [55.4, at(20, 9)])], 'sevenDay', NOW)[0]?.pct, 55, 'whole percents');
});

test('an older reading told again: of a window that had started over it says nothing, of less than its window had reached it shows as it came', () => {
  const first = at(18, 3);
  const second = at(18, 15);
  const told = [
    reading(at(17, 23), [60, first]),
    reading(at(18, 10), [20, second]),
    reading(at(18, 10, 30), [60, first]),
    reading(at(18, 11), [35, second]),
    reading(at(18, 11, 30), [20, second]),
    reading(at(18, 12), [36, second]),
  ];
  const windows = windowsOf(told, 'fiveHour', NOW);
  assert.deepEqual(windows.map((one) => one.points.map((point) => point.pct)), [[60], [20, 35, 20, 36]]);
  assert.deepEqual(windows.map((one) => [one.pct, one.peak]), [[60, 60], [36, 36]]);
  assert.deepEqual(windowsOf([reading(at(18, 10, 30), [60, first])], 'fiveHour', NOW), [], 'nothing else was read of it');

  // The latest reading is what a window stands at, as the top bar's chip has it; once it is over, the most it reached tells it.
  const [, open] = windowsOf([...told, reading(at(18, 13), [30, second])], 'fiveHour', NOW);
  assert.deepEqual([open?.pct, open?.peak], [30, 36]);
  assert.deepEqual([toldBy(open!, open), toldBy(open!, undefined)], [30, 36]);
});

test('a window whose time to start over was moved ends where it is first read of with the new one', () => {
  const windows = windowsOf([reading(at(15, 9), null, [30, at(20, 9)]), reading(at(16, 9), null, [41, at(19, 9)]), reading(at(17, 9), null, [50, at(19, 9)])], 'sevenDay', NOW);
  assert.deepEqual(windows.map((one) => [one.pct, one.end]), [[30, at(16, 9)], [50, NOW]]);
  assert.equal(openWindow(windows, NOW)?.pct, 50, 'the one read of last');
  assert.equal(shareAt(windows, at(16, 12)), 41);
});

test('what a day took of the weekly window: what it grew by between readings, on the day of the later one', () => {
  const week = at(20, 9);
  const next = week + 7 * DAY;
  const weeks = windowsOf(
    [
      reading(at(16, 10), null, [40, week]),
      reading(at(16, 15), null, [44, week]),
      reading(at(17, 9, 5), null, [45, week]),
      reading(at(17, 18), null, [52, week]),
      reading(at(20, 9, 30), null, [3, next]),
      reading(at(20, 11), null, [5, next]),
    ],
    'sevenDay',
    at(20, 12),
  );
  assert.deepEqual([...usedByDay(weeks)], [[at(16), 4], [at(17), 8], [at(20), 2]], "a window's first reading tells what was used before it was looked at, not when");
  const { days, today, mean } = daysOf(frameOf(at(20, 12)), usedByDay(weeks));
  assert.deepEqual(days.map((one) => one.pct), [0, 0, 4, 8, 0, 0, 2]);
  assert.deepEqual([today, mean], [2, 5], 'the mean of the days that took any');
  // An older reading told again takes nothing back, and what makes up for it is not counted twice.
  const again = windowsOf([40, 44, 41, 44, 46].map((pct, i) => reading(at(16, 10 + i), null, [pct, week])), 'sevenDay', at(17));
  assert.deepEqual([...usedByDay(again)], [[at(16), 6]]);
  assert.deepEqual(daysOf(frameOf(NOW), new Map()), { days: frameOf(NOW).days.map((day) => ({ day, pct: 0 })), today: 0, mean: 0 });
});

test('what the windows stood at at a time, as far as the readings tell', () => {
  const windows = windowsOf([reading(at(18, 10), [10, at(18, 15)]), reading(at(18, 11), [25, at(18, 15)]), reading(at(18, 16), [5, at(18, 21)])], 'fiveHour', at(18, 17));
  assert.deepEqual(
    [at(18, 9, 59), at(18, 10), at(18, 10, 59), at(18, 11), at(18, 14, 59), at(18, 15), at(18, 16, 30)].map((time) => shareAt(windows, time)),
    [null, 10, 10, 25, 25, null, 5],
    'nothing before a window was first read of, nor once it has started over',
  );
  assert.equal(shareAt([], NOW), null);
});

test('which windows the frame draws: read of before it ends, and lasting into it', () => {
  const frame = frameOf(NOW);
  const weeks = windowsOf([reading(at(3, 9), null, [20, at(6, 9)]), reading(at(8, 9), null, [30, at(13, 9)]), reading(at(14, 9), null, [5, at(20, 9)])], 'sevenDay', NOW);
  assert.deepEqual(weeks.filter(inFrame(frame)).map((one) => one.pct), [30, 5], 'the one that ended before the first day is not drawn');
});

test('where the weekly window is heading at the rate it has gone', () => {
  const week = { start: at(13, 9), resetsAt: at(20, 9) };
  // To the millisecond: the time it is full comes out of a division.
  const pace = (pct: number, now: number) => {
    const heading = paceOf({ ...week, pct }, now);
    return heading && 'fullAt' in heading ? { fullAt: Math.round(heading.fullAt) } : heading;
  };
  assert.deepEqual(pace(30, at(16, 9)), { atReset: 70 }, '30% in three days of seven');
  assert.deepEqual(pace(60, at(16, 9)), { fullAt: at(18, 9) }, 'full after five days at 20% a day');
  assert.deepEqual(pace(43, at(16, 9, 30)), { atReset: 100 }, 'just short of full when it starts over');
  assert.equal(pace(30, at(14, 8, 59)), null, 'too early in its first day');
  assert.deepEqual(pace(30, at(14, 9)), { fullAt: at(13, 9) + Math.round(DAY / 0.3) });
  assert.equal(paceOf({ ...week, pct: 0 }, at(16, 9)), null, 'nothing used');
  assert.equal(paceOf({ ...week, pct: 100 }, at(16, 9)), null, 'full already');
  assert.equal(paceOf({ ...week, pct: 30 }, at(20, 9)), null, 'it has started over');
});

test('the live value comes after the readings of the log, unless the log already has it', () => {
  const logged = [reading(at(18, 10), [10, at(18, 15)]), reading(at(18, 11), [25, at(18, 15)])];
  const live = reading(at(18, 12), [30, at(18, 15)]);
  assert.deepEqual(withLive(logged, [live]), [...logged, live]);
  assert.deepEqual(withLive(logged, [logged[1]!]), logged);
  assert.deepEqual(withLive([], [live]), [live], 'before the log was read');
});
