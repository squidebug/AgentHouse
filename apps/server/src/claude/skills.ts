import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import type { SessionInfo, SkillInfo } from '@agenthouse/protocol';
import { noteHeader, noteInside, noteStart } from './notes';
import { isClaudeTranscript } from './status';

// The skills a Claude Code conversation was given (2.1.325): an `attachment`
// record of type skill_listing near the start of its transcript, { names[],
// content: a "- name: what it is for" line each }. Nothing in it says where a
// skill comes from; a plugin's is named plugin:skill, and the project's and the
// user's own lie in a folder of their name (or, as a command, in a file).

// The listing follows the first prompt; this much of the file is read for it.
const HEAD_BYTES = 4 * 1024 * 1024;
const MAX_SKILLS = 500;
const ABOUT_CHARS = 300;
// A name becomes part of a path: only what a skill can be called.
const NAME = /^[A-Za-z0-9][\w.-]{0,63}(?::[\w.-]{1,64})?$/;

type Json = Record<string, unknown>;
const obj = (value: unknown): Json | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null);

/** The skills a transcript lists, in its order; none when it has no listing (or cannot be read). */
export async function listedSkills(transcript: string): Promise<Array<Pick<SkillInfo, 'name' | 'about'>>> {
  const stream = createReadStream(transcript, { encoding: 'utf8', end: HEAD_BYTES - 1 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.includes('"skill_listing"')) continue;
      let listing: Json | null = null;
      try {
        listing = obj(obj(JSON.parse(line))?.attachment);
      } catch {
        // the line the read was cut in
      }
      if (listing?.type !== 'skill_listing' || !Array.isArray(listing.names)) continue;
      const content = typeof listing.content === 'string' ? listing.content.split(/\r?\n/) : [];
      const names = [...new Set(listing.names.filter((name): name is string => typeof name === 'string' && NAME.test(name)))].slice(0, MAX_SKILLS);
      return names.map((name) => {
        const about = content.find((text) => text.startsWith(`- ${name}: `))?.slice(name.length + 4).trim();
        return { name, about: about ? about.slice(0, ABOUT_CHARS) : null };
      });
    }
  } catch {
    // gone, or not ours to read
  } finally {
    lines.close();
    stream.destroy();
  }
  return [];
}

const exists = (file: string) =>
  stat(file).then(
    () => true,
    () => false,
  );

/** A skill's own folder, or the file of a command of that name, under a `.claude` folder. */
const has = async (base: string, name: string) => (await exists(path.join(base, 'skills', name))) || (await exists(path.join(base, 'commands', `${name}.md`)));

/**
 * The file a skill of the project or of the user is written in (its SKILL.md,
 * or the command file of that name), when it is a note of that folder; the
 * project's comes first, as it does for Claude. A plugin's and the CLI's own
 * have none to edit.
 */
export async function skillFile(cwd: string, configDir: string, name: string): Promise<{ source: 'project' | 'user'; path: string } | null> {
  if (!NAME.test(name) || name.includes(':')) return null;
  for (const [source, base] of [
    ['project', path.join(cwd, '.claude')],
    ['user', configDir],
  ] as const) {
    for (const file of [path.join(base, 'skills', name, 'SKILL.md'), path.join(base, 'commands', `${name}.md`)]) {
      const real = await noteInside(base, file);
      if (real) return { source, path: real };
    }
  }
  return null;
}

/**
 * The skills of a session's conversation (the latest one, after /clear), with
 * where each comes from, whether the session ran it and whether its file can
 * be edited.
 */
export async function skillsOf(session: Pick<SessionInfo, 'cwd' | 'transcripts' | 'invoked'>, configDir: string): Promise<SkillInfo[]> {
  const transcript = [...session.transcripts].reverse().find((segment) => isClaudeTranscript(segment.path, configDir));
  const used = new Set(session.invoked);
  const listed = transcript ? await listedSkills(transcript.path) : [];
  const skills = await Promise.all(
    listed.map(async ({ name, about }): Promise<SkillInfo> => {
      const source = name.includes(':') ? 'plugin' : (await has(path.join(session.cwd, '.claude'), name)) ? 'project' : (await has(configDir, name)) ? 'user' : 'builtin';
      const file = source === 'project' || source === 'user' ? await skillFile(session.cwd, configDir, name) : null;
      return { name, about, source, used: used.has(name), editable: file?.source === source };
    }),
  );
  // What lies in the project's and the user's folders but no listing names: written since the
  // conversation began, or there is no conversation yet. Only what has a file of its own to open.
  const known = new Set(skills.map((skill) => skill.name));
  for (const [source, base] of [
    ['project', path.join(session.cwd, '.claude')],
    ['user', configDir],
  ] as const) {
    for (const name of await skillsIn(base)) {
      if (known.has(name) || skills.length >= MAX_SKILLS) continue;
      known.add(name);
      const file = await skillFile(session.cwd, configDir, name);
      if (file?.source !== source) continue;
      const about = await noteStart(file.path).then(
        (text) => noteHeader(text).about,
        () => null,
      );
      skills.push({ name, about, source, used: used.has(name), editable: true });
    }
  }
  return skills;
}

/** The names of the skills that lie in a `.claude` folder: a folder each under `skills`, a file each under `commands`. */
async function skillsIn(base: string): Promise<string[]> {
  const named = (name: string) => NAME.test(name) && !name.includes(':');
  const folders = await readdir(path.join(base, 'skills')).catch(() => []);
  const commands = (await readdir(path.join(base, 'commands')).catch(() => [])).filter((file) => file.toLowerCase().endsWith('.md')).map((file) => file.slice(0, -3));
  return [...new Set([...folders, ...commands].filter(named))].sort((a, b) => a.localeCompare(b));
}
