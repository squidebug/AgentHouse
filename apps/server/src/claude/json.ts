// What Claude Code sends and writes is JSON of shapes nobody promises: a
// hook's payload, a line of a transcript, its list of sessions. These take a
// value only as what it has to be.

export type Json = Record<string, unknown>;

/** The value when it is an object (not an array, not null), else null. */
export const obj = (value: unknown): Json | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : null);

// A tool's name, an error's kind, a session's name: short by nature. Whatever writes them can write
// anything (a command with a session's hook token, a session file of any program of the user's), and
// they go to every browser and into sessions.json.
export const TEXT_CHARS = 200;

/** The value when it is a string with something in it, cut to `max` characters; else null. */
export const text = (value: unknown, max = TEXT_CHARS): string | null => (typeof value === 'string' && value ? value.slice(0, max) : null);

/** Claude's ids for sub-agents, tasks and scheduled prompts: short, of letters, digits, `_` and `-`. */
export const SHORT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * What stands between `<name>` and `</name>` in a text, as it is; null without such a pair. The
 * text is whatever a command printed or someone pasted, so it is looked through once: a pattern
 * would start over at every `<name>` of a text that never closes one.
 */
export function tag(block: string, name: string): string | null {
  const open = `<${name}>`;
  const from = block.indexOf(open);
  if (from < 0) return null;
  const to = block.indexOf(`</${name}>`, from + open.length);
  return to < 0 ? null : block.slice(from + open.length, to);
}
