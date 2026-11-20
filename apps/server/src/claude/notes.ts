import { createHash, randomBytes } from 'node:crypto';
import { open, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TextFile } from '@agenthouse/protocol';

// The user's own notes for Claude Code (a skill, CLAUDE.md, a memory note), opened and saved from
// the page. Only ever at a path the server worked out itself; what a request names is looked up in
// that list, never used as a path.

/** A note a person edits is small; a larger file is not offered. */
export const MAX_FILE_BYTES = 512 * 1024;

export class FileError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_FOUND' | 'CHANGED' | 'TOO_LARGE' | 'NOT_TEXT',
  ) {
    super(message);
  }
}

const versionOf = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex').slice(0, 16);
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const hasBom = (bytes: Buffer) => bytes.subarray(0, 3).equals(BOM);

/**
 * The real path of a markdown file when it is a file of that folder: a link
 * that leads out of the folder, a file of another kind (the folder may hold
 * credentials) or one too large to be a note is none.
 */
export async function noteInside(base: string, file: string): Promise<string | null> {
  try {
    const [root, real] = await Promise.all([realpath(base), realpath(file)]);
    const inside = path.relative(root, real);
    if (!inside || inside.startsWith('..') || path.isAbsolute(inside) || !real.toLowerCase().endsWith('.md')) return null;
    const info = await stat(real);
    return info.isFile() && info.size <= MAX_FILE_BYTES ? real : null;
  } catch {
    return null;
  }
}

const HEADER_BYTES = 4096;

/** The start of a note: enough for its header and its first lines. */
export async function noteStart(file: string): Promise<string> {
  const handle = await open(file, 'r');
  try {
    const buffer = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0);
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * What a note says of itself in the header it begins with: a skill's or a
 * memory note's name and description, and a memory note's kind (under
 * `metadata`).
 */
export function noteHeader(text: string): { title: string | null; about: string | null; type: string | null } {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const block = body.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1];
  if (!block) return { title: null, about: null, type: null };
  const field = (pattern: RegExp) => {
    const value = block.match(pattern)?.[1]?.trim().replace(/^(["'])(.*)\1$/, '$2');
    return value ? value.slice(0, 300) : null;
  };
  return { title: field(/^name:[ \t]*(.+)$/m), about: field(/^description:[ \t]*(.+)$/m), type: field(/^[ \t]+type:[ \t]*(.+)$/m) ?? field(/^type:[ \t]*(.+)$/m) };
}

/** The file as text. Line ends are sent as the page keeps them (LF); `version` tells this content from any other. */
export async function readText(file: string): Promise<TextFile> {
  const bytes = await readFile(file).catch(() => null);
  if (!bytes) throw new FileError('파일을 찾을 수 없습니다.', 'NOT_FOUND');
  if (bytes.length > MAX_FILE_BYTES) throw new FileError('파일이 너무 큽니다.', 'TOO_LARGE');
  if (bytes.includes(0)) throw new FileError('텍스트 파일이 아닙니다.', 'NOT_TEXT');
  const text = bytes.subarray(hasBom(bytes) ? 3 : 0).toString('utf8');
  return { path: file, text: text.replace(/\r\n/g, '\n'), version: versionOf(bytes) };
}

async function renameOver(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows refuses while something has the file open (a scanner, an editor, the CLI reading it).
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 30 * (attempt + 1)));
    }
  }
}

/**
 * Saves the text over the file, whole or not at all, unless the file is no
 * longer what the page loaded (`version`): Claude and the user's editor write
 * these files too. Its line ends, its byte order mark and its permissions stay
 * as they were.
 */
export async function writeText(file: string, text: string, version: string): Promise<TextFile> {
  const before = await readFile(file).catch(() => null);
  if (!before) throw new FileError('파일을 찾을 수 없습니다.', 'NOT_FOUND');
  if (versionOf(before) !== version) throw new FileError('파일이 디스크에서 바뀌었습니다.', 'CHANGED');
  const lines = text.replace(/\r\n/g, '\n');
  const body = Buffer.from(before.includes('\r\n') ? lines.replace(/\n/g, '\r\n') : lines, 'utf8');
  const bytes = hasBom(before) ? Buffer.concat([BOM, body]) : body;
  if (bytes.length > MAX_FILE_BYTES) throw new FileError('파일이 너무 큽니다.', 'TOO_LARGE');
  const { mode } = await stat(file);
  // The folder may be a project's, with whatever its repository put there: a name nobody can
  // know beforehand, and made new or not at all (`wx`), so that a link waiting under the name is
  // never written through.
  const temp = `${file}.${randomBytes(8).toString('hex')}.agenthouse.tmp`;
  await writeFile(temp, bytes, { mode, flag: 'wx' });
  try {
    await renameOver(temp, file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return { path: file, text: lines, version: versionOf(bytes) };
}
