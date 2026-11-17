import { open } from 'node:fs/promises';

/** A line of a transcript is this long at most; what is longer is not read as one. */
export const MAX_LINE_BYTES = 64 * 1024 * 1024;

/** The end of a file: where it starts in the file, and its bytes. */
export interface Tail {
  start: number;
  data: Buffer;
}

/**
 * The last `bytes` of a file, or what comes after `from` when that is less.
 * Null when there is no such file to open.
 */
export async function readTail(file: string, bytes: number, from = 0): Promise<Tail | null> {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, from, size - bytes);
    const data = Buffer.alloc(Math.max(0, size - start));
    if (data.length) await handle.read(data, 0, data.length, start);
    return { start, data };
  } finally {
    await handle.close();
  }
}

/** A line of a file: its text, and its place there in bytes. */
export interface TailLine {
  text: string;
  start: number;
  end: number;
}

/**
 * The lines of a file's end, oldest first, empty ones left out. An end that
 * starts later than `from` (where a line is known to begin) starts in the
 * middle of a line: that piece is no line and is left out. The last line may
 * be one still being written.
 */
export function* tailLines(tail: Tail, from = 0): Generator<TailLine> {
  const { start, data } = tail;
  let at = 0;
  if (start > from) {
    const newline = data.indexOf(10);
    if (newline === -1) return;
    at = newline + 1;
  }
  while (at < data.length) {
    let end = data.indexOf(10, at);
    if (end === -1) end = data.length;
    if (end > at) yield { text: data.toString('utf8', at, end), start: start + at, end: start + end };
    at = end + 1;
  }
}
