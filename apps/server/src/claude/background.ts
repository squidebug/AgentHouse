import type { BackgroundTask, ScheduledPrompt } from '@agenthouse/protocol';
import { obj, SHORT_ID, tag, text, TEXT_CHARS } from './json';
import type { HookEvent } from './status';

// What a Claude Code session leaves running or scheduled, as its hooks report
// it (2.1.325):
//  - A shell command in the background: PostToolUse(Bash) whose tool_response
//    has backgroundTaskId. A Monitor: PostToolUse(Monitor), tool_response.taskId.
//  - Stop lists what still runs in background_tasks ({ id, type, status,
//    description, command }; a monitor is listed as a shell, sub-agents as
//    subagent) and the scheduled prompts in session_crons ({ id, schedule,
//    recurring, prompt }).
//  - An end, and every line a monitor reports, comes back as a prompt: a
//    <task-notification> block naming the task (UserPromptSubmit). With a
//    <status> the task has ended; a monitor's line has <event> and no status.
//    One that arrives in the middle of a turn has no hook: the next Stop no
//    longer lists the task.
//  - CronCreate's result names the job and when it runs next. A wakeup
//    (ScheduleWakeup) has no id until Stop lists it, as a job that runs once.
//    When a job runs, the prompt is the job's own text and nothing else tells.
//  - A skill: PostToolUse(Skill) names it; typed as /name it is only a prompt.

// A command line or a prompt may be long: Claude itself lists at most this much.
const LONG_CHARS = 1000;
// Ended tasks stay listed; beyond this many the oldest go.
const MAX_TASKS = 100;
const MAX_SCHEDULES = 100;
const MAX_INVOKED = 100;
// A wakeup nobody listed (its turn was cut short) is forgotten after this.
const WAKEUP_TTL_MS = 120_000;
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const ENDED: Record<string, BackgroundTask['state']> = { completed: 'done', failed: 'failed', error: 'failed', killed: 'stopped', stopped: 'stopped', cancelled: 'stopped' };

const id = (value: unknown): string | null => (typeof value === 'string' && SHORT_ID.test(value) ? value : null);
const time = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : null);

/** A part of a notification, without the space around it. */
const field = (block: string, name: string): string | null => tag(block, name)?.trim() ?? null;

/** The name a prompt starts with when it is a slash command (`/loop 1m …` → `loop`). */
export function slashName(prompt: string): string | null {
  return prompt.match(/^\/([A-Za-z0-9][\w:.-]{0,63})(?:\s|$)/)?.[1] ?? null;
}

/** A session's background tasks, scheduled prompts and the skills it ran, built from its hook events. */
export class BackgroundTracker {
  private readonly tasks = new Map<string, BackgroundTask>();
  private readonly jobs = new Map<string, ScheduledPrompt>();
  private readonly names = new Set<string>();
  /** Wakeups set in this turn: Stop will list each as a job, with the id this lacks. */
  private wakeups: Array<{ prompt: string; nextAt: number; at: number }> = [];

  list(): BackgroundTask[] {
    return [...this.tasks.values()];
  }

  schedules(): ScheduledPrompt[] {
    return [...this.jobs.values()];
  }

  /** Skills the model started and slash commands the user typed, by name, in the order first used. */
  invoked(): string[] {
    return [...this.names];
  }

  /** One hook event; true when anything listed changed. */
  onHook(event: HookEvent, at = Date.now()): boolean {
    switch (event.hook_event_name) {
      case 'PostToolUse':
        return this.toolDone(event, at);
      case 'UserPromptSubmit':
        return this.prompted(typeof event.prompt === 'string' ? event.prompt : '', at);
      case 'Stop':
        return this.listed(event, at);
      default:
        return false;
    }
  }

  /** The session ended: what ran is stopped, and nothing is scheduled any more. */
  stopAll(at = Date.now()): boolean {
    let changed = this.jobs.size > 0;
    this.jobs.clear();
    this.wakeups = [];
    for (const task of this.tasks.values()) if (task.state === 'running') changed = this.update(task.id, { state: 'stopped', endedAt: at }) || changed;
    return changed;
  }

  private update(taskId: string, fields: Partial<BackgroundTask>): boolean {
    const task = this.tasks.get(taskId);
    if (!task) return false;
    const next = { ...task, ...fields };
    if ((Object.keys(fields) as Array<keyof BackgroundTask>).every((key) => task[key] === next[key])) return false;
    this.tasks.set(taskId, next);
    return true;
  }

  /** A task seen for the first time, or more known about one already listed. */
  private seen(taskId: string, type: string, fields: Pick<BackgroundTask, 'description' | 'command'>, at: number): boolean {
    const known = this.tasks.get(taskId);
    if (known) {
      // Stop lists a monitor as a shell: what started it knows better.
      return this.update(taskId, { ...(type !== 'shell' ? { type } : {}), description: known.description ?? fields.description, command: known.command ?? fields.command });
    }
    this.tasks.set(taskId, { id: taskId, type, ...fields, state: 'running', exitCode: null, lastEvent: null, startedAt: at, endedAt: null });
    if (this.tasks.size > MAX_TASKS) {
      const oldest = [...this.tasks.values()].find((task) => task.state !== 'running');
      if (oldest) this.tasks.delete(oldest.id);
    }
    return true;
  }

  private toolDone(event: HookEvent, at: number): boolean {
    const tool = typeof event.tool_name === 'string' ? event.tool_name : '';
    const input = obj(event.tool_input) ?? {};
    const response = obj(event.tool_response) ?? {};
    if (SHELL_TOOLS.has(tool)) {
      const taskId = id(response.backgroundTaskId);
      return taskId ? this.seen(taskId, 'shell', { description: text(input.description), command: text(input.command, LONG_CHARS) }, at) : false;
    }
    switch (tool) {
      case 'Monitor': {
        const taskId = id(response.taskId);
        const command = text(input.command, LONG_CHARS) ?? text(obj(input.ws)?.url, LONG_CHARS);
        return taskId ? this.seen(taskId, 'monitor', { description: text(input.description), command }, at) : false;
      }
      case 'TaskStop': {
        const taskId = id(response.task_id) ?? id(input.task_id);
        return taskId && this.tasks.get(taskId)?.state === 'running' ? this.update(taskId, { state: 'stopped', endedAt: at }) : false;
      }
      case 'CronCreate': {
        const jobId = id(response.id);
        const schedule = text(input.cron);
        const prompt = text(input.prompt, LONG_CHARS);
        if (!jobId || !schedule || prompt === null) return false;
        return this.job(jobId, { schedule, recurring: response.recurring !== false && input.recurring !== false, prompt, nextAt: time(response.nextFireAt) }, at);
      }
      case 'CronDelete': {
        const jobId = id(response.id) ?? id(input.id);
        return jobId ? this.jobs.delete(jobId) : false;
      }
      case 'CronList': {
        if (!Array.isArray(response.jobs)) return false;
        let changed = false;
        const listed = new Set<string>();
        for (const item of response.jobs) {
          const job = obj(item);
          const jobId = id(job?.id);
          const schedule = text(job?.cron);
          const prompt = text(job?.prompt, LONG_CHARS);
          if (!job || !jobId || !schedule || prompt === null) continue;
          listed.add(jobId);
          changed = this.job(jobId, { schedule, recurring: job.recurring !== false, prompt, nextAt: time(job.nextFireAt) }, at) || changed;
        }
        return this.only(listed) || changed;
      }
      case 'ScheduleWakeup': {
        if (response.stopped === true || input.stop === true) {
          this.wakeups = [];
          return false; // Stop's list no longer has what it cancelled
        }
        const prompt = text(input.prompt, LONG_CHARS);
        const nextAt = time(response.scheduledFor);
        if (prompt === null || nextAt === null) return false;
        // Listed already (the hooks came the other way round): the job that waits for this time.
        const waiting = [...this.jobs.values()].find((job) => !job.recurring && job.prompt === prompt && job.nextAt === null);
        if (waiting) {
          this.jobs.set(waiting.id, { ...waiting, nextAt });
          return true;
        }
        this.wakeups = [...this.wakeups.filter((w) => at - w.at < WAKEUP_TTL_MS), { prompt, nextAt, at }];
        return false;
      }
      case 'Skill': {
        const name = text(input.skill) ?? text(response.commandName);
        return name ? this.used(name) : false;
      }
      default:
        return false;
    }
  }

  private used(name: string): boolean {
    if (this.names.has(name) || this.names.size >= MAX_INVOKED) return false;
    this.names.add(name);
    return true;
  }

  /** A job named for the first time, or what is known of it brought up to date. */
  private job(jobId: string, fields: Pick<ScheduledPrompt, 'schedule' | 'recurring' | 'prompt' | 'nextAt'>, at: number): boolean {
    const known = this.jobs.get(jobId);
    if (!known) {
      if (this.jobs.size >= MAX_SCHEDULES) return false;
      this.jobs.set(jobId, { id: jobId, ...fields, lastAt: null, runs: 0, since: at });
      return true;
    }
    const next = { ...known, schedule: fields.schedule, recurring: fields.recurring, prompt: fields.prompt, nextAt: fields.nextAt ?? known.nextAt };
    if (next.schedule === known.schedule && next.recurring === known.recurring && next.prompt === known.prompt && next.nextAt === known.nextAt) return false;
    this.jobs.set(jobId, next);
    return true;
  }

  /** Jobs the CLI no longer lists are gone: deleted, run once, or expired. */
  private only(listed: Set<string>): boolean {
    let changed = false;
    for (const jobId of [...this.jobs.keys()]) if (!listed.has(jobId)) changed = this.jobs.delete(jobId) || changed;
    return changed;
  }

  private prompted(prompt: string, at: number): boolean {
    if (!prompt) return false;
    // Claude's own word about a task is a prompt that begins with this block. The same block inside
    // what someone typed or pasted (a log, an answer handed over from another session) is only text.
    const block = prompt.trimStart().startsWith('<task-notification>') ? field(prompt, 'task-notification') : null;
    if (block !== null) return this.notified(block, at);
    let changed = false;
    const command = slashName(prompt);
    if (command) changed = this.used(command);
    // A job that runs gives the session its own text, like anyone typing it would.
    const text_ = prompt.slice(0, LONG_CHARS);
    for (const job of [...this.jobs.values()]) {
      if (job.prompt !== text_) continue;
      if (job.recurring) this.jobs.set(job.id, { ...job, lastAt: at, runs: job.runs + 1, nextAt: job.nextAt !== null && job.nextAt > at + 1000 ? job.nextAt : null });
      else this.jobs.delete(job.id);
      changed = true;
      break;
    }
    return changed;
  }

  /** A task's own word: a line a monitor read (no status), or its end. Reports of sub-agents use the same block and are not tasks. */
  private notified(block: string, at: number): boolean {
    const taskId = id(field(block, 'task-id'));
    if (!taskId) return false;
    const status = field(block, 'status');
    const summary = field(block, 'summary') ?? '';
    if (!status) {
      const event = field(block, 'event');
      if (event === null) return false;
      // A monitor whose start was missed is known by its line.
      const added = !this.tasks.has(taskId) && this.seen(taskId, 'monitor', { description: text(summary.match(/^Monitor event: "(.*)"$/)?.[1]), command: null }, at);
      return this.update(taskId, { lastEvent: event.slice(0, TEXT_CHARS) }) || added;
    }
    if (!this.tasks.has(taskId)) return false;
    const code = summary.match(/exit code (-?\d+)/i);
    const exitCode = code ? Number(code[1]) : null;
    // A word of the table only: `constructor` is in every object, and is no state.
    const state = Object.hasOwn(ENDED, status) ? ENDED[status]! : 'done';
    return this.update(taskId, { state: state === 'done' && exitCode !== null && exitCode !== 0 ? 'failed' : state, exitCode, endedAt: at });
  }

  /** Stop: what still runs and what is scheduled, as the CLI lists them at the end of a turn. */
  private listed(event: HookEvent, at: number): boolean {
    let changed = false;
    if (Array.isArray(event.background_tasks)) {
      const running = new Set<string>();
      for (const item of event.background_tasks) {
        const task = obj(item);
        const taskId = id(task?.id);
        const type = text(task?.type);
        // Sub-agents are the agent tree's.
        if (!task || !taskId || !type || type === 'subagent') continue;
        if (task.status !== undefined && task.status !== 'running') continue;
        running.add(taskId);
        changed = this.seen(taskId, type, { description: text(task.description), command: text(task.command, LONG_CHARS) }, at) || changed;
      }
      // Not listed any more: it ended, and its notice came where no hook tells (in the middle of a turn).
      for (const task of [...this.tasks.values()]) {
        if (task.state === 'running' && !running.has(task.id)) changed = this.update(task.id, { state: 'done', endedAt: at }) || changed;
      }
    }
    if (Array.isArray(event.session_crons)) {
      const listed = new Set<string>();
      for (const item of event.session_crons) {
        const job = obj(item);
        const jobId = id(job?.id);
        const schedule = text(job?.schedule);
        const prompt = text(job?.prompt, LONG_CHARS);
        if (!job || !jobId || !schedule || prompt === null) continue;
        listed.add(jobId);
        const recurring = job.recurring !== false;
        // A wakeup is first named here: the one set for this prompt says when.
        const wakeup = !recurring && !this.jobs.has(jobId) ? this.wakeups.find((w) => w.prompt === prompt) : undefined;
        if (wakeup) this.wakeups = this.wakeups.filter((w) => w !== wakeup);
        changed = this.job(jobId, { schedule, recurring, prompt, nextAt: wakeup?.nextAt ?? null }, at) || changed;
      }
      changed = this.only(listed) || changed;
    }
    return changed;
  }
}
