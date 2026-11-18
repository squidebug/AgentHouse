// Since which version Claude Code has what AgentHouse uses of it. A user keeps
// the CLI they have: what an older one lacks is left out, never asked for.

/** `claude agents --json` (lists sessions as idle, busy or waiting) arrived in 2.1.145. */
export const AGENTS_JSON_SINCE = [2, 1, 145];
/**
 * The sub-agent status line (each sub-agent's model and tokens), first checked on
 * 2.1.322; older versions may have it too, but an unknown settings key is not risked.
 */
export const SUBAGENT_STATUS_LINE_SINCE = [2, 1, 322];

/** Compares the first x.y.z in a CLI's version text; an unknown version counts as recent enough. */
export function versionAtLeast(version: string | null, minimum: number[]): boolean {
  const parts = version?.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  if (!parts) return true;
  for (let i = 0; i < minimum.length; i += 1) {
    const a = parts[i] ?? 0;
    const b = minimum[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}
