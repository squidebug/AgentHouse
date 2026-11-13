import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import path from 'node:path';
import { isAsking, isHeld, type DelegationInfo, type SessionInfo } from '@agenthouse/protocol';
import { claudeConfigDir } from '../claude/settings';
import { isClaudeTranscript } from '../claude/status';
import type { SessionManager } from './manager';

const FILE_VERSION = 1;
// The newest this many are kept; older ones are history nobody shows.
const MAX_KEPT = 200;
const SUMMARY_CHARS = 200;
// What is handed to the parent at most; a longer answer is cut.
const DELIVER_CHARS = 100_000;
// An answer is looked for in the newest part of the delegate's transcript only.
const TAIL_BYTES = 8 * 1024 * 1024;
// The transcript is written a moment before or after the turn ends: look again, for this long.
const ANSWER_WAIT_MS = 3000;
const RETRY_MS = 1000;
// A background agent's report starts a turn at once; if none came by then (an agent the tree
// placed at the top by mistake reports to its parent agent instead), the work is settled anyway.
const REPORT_WAIT_MS = 60_000;
// A transcript line is 64 MB at most (web/conversations.ts); an answer's range is no longer.
const MAX_ANSWER_BYTES = 64 * 1024 * 1024;

export const delegationsFile = (stateDir: string) => path.join(stateDir, 'delegations.json');

export class DelegationError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'INVALID_REQUEST' | 'BUSY',
  ) {
    super(message);
  }
}

/** Where a delegate's answer is: one line of its transcript. */
interface AnswerLine {
  path: string;
  start: number;
  end: number;
}

interface Task {
  id: string;
  parentId: string;
  childId: string;
  sentAt: number;
  status: DelegationInfo['status'];
  endedAt: number | null;
  /** The delegate's transcript and its size when the work was sent: the answer comes after. */
  transcript: string | null;
  from: number;
  answer: AnswerLine | null;
  delivery: DelegationInfo['delivery'];
  deliveredAt: number | null;
  /** The browser's words in front of the answer when it is handed over. */
  header: string | null;
  /** The work went into the delegate's input but its Enter was held back (a dialog opened): only Enter is left. */
  enterPending?: boolean;
  /** The same for the answer in the parent's input. */
  pasted?: boolean;
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null);

/** The text blocks of an assistant record that holds an answer (not an API error), joined. */
function answerText(record: unknown): string | null {
  const r = obj(record);
  if (r?.type !== 'assistant' || r.isApiErrorMessage === true) return null;
  const content = obj(r.message)?.content;
  if (!Array.isArray(content)) return null;
  const text = content
    .map((block) => (obj(block)?.type === 'text' ? String(obj(block)!.text ?? '') : ''))
    .join('\n')
    .trim();
  return text || null;
}

/** The last answer written to a transcript from a byte offset on. */
async function findAnswer(file: string, from: number): Promise<{ line: AnswerLine; text: string } | null> {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(from, size - TAIL_BYTES);
    if (start >= size) return null;
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let found: { line: AnswerLine; text: string } | null = null;
    let at = 0;
    if (start > from) {
      // A read that starts mid-file may start mid-line: that piece is not a record.
      const newline = buffer.indexOf(10);
      if (newline === -1) return null;
      at = newline + 1;
    }
    while (at < buffer.length) {
      let end = buffer.indexOf(10, at);
      if (end === -1) end = buffer.length;
      const line = buffer.toString('utf8', at, end);
      if (line.includes('"assistant"') && line.includes('"text"')) {
        try {
          const text = answerText(JSON.parse(line));
          if (text) found = { line: { path: file, start: start + at, end: start + end }, text };
        } catch {
          // a line still being written
        }
      }
      at = end + 1;
    }
    return found;
  } finally {
    await handle.close();
  }
}

async function readAnswer(line: AnswerLine): Promise<string | null> {
  const handle = await open(line.path, 'r');
  try {
    const buffer = Buffer.alloc(Math.max(0, line.end - line.start));
    await handle.read(buffer, 0, buffer.length, line.start);
    return answerText(JSON.parse(buffer.toString('utf8')));
  } catch {
    return null;
  } finally {
    await handle.close();
  }
}

const summaryOf = (text: string) => {
  const first = text.trim().split(/\r?\n/, 1)[0] ?? '';
  return first.length > SUMMARY_CHARS ? `${first.slice(0, SUMMARY_CHARS)}…` : first;
};

function isTask(value: unknown): value is Task {
  const t = value as Partial<Task> | null;
  return typeof t?.id === 'string' && typeof t.parentId === 'string' && typeof t.childId === 'string' && typeof t.sentAt === 'number' && typeof t.status === 'string';
}

/**
 * A task as the file has it. Its paths are opened later, so they are held to
 * what a hook's path is held to: one of Claude's own transcripts (never a UNC
 * path, which would send the user's credentials to that host), and a range
 * no longer than a transcript line.
 */
function checked(task: Task): Task {
  const ours = (file: unknown): file is string => typeof file === 'string' && isClaudeTranscript(file, claudeConfigDir());
  const range = task.answer;
  const answer = range && ours(range.path) && Number.isInteger(range.start) && Number.isInteger(range.end) && range.start >= 0 && range.end >= range.start && range.end - range.start <= MAX_ANSWER_BYTES ? range : null;
  return { ...task, transcript: ours(task.transcript) ? task.transcript : null, from: Number.isFinite(task.from) && task.from >= 0 ? task.from : 0, answer };
}

/**
 * A session ready for a message: idle, or a CLI that reports no turns (nothing
 * tells it is busy). Never a Claude session that has not started: its folder
 * trust question may be up, and the host refuses it anyway.
 */
const ready = (session: SessionInfo) =>
  session.state === 'running' && (session.status.value === 'idle' || (session.status.value === 'unobserved' && session.vendor !== 'claude'));

const refusal = (reason: string | undefined) =>
  reason === 'exited' ? '끝난 세션입니다.' : isAsking(reason) ? '승인이나 답을 기다리는 세션입니다.' : isHeld(reason) ? '아직 시작 중인 세션입니다.' : '보내지 못했습니다.';

/**
 * Work handed from a session to the session delegated under it, followed
 * until the delegate is done and, when the user says so, its answer handed
 * back. Kept by the web server in delegations.json; 'change' fires when
 * anything a browser shows changes.
 */
export class Delegations extends EventEmitter {
  private readonly tasks = new Map<string, Task>();
  private readonly summaries = new Map<string, string>();
  private readonly sending = new Set<string>();
  /** When the answer of a settled-looking task was first looked for. */
  private readonly looking = new Map<string, number>();
  /** Tasks with a look-again set for a report that has not come. */
  private readonly waitingReport = new Set<string>();
  private checking: Promise<void> | null = null;
  private again = false;
  private closed = false;
  private readonly onChange = () => this.check();

  constructor(
    private readonly manager: SessionManager,
    private readonly file: string,
  ) {
    super();
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown; tasks?: unknown };
      if (data.version === FILE_VERSION && Array.isArray(data.tasks)) for (const task of data.tasks) if (isTask(task)) this.tasks.set(task.id, checked(task));
    } catch {
      // none yet, or unreadable: start over
    }
    manager.on('change', this.onChange);
    // Summaries are read from the transcripts, not kept; then whatever ended meanwhile is settled.
    void Promise.all([...this.tasks.values()].map((task) => this.summarize(task))).then(() => {
      this.emit('change');
      this.check();
    });
  }

  list(): DelegationInfo[] {
    return [...this.tasks.values()].map((t) => ({
      id: t.id,
      parentId: t.parentId,
      childId: t.childId,
      sentAt: t.sentAt,
      status: t.status,
      endedAt: t.endedAt,
      summary: this.summaries.get(t.id) ?? null,
      delivery: t.delivery,
      deliveredAt: t.deliveredAt,
    }));
  }

  /** Sends text from a session to the session delegated under it, as the composer would, and follows the work. */
  async delegate(parentId: string, childId: string, text: string): Promise<DelegationInfo> {
    const parent = this.manager.get(parentId);
    const child = this.manager.get(childId);
    if (!parent || !child) throw new DelegationError('세션을 찾을 수 없습니다.', 'NOT_FOUND');
    if (!this.manager.links().some((l) => l.childId === childId && l.parentId === parentId && l.kind === 'delegate')) {
      throw new DelegationError('위임으로 연결된 세션이 아닙니다.', 'INVALID_REQUEST');
    }
    if (child.state !== 'running') throw new DelegationError('끝난 세션입니다.', 'INVALID_REQUEST');
    if (isAsking(child.status.value)) throw new DelegationError(refusal(child.status.value), 'BUSY');
    // A delegate in the middle of a turn would take the work after it, and the end of the turn
    // already under way would look like the end of the work.
    if (child.status.value === 'working') throw new DelegationError('작업 중인 세션입니다.', 'BUSY');
    const transcript = [...child.transcripts].reverse().find((t) => isClaudeTranscript(t.path, claudeConfigDir()))?.path ?? null;
    const from = transcript ? await stat(transcript).then((s) => s.size).catch(() => 0) : 0;
    const sentAt = Date.now();
    const result = await this.manager.compose(childId, { text });
    if (!result.sent) throw new DelegationError(refusal(result.reason), 'BUSY');
    // In its input but not submitted (a dialog opened): the work is there, and only Enter is left to press.
    const task: Task = {
      id: randomUUID(),
      parentId,
      childId,
      sentAt,
      status: 'running',
      endedAt: null,
      transcript,
      from,
      answer: null,
      delivery: 'none',
      deliveredAt: null,
      header: null,
      ...(result.submitted ? {} : { enterPending: true }),
    };
    this.tasks.set(task.id, task);
    for (const old of [...this.tasks.values()].sort((a, b) => b.sentAt - a.sentAt).slice(MAX_KEPT)) this.tasks.delete(old.id);
    this.changed();
    this.check();
    return this.info(task.id);
  }

  /** Hands the delegate's answer to the parent now, or once the parent is idle. */
  async deliver(id: string, header: string): Promise<DelegationInfo> {
    const task = this.tasks.get(id);
    if (!task) throw new DelegationError('위임을 찾을 수 없습니다.', 'NOT_FOUND');
    if (!task.answer) throw new DelegationError('전달할 결과가 없습니다.', 'INVALID_REQUEST');
    if (task.delivery === 'queued' || task.delivery === 'sent') return this.info(id);
    const parent = this.manager.get(task.parentId);
    if (!parent || parent.state !== 'running') throw new DelegationError('끝난 세션입니다.', 'INVALID_REQUEST');
    task.header = header;
    task.delivery = 'queued';
    this.changed();
    if (ready(parent)) await this.send(task);
    return this.info(id);
  }

  close(): void {
    this.closed = true;
    this.manager.off('change', this.onChange);
  }

  private info(id: string): DelegationInfo {
    return this.list().find((d) => d.id === id)!;
  }

  private changed(): void {
    this.save();
    this.emit('change');
  }

  private async summarize(task: Task): Promise<void> {
    if (!task.answer || this.summaries.has(task.id)) return;
    const text = await readAnswer(task.answer).catch(() => null);
    if (text) this.summaries.set(task.id, summaryOf(text));
  }

  /** Follows the work: a delegate done, a queued answer whose parent is free. One pass at a time. */
  private check(): void {
    if (this.closed) return;
    if (this.checking) {
      this.again = true;
      return;
    }
    this.checking = this.pass()
      .catch(() => {})
      .finally(() => {
        this.checking = null;
        if (!this.again) return;
        this.again = false;
        this.check();
      });
  }

  private async pass(): Promise<void> {
    let changed = false;
    for (const task of this.tasks.values()) {
      const parent = this.manager.get(task.parentId);
      const child = this.manager.get(task.childId);
      if (!parent || !child) {
        // Removed from the list: the work goes with it.
        this.tasks.delete(task.id);
        changed = true;
        continue;
      }
      if (task.status === 'running' && task.enterPending) {
        if (child.state !== 'running') changed = (await this.settle(task, child)) || changed;
        else if (ready(child)) changed = (await this.submit(task)) || changed;
        continue;
      }
      if (task.status === 'running') changed = (await this.settle(task, child)) || changed;
      if (task.delivery === 'queued' && !this.sending.has(task.id)) {
        if (parent.state !== 'running') {
          task.delivery = 'failed';
          changed = true;
        } else if (ready(parent)) {
          await this.send(task);
        }
      }
    }
    if (changed) this.changed();
  }

  /**
   * The delegate is done once idle after the work was sent, with no sub-agent
   * running and no report still to come. A background agent the main
   * conversation started reports back in a turn of its own; between the
   * agent's end and that turn, the delegate looks idle with nothing running
   * (review 2, M4-6). So it must have been idle again since the last such
   * agent ended: that is the turn with the answer.
   */
  private async settle(task: Task, child: SessionInfo): Promise<boolean> {
    if (child.state !== 'running') {
      Object.assign(task, { status: 'failed', endedAt: child.exit?.at ?? Date.now() });
      return true;
    }
    const idle = child.status.value === 'idle' && child.status.at > task.sentAt && !child.agents.some((a) => a.state === 'running');
    if (!idle) return false;
    const lastReport = child.agents.reduce((latest, a) => (a.parentId === null && a.endedAt !== null && a.endedAt > task.sentAt ? Math.max(latest, a.endedAt) : latest), 0);
    if (child.status.at <= lastReport && Date.now() - lastReport < REPORT_WAIT_MS) {
      if (!this.waitingReport.has(task.id)) {
        this.waitingReport.add(task.id);
        setTimeout(() => {
          this.waitingReport.delete(task.id);
          this.check();
        }, lastReport + REPORT_WAIT_MS - Date.now()).unref();
      }
      return false;
    }
    const found = task.transcript ? await findAnswer(task.transcript, task.from).catch(() => null) : null;
    const since = this.looking.get(task.id) ?? Date.now();
    if (!found && Date.now() - since < ANSWER_WAIT_MS) {
      this.looking.set(task.id, since);
      setTimeout(() => this.check(), RETRY_MS).unref();
      return false;
    }
    this.looking.delete(task.id);
    task.status = child.status.error ? 'failed' : child.status.reason === 'interrupted' ? 'interrupted' : 'done';
    task.endedAt = child.status.at;
    if (found) {
      task.answer = found.line;
      this.summaries.set(task.id, summaryOf(found.text));
    }
    return true;
  }

  /** Presses the Enter that was held back on the delegate: the work already in its input goes out. */
  private async submit(task: Task): Promise<boolean> {
    if (this.sending.has(task.id)) return false;
    this.sending.add(task.id);
    try {
      // Nobody may be watching the delegate: the CLI is asked too before Enter is pressed.
      const result = await this.manager.compose(task.childId, { text: '', enterOnly: true, verify: true });
      if (!result.submitted) return false;
      delete task.enterPending;
      task.sentAt = Date.now();
      return true;
    } catch {
      // the host is away: tried again on the next change
      return false;
    } finally {
      this.sending.delete(task.id);
    }
  }

  private async send(task: Task): Promise<void> {
    if (this.sending.has(task.id) || !task.answer) return;
    this.sending.add(task.id);
    try {
      const text = await readAnswer(task.answer);
      if (!text) {
        task.delivery = 'failed';
      } else {
        const body = text.length > DELIVER_CHARS ? text.slice(0, DELIVER_CHARS) : text;
        // Nobody may be watching the parent: the CLI is asked too. An answer already in its input only needs its Enter.
        const request = task.pasted ? { text: '', enterOnly: true, verify: true } : { text: `${task.header ?? ''}\n${body}`.trim(), verify: true };
        const result = await this.manager.compose(task.parentId, request);
        if (result.submitted) {
          task.delivery = 'sent';
          task.deliveredAt = Date.now();
          delete task.pasted;
        } else if (result.reason === 'exited') {
          task.delivery = 'failed';
        } else if (result.sent) {
          task.pasted = true;
        }
        // Otherwise a dialog opened or it got busy: still queued, tried again when it is idle.
      }
    } catch {
      // the host is away: still queued
    } finally {
      this.sending.delete(task.id);
    }
    this.changed();
  }

  // Replaced atomically: a reader never sees half a file.
  private save(): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(temp, JSON.stringify({ version: FILE_VERSION, tasks: [...this.tasks.values()] }), { mode: 0o600 });
      renameSync(temp, this.file);
    } catch {
      // kept in memory; the next change tries again
    }
  }
}
