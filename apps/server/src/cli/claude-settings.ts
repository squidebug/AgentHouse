import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface StatusLineSetting {
  command: string;
  padding?: number;
}

function readSettings(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Claude Code's config folder: CLAUDE_CONFIG_DIR, or ~/.claude. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/**
 * The status line the user would see without AgentHouse: the first one in local
 * project, shared project, then user settings (Claude's own order below managed
 * policy and the --settings flag). AgentHouse's status line runs it and prints
 * its output, so the user's status line stays as it was.
 */
export function userStatusLine(cwd: string, env: NodeJS.ProcessEnv = process.env): StatusLineSetting | null {
  const files = [path.join(cwd, '.claude', 'settings.local.json'), path.join(cwd, '.claude', 'settings.json'), path.join(claudeConfigDir(env), 'settings.json')];
  for (const file of files) {
    const statusLine = readSettings(file)?.statusLine as { type?: unknown; command?: unknown; padding?: unknown } | undefined;
    if (statusLine?.type === 'command' && typeof statusLine.command === 'string' && statusLine.command.trim()) {
      return { command: statusLine.command, ...(typeof statusLine.padding === 'number' ? { padding: statusLine.padding } : {}) };
    }
  }
  return null;
}
