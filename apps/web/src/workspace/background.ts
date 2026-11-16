// How a session's background tasks and scheduled prompts show in the tree,
// kept free of React so it can be tested directly.
import { isTaskRunning, type BackgroundTask, type ScheduledPrompt } from '@agenthouse/protocol';
import { t } from '../strings';

/** Ended tasks beyond this many are folded until the user opens them. */
export const SHOWN_ENDED = 3;

/**
 * The task rows under a session, in the order they started: those running and
 * the latest ended ones. Older ended ones fold away unless `all`.
 */
export function taskRows(tasks: BackgroundTask[], all: boolean): { rows: BackgroundTask[]; folded: number } {
  const ended = tasks.filter((task) => !isTaskRunning(task));
  if (all || ended.length <= SHOWN_ENDED) return { rows: tasks, folded: 0 };
  const hidden = new Set(ended.slice(0, -SHOWN_ENDED));
  return { rows: tasks.filter((task) => !hidden.has(task)), folded: hidden.size };
}

/** A task's row title: what it is for, else its command. */
export const taskTitle = (task: BackgroundTask): string => task.description ?? task.command ?? task.id;

/** 셸, 모니터; any other kind as the CLI names it. */
export const taskType = (task: Pick<BackgroundTask, 'type'>): string => t.taskType[task.type] ?? task.type;

/** 실행 중, 완료, 실패 · 종료 코드 2, 중단됨. */
export function taskStatusText(task: Pick<BackgroundTask, 'state' | 'exitCode'>): string {
  const base = t.taskState[task.state];
  return task.exitCode !== null && task.exitCode !== 0 ? `${base} · ${t.exitCode} ${task.exitCode}` : base;
}

/** What a task's row adds after its kind: how it went wrong, or the latest line a monitor read. */
export function taskNote(task: BackgroundTask): string | null {
  if (task.state === 'failed' || task.state === 'stopped') return taskStatusText(task);
  return task.lastEvent;
}

/** How long it has run, or ran. */
export const taskElapsedMs = (task: Pick<BackgroundTask, 'startedAt' | 'endedAt'>, now: number): number => Math.max(0, (task.endedAt ?? now) - task.startedAt);

const two = (n: number | string) => String(n).padStart(2, '0');

/** 15:04 for a time today; 11월 17일 15:04 for another day. */
export function clock(at: number, now: number): string {
  const date = new Date(at);
  const time = `${two(date.getHours())}:${two(date.getMinutes())}`;
  return date.toDateString() === new Date(now).toDateString() ? time : `${t.monthDay(date.getMonth() + 1, date.getDate())} ${time}`;
}

/**
 * A schedule in words where it is one of the common shapes (5분마다, 매시 30분,
 * 2시간마다, 매일 09:00), and the time for a prompt that runs once (15:14 한 번);
 * any other as the cron expression it is.
 */
export function scheduleText(job: Pick<ScheduledPrompt, 'schedule' | 'recurring' | 'nextAt'>, now: number): string {
  const fields = job.schedule.trim().split(/\s+/);
  const [minute = '', hour = '', ...days] = fields;
  const number = (field: string) => (/^\d{1,2}$/.test(field) ? Number(field) : null);
  const step = (field: string) => (field === '*' ? 1 : Number(field.match(/^\*\/(\d{1,3})$/)?.[1] ?? NaN));
  const at = number(minute) !== null && number(hour) !== null ? `${two(hour)}:${two(minute)}` : null;
  if (!job.recurring) return job.nextAt !== null ? t.onceAt(clock(job.nextAt, now)) : at ? t.onceAt(at) : job.schedule;
  if (fields.length !== 5 || days.some((field) => field !== '*')) return job.schedule;
  if (hour === '*' && step(minute) >= 1) return t.everyMinutes(step(minute));
  if (hour === '*' && number(minute) !== null) return t.hourlyAt(number(minute)!);
  if (number(minute) !== null && step(hour) > 1) return t.everyHours(step(hour));
  return at ? t.dailyAt(at) : job.schedule;
}

/** A scheduled prompt's row title: its first line. */
export const scheduleTitle = (job: Pick<ScheduledPrompt, 'prompt'>): string => job.prompt.trim().split(/\r?\n/, 1)[0] ?? '';
