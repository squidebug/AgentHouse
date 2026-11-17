import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { MemoryFile, SessionInfo } from '@agenthouse/protocol';
import { noteHeader, noteInside, noteStart } from './notes';
import { projectDir } from './sessions';
import { isClaudeTranscript } from './status';

// What Claude Code reads into a session by itself, besides the prompt:
//  - Instructions the user wrote: CLAUDE.md in the config folder (every
//    project), CLAUDE.md or .claude/CLAUDE.md and .claude/rules/*.md in the
//    session's folder, CLAUDE.local.md there (this machine only), and the files
//    those name with @path.
//  - The memory it keeps for the project by itself: notes in
//    <config>/projects/<project>/memory/, next to the project's transcripts,
//    indexed by MEMORY.md. A note begins with a header: name, description and,
//    under metadata, type.
// Listed for the user to read and edit; only files that exist, and only notes
// (see noteInside).

const MAX_FILES = 200;
const IMPORT_DEPTH = 2;
// A note's own file name: no folder, no way out of one.
const FILE = /^[\w.@()+ -]{1,120}\.md$/i;

type Listed = Omit<MemoryFile, 'title' | 'about' | 'type'>;

/** Claude's folder for the session's project: where its transcript is, else the one named after its folder. */
function projectOf(session: Pick<SessionInfo, 'cwd' | 'transcripts'>, configDir: string): string {
  const transcript = [...session.transcripts].reverse().find((segment) => isClaudeTranscript(segment.path, configDir));
  return transcript ? path.dirname(transcript.path) : projectDir(configDir, session.cwd);
}

/** The markdown files of a folder itself, by name. */
async function notesIn(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter((name) => FILE.test(name)).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/** The files a note of the session's folder names with @path, when they are notes of that folder too. */
async function imports(file: string, cwd: string): Promise<string[]> {
  let text: string;
  try {
    text = await noteStart(file);
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const match of text.matchAll(/(?:^|\s)@([\w./\\-]+\.md)\b/gi)) {
    const real = await noteInside(cwd, path.resolve(path.dirname(file), match[1]!));
    if (real && !found.includes(real)) found.push(real);
  }
  return found;
}

/**
 * The instruction files and memory notes that apply to a session, as they are
 * on disk now: the user's, the project's, this machine's, then the notes of
 * the project's memory with their index first.
 */
export async function memoryFiles(session: Pick<SessionInfo, 'cwd' | 'transcripts'>, configDir: string): Promise<MemoryFile[]> {
  const listed: Listed[] = [];
  const seen = new Set<string>();
  const add = async (entry: Omit<Listed, 'path'>, base: string, file: string): Promise<string | null> => {
    const real = await noteInside(base, file);
    const key = real && (process.platform === 'win32' ? real.toLowerCase() : real);
    if (!real || !key || seen.has(key) || listed.length >= MAX_FILES) return null;
    seen.add(key);
    listed.push({ ...entry, path: real });
    return real;
  };
  const { cwd } = session;
  // Real paths are compared with the folder's own real path (a temp folder may be named in its short form).
  const root = await realpath(cwd).catch(() => cwd);
  const inProject = (real: string) => path.relative(root, real).replace(/\\/g, '/');
  /** A file of the session's folder, then what it imports, to a depth. */
  const withImports = async (entry: Omit<Listed, 'path'>, file: string, depth = 0): Promise<void> => {
    const real = await add(entry, cwd, file);
    if (!real || depth >= IMPORT_DEPTH) return;
    for (const imported of await imports(real, cwd)) {
      const name = inProject(imported);
      await withImports({ id: `import:${name}`, kind: 'instructions', scope: entry.scope, name }, imported, depth + 1);
    }
  };

  await add({ id: 'user', kind: 'instructions', scope: 'user', name: 'CLAUDE.md' }, configDir, path.join(configDir, 'CLAUDE.md'));
  for (const name of await notesIn(path.join(configDir, 'rules'))) {
    await add({ id: `user-rule:${name}`, kind: 'instructions', scope: 'user', name: `rules/${name}` }, configDir, path.join(configDir, 'rules', name));
  }
  await withImports({ id: 'project', kind: 'instructions', scope: 'project', name: 'CLAUDE.md' }, path.join(cwd, 'CLAUDE.md'));
  await withImports({ id: 'project-claude', kind: 'instructions', scope: 'project', name: '.claude/CLAUDE.md' }, path.join(cwd, '.claude', 'CLAUDE.md'));
  for (const name of await notesIn(path.join(cwd, '.claude', 'rules'))) {
    await add({ id: `rule:${name}`, kind: 'instructions', scope: 'project', name: `.claude/rules/${name}` }, cwd, path.join(cwd, '.claude', 'rules', name));
  }
  await withImports({ id: 'local', kind: 'instructions', scope: 'local', name: 'CLAUDE.local.md' }, path.join(cwd, 'CLAUDE.local.md'));

  const memory = path.join(projectOf(session, configDir), 'memory');
  const notes = await notesIn(memory);
  // The index first, then the notes it lists.
  for (const name of [...notes.filter((n) => n === 'MEMORY.md'), ...notes.filter((n) => n !== 'MEMORY.md')]) {
    await add({ id: `memory:${name}`, kind: 'memory', scope: 'project', name }, memory, path.join(memory, name));
  }

  return Promise.all(
    listed.map(async (entry): Promise<MemoryFile> => {
      const none = { title: null, about: null, type: null };
      if (entry.kind !== 'memory') return { ...entry, ...none };
      return { ...entry, ...(await noteStart(entry.path).then(noteHeader, () => none)) };
    }),
  );
}
