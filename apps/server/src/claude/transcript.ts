import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ConversationEntry, ConversationTurn, EntryDetail, LatestWords, ToolState } from '@agenthouse/protocol';
import { AGENT_TOOLS } from './agents';
import { obj, tag, type Json } from './json';
import { isInterruptText } from './status';

// Claude Code's transcript (<config>/projects/<cwd>/<session>.jsonl), as of
// 2.1.3xx: one JSON record per line. What the conversation view reads:
//  - user: a prompt (string or text/image blocks), tool results (tool_result
//    blocks; toolUseResult holds the structured result), interrupt markers,
//    slash commands (<command-name>…), the summary after a compaction
//    (isCompactSummary), a background agent's report (origin.kind
//    task-notification, a <task-notification> block). isMeta records are the
//    CLI's own notes: skipped, except such a report.
//  - Agent tool: its result says async_launched when the agent runs in the
//    background (the default in 2.1.322); the agent is done when it reports.
//    A sub-agent's own transcript (<session>/subagents/agent-<id>.jsonl) has
//    the same records.
//  - assistant: one content block per record (text, thinking, tool_use). The
//    records of one API response share message.id and carry the same usage.
//  - system: turn_duration ends a turn, compact_boundary marks a compaction,
//    local_command holds a slash command or its output.
// Everything else (attachments, file history, API request copies, titles) is
// skipped. Unknown records change nothing.

/** Claude's folder for a project's transcripts and memory: every character of its path that is no letter or digit becomes a dash. */
export const projectDir = (configDir: string, cwd: string): string => path.join(configDir, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));

/** Where the transcript of a conversation is, by the name of its project's folder. */
export const transcriptFile = (configDir: string, cwd: string, sessionId: string): string => path.join(projectDir(configDir, cwd), `${sessionId}.jsonl`);

// A config folder has a project folder for every folder Claude was ever started in.
const SEARCH_FOLDERS = 1000;

/** A conversation's transcript in whichever project folder has it, for one that is not where its folder's name says; null when none does. */
export async function findTranscript(configDir: string, sessionId: string): Promise<string | null> {
  const projects = path.join(configDir, 'projects');
  let folders: string[];
  try {
    folders = await readdir(projects);
  } catch {
    return null;
  }
  for (const folder of folders.slice(0, SEARCH_FOLDERS)) {
    const file = path.join(projects, folder, `${sessionId}.jsonl`);
    const there = await stat(file).then(
      (info) => info.isFile(),
      () => false,
    );
    if (there) return file;
  }
  return null;
}

const PROMPT_CHARS = 20_000;
const TEXT_CHARS = 100_000;
const SUMMARY_CHARS = 300;
const NOTICE_CHARS = 500;
const DETAIL_CHARS = 200_000;
const DETAIL_ITEMS = 500;
const DETAIL_DEPTH = 6;
// Each line of a diff is an element on the page: 20,000 of them held it up for two seconds.
const PATCH_LINES = 2000;

/** Byte range of one JSONL line in its transcript file. */
export type LineRange = [start: number, end: number];

/** Where an entry's full content is, to load it when the user opens the entry. */
export interface EntrySource {
  segment: number;
  lines: LineRange[];
}

const str = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function cut(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

const firstLine = (text: string) => text.split(/\r?\n/, 1)[0] ?? '';
const oneLine = (text: string, max = SUMMARY_CHARS) => {
  const trimmed = text.trim();
  const line = firstLine(trimmed);
  if (line.length > max) return `${line.slice(0, max)}…`;
  return line.length < trimmed.length ? `${line} …` : line;
};

// Terminal escapes in a command's printed output.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** What a background agent's report says (a `<task-notification>` block in a user record). */
interface TaskReport {
  agentId: string | null;
  toolUseId: string | null;
  state: ToolState;
  summary: string | null;
  result: string | null;
  tokens: number | null;
  durationMs: number | null;
}

const TASK_STATES: Record<string, ToolState> = { completed: 'done', failed: 'error', error: 'error', killed: 'interrupted', stopped: 'interrupted', cancelled: 'interrupted' };

function taskReport(content: string): TaskReport | null {
  const block = tag(content, 'task-notification');
  if (block === null) return null;
  const field = (name: string) => {
    const value = tag(block, name)?.trim();
    return value ? value : null;
  };
  const count = (name: string) => {
    const value = Number(field(name));
    return Number.isFinite(value) && value > 0 ? value : null;
  };
  const status = field('status');
  return {
    agentId: field('task-id'),
    toolUseId: field('tool-use-id'),
    state: (status && TASK_STATES[status]) || 'done',
    summary: field('summary'),
    result: field('result'),
    tokens: count('subagent_tokens'),
    durationMs: count('duration_ms'),
  };
}

/** A file path relative to the session's folder, when it is inside it. */
function shortPath(file: string, cwd: string | null): string {
  if (!cwd) return file;
  const norm = (p: string) => p.replace(/\\/g, '/');
  const base = norm(cwd).replace(/\/$/, '');
  const target = norm(file);
  const inside = process.platform === 'win32' ? target.toLowerCase().startsWith(`${base.toLowerCase()}/`) : target.startsWith(`${base}/`);
  return inside ? target.slice(base.length + 1) : file;
}

/** The one line shown for a tool call: its command, file, pattern or address. */
export function toolSummary(name: string, input: Json, cwd: string | null): string {
  const field = (key: string) => str(input[key]);
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return oneLine(field('command') ?? field('description') ?? '');
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      const file = field('file_path') ?? field('notebook_path');
      return file ? shortPath(file, cwd) : '';
    }
    case 'Grep':
    case 'Glob': {
      const where = field('path');
      return oneLine([field('pattern'), where ? shortPath(where, cwd) : null].filter(Boolean).join('  '));
    }
    case 'WebFetch':
      return oneLine(field('url') ?? '');
    case 'WebSearch':
      return oneLine(field('query') ?? '');
    case 'Skill':
      return oneLine(field('skill') ?? '');
    case 'AskUserQuestion': {
      const first = obj((input.questions as unknown[] | undefined)?.[0]);
      return oneLine(str(first?.question) ?? '');
    }
    default: {
      const text = Object.values(input).find((value): value is string => typeof value === 'string' && value.trim() !== '');
      return text ? oneLine(text) : '';
    }
  }
}

/** What a record's content says as text: the string it is, or its text blocks joined, an image as `[image]`. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      const b = obj(block);
      if (b?.type === 'text') return str(b.text) ?? '';
      if (b?.type === 'image') return '[image]';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

/**
 * Builds the conversation from transcript records, in file order, one
 * transcript (segment) after another. It keeps what changed since the last
 * takeChanges(), so a growing transcript is sent as small updates.
 */
export class ConversationBuilder {
  private readonly turnList: ConversationTurn[] = [];
  private readonly entries = new Map<string, ConversationEntry>();
  /** Where each entry's full content is, for details. */
  readonly sources = new Map<string, EntrySource>();
  private readonly counted = new Set<string>();
  private readonly turnEntries: number[] = [];
  private readonly changedTurns = new Set<number>();
  private readonly changedEntries = new Set<string>();
  private segment = 0;
  private lastCommand: string | null = null;
  private lastCompact: string | null = null;
  /** The Agent entry of each sub-agent, by its agent id, for its report. */
  private readonly agentEntries = new Map<string, string>();
  private serial = 0;

  /** Records from here on are from the next transcript (Claude Code started a new one: /clear, /resume). */
  startSegment(segment: number, at: number | null): void {
    this.segment = segment;
    if (segment === 0) return;
    this.newTurn(at);
    this.put({ kind: 'notice', id: this.key(`cleared`), turn: this.turnIndex(), at, notice: 'cleared', text: '' });
  }

  get turns(): readonly ConversationTurn[] {
    return this.turnList;
  }

  entry(id: string): ConversationEntry | undefined {
    return this.entries.get(id);
  }

  /** Everything so far; what changed stays pending for takeChanges(). */
  snapshot(): { turns: ConversationTurn[]; entries: ConversationEntry[] } {
    return { turns: [...this.turnList], entries: [...this.entries.values()] };
  }

  takeChanges(): { turns: ConversationTurn[]; entries: ConversationEntry[] } | null {
    if (!this.changedTurns.size && !this.changedEntries.size) return null;
    const turns = [...this.changedTurns].sort((a, b) => a - b).map((i) => this.turnList[i]!);
    const entries = [...this.changedEntries].map((id) => this.entries.get(id)!).filter(Boolean);
    this.changedTurns.clear();
    this.changedEntries.clear();
    return { turns, entries };
  }

  private key(id: string): string {
    return `s${this.segment}-${id}`;
  }

  private turnIndex(): number {
    if (!this.turnList.length) this.newTurn(null);
    return this.turnList.length - 1;
  }

  private newTurn(at: number | null): void {
    const last = this.turnList.length - 1;
    // A turn with nothing in it yet (e.g. right after /clear) takes the prompt.
    if (last >= 0 && this.turnEntries[last] === 0 && this.turnList[last]!.segment === this.segment) return;
    this.turnList.push({
      index: this.turnList.length,
      segment: this.segment,
      startedAt: at,
      endedAt: at,
      model: null,
      effort: null,
      usage: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 },
      durationMs: null,
      interrupted: false,
    });
    this.turnEntries.push(0);
    this.changedTurns.add(this.turnList.length - 1);
  }

  private touchTurn(update: (turn: ConversationTurn) => ConversationTurn): void {
    const index = this.turnIndex();
    this.turnList[index] = update(this.turnList[index]!);
    this.changedTurns.add(index);
  }

  private put(entry: ConversationEntry, source?: EntrySource): void {
    if (!this.entries.has(entry.id)) this.turnEntries[entry.turn] = (this.turnEntries[entry.turn] ?? 0) + 1;
    this.entries.set(entry.id, entry);
    this.changedEntries.add(entry.id);
    if (source) this.sources.set(entry.id, source);
  }

  private source(...lines: LineRange[]): EntrySource {
    return { segment: this.segment, lines };
  }

  /** One transcript record and where its line is. */
  add(record: unknown, line: LineRange): void {
    const r = obj(record);
    if (!r) return;
    const at = Date.parse(str(r.timestamp) ?? '') || null;
    if (r.type === 'user') this.user(r, at, line);
    else if (r.type === 'assistant') this.assistant(r, at, line);
    else if (r.type === 'system') this.system(r, at, line);
    else return;
    if (at && this.turnList.length) {
      this.touchTurn((turn) => ({ ...turn, startedAt: turn.startedAt ?? at, endedAt: Math.max(turn.endedAt ?? at, at) }));
    }
  }

  private interrupted(at: number | null): void {
    this.touchTurn((turn) => ({ ...turn, interrupted: true }));
    this.put({ kind: 'notice', id: this.key(`interrupt-${(this.serial += 1)}`), turn: this.turnIndex(), at, notice: 'interrupted', text: '' });
  }

  /**
   * A slash command or its output: a record that is nothing but Claude's own
   * tags, so it begins with one. A prompt that only mentions such a tag (asking
   * about a transcript, say) is a prompt.
   */
  private command(text: string, at: number | null, line: LineRange): boolean {
    const start = text.trimStart();
    const name = start.startsWith('<command-name>') || start.startsWith('<command-message>') ? tag(text, 'command-name') : null;
    if (name !== null) {
      const id = this.key(`command-${(this.serial += 1)}`);
      this.put({ kind: 'command', id, turn: this.turnIndex(), at, name: name.trim(), args: (tag(text, 'command-args') ?? '').trim(), output: '' }, this.source(line));
      this.lastCommand = id;
      return true;
    }
    if (!start.startsWith('<local-command-stdout>') && !start.startsWith('<local-command-stderr>')) return false;
    const output = tag(text, 'local-command-stdout') ?? tag(text, 'local-command-stderr');
    if (output === null) return false;
    const command = this.lastCommand ? this.entries.get(this.lastCommand) : undefined;
    if (command?.kind === 'command') this.put({ ...command, output: cut(output.replace(ANSI, '').trim(), NOTICE_CHARS * 4).text });
    return true;
  }

  private user(r: Json, at: number | null, line: LineRange): void {
    const message = obj(r.message);
    const content = message?.content;
    if (obj(r.origin)?.kind === 'task-notification') {
      const report = taskReport(resultText(content));
      if (report) return this.report(report, r, at, line);
    }
    // The CLI's own notes are skipped, but not a prompt it gave itself on a schedule: that is what the turn answers.
    if (r.isMeta === true && typeof r.scheduledTaskId !== 'string') return;
    if (r.isCompactSummary === true) {
      const notice = this.lastCompact ? this.entries.get(this.lastCompact) : undefined;
      if (notice) this.sources.set(notice.id, this.source(line));
      return;
    }
    if (typeof content === 'string') {
      if (isInterruptText(content)) return this.interrupted(at);
      if (content.startsWith('<local-command-caveat>') || this.command(content, at, line)) return;
      this.prompt(r, content, 0, at, line);
      return;
    }
    if (!Array.isArray(content)) return;
    const texts: string[] = [];
    let images = 0;
    let results = false;
    for (const item of content) {
      const block = obj(item);
      if (block?.type === 'tool_result') {
        results = true;
        this.toolResult(r, block, line);
      } else if (block?.type === 'text' && typeof block.text === 'string') {
        if (isInterruptText(block.text)) this.interrupted(at);
        else texts.push(block.text);
      } else if (block?.type === 'image') images += 1;
    }
    // Text next to tool results is the CLI's, not something the user typed.
    const text = texts.join('\n');
    if (results || (text && this.command(text, at, line))) return;
    if (text || images) this.prompt(r, text, images, at, line);
  }

  private prompt(r: Json, text: string, images: number, at: number | null, line: LineRange): void {
    const origin = obj(r.origin);
    const from = origin?.kind === 'peer' ? (str(origin.name) ?? str(origin.from) ?? 'agent') : null;
    this.newTurn(at);
    const shown = cut(text, PROMPT_CHARS);
    const scheduled = typeof r.scheduledTaskId === 'string' ? { scheduled: true as const } : {};
    this.put({ kind: 'prompt', id: this.key(str(r.uuid) ?? `prompt-${(this.serial += 1)}`), turn: this.turnIndex(), at, text: shown.text, images, from, truncated: shown.truncated, ...scheduled }, this.source(line));
  }

  /** A background agent reported back: its block is settled, and the report starts the turn that answers it. */
  private report(report: TaskReport, r: Json, at: number | null, line: LineRange): void {
    const byUse = report.toolUseId ? this.key(report.toolUseId) : null;
    const entryId = byUse && this.entries.has(byUse) ? byUse : report.agentId ? this.agentEntries.get(report.agentId) : undefined;
    const agent = entryId ? this.entries.get(entryId) : undefined;
    if (agent?.kind === 'agent') {
      this.put({ ...agent, state: report.state, agentId: agent.agentId ?? report.agentId });
      const source = this.sources.get(agent.id);
      if (source) this.sources.set(agent.id, { ...source, lines: [...source.lines.slice(0, 2), line] });
    }
    this.newTurn(at);
    const description = agent?.kind === 'agent' ? agent.description : (report.summary ?? '');
    this.put(
      { kind: 'task', id: this.key(str(r.uuid) ?? `task-${(this.serial += 1)}`), turn: this.turnIndex(), at, agentId: report.agentId, description, state: report.state, tokens: report.tokens, durationMs: report.durationMs },
      this.source(line),
    );
  }

  private toolResult(r: Json, block: Json, line: LineRange): void {
    const useId = str(block.tool_use_id);
    const entry = useId ? this.entries.get(this.key(useId)) : undefined;
    if (!entry || (entry.kind !== 'tool' && entry.kind !== 'agent')) return;
    const result = obj(r.toolUseResult);
    let state: ToolState = 'done';
    if (typeof r.toolDenialKind === 'string') state = 'denied';
    else if (result?.interrupted === true) state = 'interrupted';
    else if (block.is_error === true) state = 'error';
    // Started in the background: it runs until it reports back.
    else if (entry.kind === 'agent' && (result?.status === 'async_launched' || result?.isAsync === true)) state = 'running';
    const source = this.sources.get(entry.id);
    this.sources.set(entry.id, { segment: source?.segment ?? this.segment, lines: [...(source?.lines.slice(0, 1) ?? []), line] });
    if (entry.kind === 'agent') {
      const agentId = str(result?.agentId) ?? entry.agentId;
      if (agentId) this.agentEntries.set(agentId, entry.id);
      this.put({ ...entry, state, agentId });
    }
    else this.put({ ...entry, state });
  }

  private assistant(r: Json, at: number | null, line: LineRange): void {
    const message = obj(r.message);
    if (!message) return;
    const model = str(message.model);
    const id = str(message.id);
    const usage = obj(message.usage);
    if (id && usage && !this.counted.has(id)) {
      this.counted.add(id);
      this.touchTurn((turn) => ({
        ...turn,
        usage: {
          input: turn.usage.input + num(usage.input_tokens),
          cacheRead: turn.usage.cacheRead + num(usage.cache_read_input_tokens),
          cacheWrite: turn.usage.cacheWrite + num(usage.cache_creation_input_tokens),
          output: turn.usage.output + num(usage.output_tokens),
          calls: turn.usage.calls + 1,
        },
      }));
    }
    if (model && model !== '<synthetic>') this.touchTurn((turn) => ({ ...turn, model }));
    const effort = str(r.effort);
    if (effort) this.touchTurn((turn) => ({ ...turn, effort }));
    const content = Array.isArray(message.content) ? message.content : [];
    if (r.isApiErrorMessage === true) {
      const text = content.map((block) => str(obj(block)?.text) ?? '').join('\n');
      this.put({ kind: 'notice', id: this.key(str(r.uuid) ?? `error-${(this.serial += 1)}`), turn: this.turnIndex(), at, notice: 'api_error', text: cut(text, NOTICE_CHARS).text });
      return;
    }
    const cwd = str(r.cwd);
    content.forEach((item, i) => {
      const block = obj(item);
      if (!block) return;
      const entryId = this.key(`${str(r.uuid) ?? id ?? (this.serial += 1)}-${i}`);
      const turn = this.turnIndex();
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        const shown = cut(block.text, TEXT_CHARS);
        this.put({ kind: 'text', id: entryId, turn, at, text: shown.text, truncated: shown.truncated }, this.source(line));
      } else if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        this.put({ kind: 'thinking', id: entryId, turn, at, chars: str(block.thinking)?.length ?? 0 }, this.source(line));
      } else if (block.type === 'tool_use') {
        const useId = str(block.id) ?? entryId;
        const name = str(block.name) ?? 'tool';
        const input = obj(block.input) ?? {};
        const toolEntry = this.key(useId);
        if (AGENT_TOOLS.has(name)) {
          const description = str(input.description) ?? oneLine(str(input.prompt) ?? '');
          this.put({ kind: 'agent', id: toolEntry, turn, at, agentType: str(input.subagent_type), description, state: 'running', agentId: null }, this.source(line));
        } else {
          this.put({ kind: 'tool', id: toolEntry, turn, at, name, summary: toolSummary(name, input, cwd), state: 'running' }, this.source(line));
        }
      }
    });
  }

  private system(r: Json, at: number | null, line: LineRange): void {
    switch (r.subtype) {
      case 'turn_duration':
        if (this.turnList.length) this.touchTurn((turn) => ({ ...turn, durationMs: num(r.durationMs) || turn.durationMs }));
        return;
      case 'compact_boundary': {
        const id = this.key(str(r.uuid) ?? `compact-${(this.serial += 1)}`);
        this.put({ kind: 'notice', id, turn: this.turnIndex(), at, notice: 'compacted', text: '' });
        this.lastCompact = id;
        return;
      }
      case 'local_command': {
        const text = str(r.content);
        if (text) this.command(text, at, line);
        return;
      }
      default:
    }
  }
}

// What a glance at many sessions shows of a prompt or an answer.
const GLANCE_CHARS = 300;

/**
 * The start of a text as plain words on one line: an answer is markdown, and
 * its marks (headings, list bullets, emphasis, code fences, links, table bars)
 * would only be in the way where a line or two of it are shown.
 */
function plainStart(text: string): string {
  const words = text
    // More than is shown, so that marks do not use up the room; the rest is never looked at.
    .slice(0, GLANCE_CHARS * 8)
    .split(/\r?\n/)
    .filter((line) => !/^\s*(```|~~~)/.test(line) && !/^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line))
    .map((line) =>
      line
        .replace(/^\s*(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)*/, '')
        .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\*\*|__|`/g, '')
        .replace(/\|/g, ' '),
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return words.length > GLANCE_CHARS ? `${words.slice(0, GLANCE_CHARS)}…` : words;
}

/**
 * What a conversation was last asked and what it last said to that, from its
 * entries (all of them, or those of the end of its transcript): the latest
 * prompt, and the latest text after it. A slash command the model answered (a
 * skill, /loop) is what was asked; one the CLI answered itself (/model) is not.
 * A background agent's report starts a turn but asks nothing: what the model
 * says to it still answers the prompt before.
 */
export function latestWords(entries: ConversationEntry[]): LatestWords {
  const said = (entry: ConversationEntry) => entry.kind === 'text' || entry.kind === 'tool' || entry.kind === 'agent' || entry.kind === 'thinking';
  // From the end: the latest text is the answer, and the first prompt met is what it answers.
  let ask: ConversationEntry | undefined;
  let answered = false;
  let answer: string | null = null;
  for (let i = entries.length - 1; i >= 0 && !ask; i -= 1) {
    const entry = entries[i]!;
    if (entry.kind === 'prompt' || (entry.kind === 'command' && answered)) ask = entry;
    else if (said(entry)) {
      answered = true;
      if (entry.kind === 'text' && answer === null) answer = entry.text;
    }
  }
  const prompt = ask?.kind === 'prompt' ? plainStart(ask.text) : ask?.kind === 'command' ? plainStart(`${ask.name} ${ask.args}`) : '';
  return { prompt: prompt || null, promptAt: ask?.at ?? null, answer: (answer !== null && plainStart(answer)) || null };
}

/** What a session ran with when it last answered. */
export interface LatestRun {
  model: string | null;
  effort: string | null;
  /** The CLI's version, as each record carries it. */
  version: string | null;
}

// A model's id, an effort, a version: short by nature.
const NAME_CHARS = 80;

/**
 * The model, the effort and the CLI version of the latest answer among these
 * records (the lines of a transcript's end, oldest first): what a session
 * nothing else reports for is known to run with. All null before its first answer.
 */
export function latestRun(records: unknown[]): LatestRun {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = obj(records[i]);
    const model = record?.type === 'assistant' ? str(obj(record.message)?.model) : null;
    if (!record || !model || model === '<synthetic>') continue;
    const short = (value: unknown) => str(value)?.slice(0, NAME_CHARS) || null;
    return { model: model.slice(0, NAME_CHARS), effort: short(record.effort), version: short(record.version) };
  }
  return { model: null, effort: null, version: null };
}

/** The text blocks of an assistant record that holds an answer (not an API error), joined; null for any other record. */
export function answerText(record: unknown): string | null {
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

/** A value to show, cut where it is too long, too many or too deep; `state.truncated` says that something was left out. */
function clip(value: unknown, state: { truncated: boolean }, depth = 0): unknown {
  if (typeof value === 'string') {
    if (value.length <= DETAIL_CHARS) return value;
    state.truncated = true;
    return value.slice(0, DETAIL_CHARS);
  }
  if (!value || typeof value !== 'object') return value;
  if (depth > DETAIL_DEPTH) {
    state.truncated = true;
    return '…';
  }
  if (Array.isArray(value)) {
    if (value.length > DETAIL_ITEMS) state.truncated = true;
    return value.slice(0, DETAIL_ITEMS).map((item) => clip(item, state, depth + 1));
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clip(item, state, depth + 1)]));
}

/** An entry's full content from the records its source lines hold (in the order of EntrySource.lines). */
export function entryDetail(entry: ConversationEntry, records: unknown[]): EntryDetail {
  const state = { truncated: false };
  const text = (value: string) => clip(value, state) as string;
  const [first, second] = records.map(obj);
  const blocks = (r: Json | null | undefined) => (Array.isArray(obj(r?.message)?.content) ? (obj(r?.message)!.content as unknown[]).map(obj) : []);
  const reportIn = (r: Json | null | undefined) => (obj(r?.origin)?.kind === 'task-notification' ? taskReport(resultText(obj(r?.message)?.content)) : null);
  switch (entry.kind) {
    case 'tool':
    case 'agent': {
      const useId = entry.id.replace(/^s\d+-/, '');
      const use = blocks(first).find((b) => b?.type === 'tool_use' && b.id === useId);
      const result = blocks(second).find((b) => b?.type === 'tool_result' && b.tool_use_id === useId);
      const structured = obj(second?.toolUseResult);
      // A background agent: its launch result is internal; what it reported is what it did.
      const report = records.map(obj).map(reportIn).find(Boolean);
      const launched = structured?.status === 'async_launched' || structured?.isAsync === true;
      const output = report?.result ?? (result && !launched ? resultText(result.content) : null);
      let room = PATCH_LINES;
      const patch = Array.isArray(structured?.structuredPatch)
        ? (structured.structuredPatch as unknown[])
            .map(obj)
            .filter(Boolean)
            .flatMap((hunk) => {
              const all = Array.isArray(hunk!.lines) ? (hunk!.lines as unknown[]).filter((l): l is string => typeof l === 'string') : [];
              const lines = all.slice(0, room).map(text);
              if (lines.length < all.length) state.truncated = true;
              room -= lines.length;
              // A hunk with no room left for any of its lines is left out whole.
              return lines.length || !all.length ? [{ oldStart: num(hunk!.oldStart), newStart: num(hunk!.newStart), lines }] : [];
            })
        : undefined;
      return {
        input: clip(use?.input ?? null, state),
        ...(output !== null ? { text: text(output) } : {}),
        ...(patch?.length ? { patch } : {}),
        truncated: state.truncated,
      };
    }
    case 'task':
      return { text: text(reportIn(first)?.result ?? ''), truncated: state.truncated };
    case 'thinking': {
      const block = blocks(first).find((b) => b?.type === 'thinking');
      return { text: text(str(block?.thinking) ?? ''), truncated: state.truncated };
    }
    case 'text': {
      const block = blocks(first).find((b) => b?.type === 'text');
      return { text: text(str(block?.text) ?? ''), truncated: state.truncated };
    }
    case 'prompt':
    case 'notice':
      return { text: text(resultText(obj(first?.message)?.content)), truncated: state.truncated };
    default:
      return { truncated: false };
  }
}
