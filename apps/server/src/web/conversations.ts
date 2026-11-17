import { open } from 'node:fs/promises';
import type { ConversationEntry, ConversationServerMessage, EntryDetail, LatestWords, SessionInfo, TranscriptSegment } from '@agenthouse/protocol';
import { claudeConfigDir } from '../claude/settings';
import { isClaudeTranscript } from '../claude/status';
import { ConversationBuilder, entryDetail, latestWords, type LineRange } from '../claude/transcript';
import type { SessionManager } from './manager';

// Read in pieces, giving the event loop back in between: a 10 MB transcript
// must not hold up terminals and API calls while it is parsed.
const CHUNK_BYTES = 256 * 1024;
const MAX_LINE_BYTES = 64 * 1024 * 1024;
// A transcript grows while its session works; hook events also prompt a read.
const POLL_MS = 1000;
// A view switched away and back within this reuses what was read.
const KEEP_MS = 60_000;

/** Lets whatever else waits on the event loop (terminal output, API calls) run before the next piece. */
const yieldToOthers = () => new Promise<void>((resolve) => setImmediate(resolve));

type Listener = (message: ConversationServerMessage) => void;

/** One transcript file, read from where it left off, one complete line at a time with its byte range. */
class SegmentReader {
  /** File offset of the first byte not yet handed out as part of a line. */
  private offset = 0;
  private carry = Buffer.alloc(0);
  /** An earlier conversation, read to its end: it no longer grows. */
  done = false;
  started = false;

  constructor(readonly path: string) {}

  async read(onLine: (text: string, range: LineRange) => void): Promise<'read' | 'missing' | 'shrunk'> {
    let handle;
    try {
      handle = await open(this.path, 'r');
    } catch {
      return 'missing';
    }
    try {
      const { size } = await handle.stat();
      let position = this.offset + this.carry.length;
      if (size < position) return 'shrunk';
      while (position < size) {
        const chunk = Buffer.alloc(Math.min(CHUNK_BYTES, size - position));
        const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
        if (!bytesRead) break;
        position += bytesRead;
        const data = this.carry.length ? Buffer.concat([this.carry, chunk.subarray(0, bytesRead)]) : chunk.subarray(0, bytesRead);
        let start = 0;
        for (let newline = data.indexOf(10); newline !== -1; newline = data.indexOf(10, start)) {
          const end = newline > start && data[newline - 1] === 13 ? newline - 1 : newline;
          if (end > start) onLine(data.toString('utf8', start, end), [this.offset + start, this.offset + end]);
          start = newline + 1;
        }
        this.offset += start;
        this.carry = data.length - start > MAX_LINE_BYTES ? Buffer.alloc(0) : Buffer.from(data.subarray(start));
        await yieldToOthers();
      }
      return 'read';
    } finally {
      await handle.close();
    }
  }
}

// For a glance at a session: the end of its transcript, this much at first and more while no prompt is in it.
const TAIL_BYTES = 256 * 1024;
const TAIL_MAX_BYTES = 4 * 1024 * 1024;

/**
 * The entries of the end of a transcript: as much of it as holds its latest
 * prompt, up to a limit (a turn that wrote more than that since its prompt
 * shows what it said, without the prompt). Read like a conversation, in pieces.
 */
async function tailEntries(file: string): Promise<ConversationEntry[]> {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch {
    return [];
  }
  try {
    const { size } = await handle.stat();
    for (let want = TAIL_BYTES; ; want *= 4) {
      const start = Math.max(0, size - want);
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const builder = new ConversationBuilder();
      // A read that starts mid-file may start mid-line: that piece is not a record.
      let at = start > 0 ? buffer.indexOf(10) + 1 || buffer.length : 0;
      let parsed = at;
      while (at < buffer.length) {
        let end = buffer.indexOf(10, at);
        if (end === -1) end = buffer.length;
        if (end > at) {
          try {
            builder.add(JSON.parse(buffer.toString('utf8', at, end)), [start + at, start + end]);
          } catch {
            // a line still being written
          }
        }
        at = end + 1;
        if (at - parsed >= CHUNK_BYTES) {
          parsed = at;
          await yieldToOthers();
        }
      }
      const { entries } = builder.snapshot();
      if (start === 0 || want >= TAIL_MAX_BYTES || entries.some((entry) => entry.kind === 'prompt')) return entries;
    }
  } finally {
    await handle.close();
  }
}

async function readLines(file: string, ranges: LineRange[]): Promise<unknown[]> {
  const handle = await open(file, 'r');
  try {
    const records: unknown[] = [];
    for (const [start, end] of ranges) {
      const buffer = Buffer.alloc(Math.min(end - start, MAX_LINE_BYTES));
      await handle.read(buffer, 0, buffer.length, start);
      try {
        records.push(JSON.parse(buffer.toString('utf8')));
      } catch {
        records.push(null);
      }
    }
    return records;
  } finally {
    await handle.close();
  }
}

/** One session's conversation: its transcripts read and followed while someone views it. */
class Conversation {
  private builder = new ConversationBuilder();
  private readers: SegmentReader[];
  private readonly listeners = new Set<Listener>();
  private ready = false;
  private running: Promise<void> | null = null;
  private again = false;
  private poll: NodeJS.Timeout | undefined;
  private idle: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(
    private segments: TranscriptSegment[],
    private readonly onIdle: () => void,
  ) {
    this.readers = segments.map((s) => new SegmentReader(s.path));
    this.pump();
  }

  /** The session's transcripts changed: a new one after /clear is followed; anything else starts over. */
  setSegments(segments: TranscriptSegment[]): void {
    if (!this.segments.every((s, i) => segments[i]?.path === s.path)) {
      this.restart(segments);
      return;
    }
    for (const segment of segments.slice(this.readers.length)) this.readers.push(new SegmentReader(segment.path));
    this.segments = segments;
  }

  subscribe(listener: Listener): () => void {
    clearTimeout(this.idle);
    this.listeners.add(listener);
    if (this.ready) listener({ type: 'reset', ...this.builder.snapshot() });
    this.poll ??= setInterval(() => this.pump(), POLL_MS);
    this.poll.unref();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size) return;
      clearInterval(this.poll);
      this.poll = undefined;
      this.idle = setTimeout(this.onIdle, KEEP_MS);
      this.idle.unref();
    };
  }

  /** Something happened in the session; its transcript has probably grown. */
  nudge(): void {
    if (this.listeners.size) this.pump();
  }

  async detail(entryId: string): Promise<EntryDetail | null> {
    const entry = this.builder.entry(entryId);
    if (!entry) return null;
    const source = this.builder.sources.get(entryId);
    const file = source ? this.segments[source.segment]?.path : undefined;
    if (!source || !file) return { truncated: false };
    return entryDetail(entry, await readLines(file, source.lines));
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.poll);
    clearTimeout(this.idle);
    this.listeners.clear();
  }

  private restart(segments: TranscriptSegment[]): void {
    this.segments = segments;
    this.builder = new ConversationBuilder();
    this.readers = segments.map((s) => new SegmentReader(s.path));
    this.ready = false;
    this.pump();
  }

  private pump(): void {
    if (this.disposed) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.readAll()
      .catch(() => {})
      .finally(() => {
        this.running = null;
        if (!this.again) return;
        this.again = false;
        this.pump();
      });
  }

  private async readAll(): Promise<void> {
    const { builder, readers } = this;
    for (const [i, reader] of readers.entries()) {
      if (reader.done) continue;
      const result = await reader.read((text, range) => {
        if (!reader.started) {
          reader.started = true;
          builder.startSegment(i, this.segments[i]?.since ?? null);
        }
        let record: unknown;
        try {
          record = JSON.parse(text);
        } catch {
          return; // not a record (a line cut short by a crash)
        }
        builder.add(record, range);
      });
      if (builder !== this.builder || this.disposed) return;
      if (result === 'shrunk') return this.restart(this.segments);
      if (result === 'read' && i < readers.length - 1) reader.done = true;
    }
    if (!this.ready) {
      this.ready = true;
      builder.takeChanges();
      this.broadcast({ type: 'reset', ...builder.snapshot() });
      return;
    }
    const changes = builder.takeChanges();
    if (changes) this.broadcast({ type: 'update', ...changes });
  }

  private broadcast(message: ConversationServerMessage): void {
    for (const listener of this.listeners) listener(message);
  }
}

/**
 * The transcripts AgentHouse may read: Claude's own, as hooks reported them or
 * sessions.json kept them. A sub-agent has one, next to the session's.
 */
function transcriptsOf(session: SessionInfo, agentId: string | null): TranscriptSegment[] {
  const configDir = claudeConfigDir();
  if (agentId === null) return session.transcripts.filter((t) => isClaudeTranscript(t.path, configDir));
  const agent = session.agents.find((a) => a.id === agentId);
  if (!agent?.transcriptPath || !isClaudeTranscript(agent.transcriptPath, configDir)) return [];
  return [{ vendorSessionId: null, path: agent.transcriptPath, since: agent.startedAt }];
}

const keyOf = (sessionId: string, agentId: string | null) => `${sessionId}
${agentId ?? ''}`;

/**
 * The conversation views of the sessions and their sub-agents, read in the web
 * server: a transcript is read once, then followed as it grows, while a browser
 * shows it (and a minute after, for switching back and forth).
 */
export class Conversations {
  private readonly open = new Map<string, { sessionId: string; agentId: string | null; conversation: Conversation }>();
  private readonly onChange = () => {
    for (const [key, { sessionId, agentId, conversation }] of this.open) {
      const session = this.manager.get(sessionId);
      if (!session) {
        conversation.dispose();
        this.open.delete(key);
        continue;
      }
      conversation.setSegments(transcriptsOf(session, agentId));
      conversation.nudge();
    }
  };

  constructor(private readonly manager: SessionManager) {
    manager.on('change', this.onChange);
  }

  /** Whether there is a transcript to show: the session's, or with an agent id that sub-agent's. */
  available(sessionId: string, agentId: string | null = null): boolean {
    const session = this.manager.get(sessionId);
    return Boolean(session && transcriptsOf(session, agentId).length);
  }

  /** Sends the conversation to the listener as it is read and grows; null when there is no transcript. */
  subscribe(sessionId: string, listener: Listener, agentId: string | null = null): (() => void) | null {
    const session = this.manager.get(sessionId);
    const segments = session ? transcriptsOf(session, agentId) : [];
    if (!segments.length) return null;
    const key = keyOf(sessionId, agentId);
    let conversation = this.open.get(key)?.conversation;
    if (!conversation) {
      const created = new Conversation(segments, () => {
        created.dispose();
        if (this.open.get(key)?.conversation === created) this.open.delete(key);
      });
      conversation = created;
      this.open.set(key, { sessionId, agentId, conversation: created });
    }
    return conversation.subscribe(listener);
  }

  /**
   * What the session was last asked and what it last said, for a glance at many
   * sessions: from the end of its latest transcript alone, read when asked for.
   * A conversation after /clear starts with neither.
   */
  async latest(sessionId: string): Promise<LatestWords> {
    const session = this.manager.get(sessionId);
    const last = session ? transcriptsOf(session, null).at(-1) : undefined;
    return latestWords(last ? await tailEntries(last.path) : []);
  }

  /** The full content of one entry of a conversation being viewed. */
  detail(sessionId: string, entryId: string, agentId: string | null = null): Promise<EntryDetail | null> {
    return this.open.get(keyOf(sessionId, agentId))?.conversation.detail(entryId) ?? Promise.resolve(null);
  }

  close(): void {
    this.manager.off('change', this.onChange);
    for (const { conversation } of this.open.values()) conversation.dispose();
    this.open.clear();
  }
}
