import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

/** Managed (admin) settings files; the Windows registry and macOS MDM sources are not read. */
function managedSettingsFiles(): string[] {
  const dir =
    process.platform === 'win32'
      ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'ClaudeCode')
      : process.platform === 'darwin'
        ? '/Library/Application Support/ClaudeCode'
        : '/etc/claude-code';
  const files = [path.join(dir, 'managed-settings.json')];
  try {
    const dropIns = path.join(dir, 'managed-settings.d');
    for (const name of readdirSync(dropIns).sort()) if (name.endsWith('.json') && !name.startsWith('.')) files.push(path.join(dropIns, name));
  } catch {
    // no drop-in folder
  }
  return files;
}

/**
 * Why Claude would not run AgentHouse's hooks and status line: managed policy
 * (`disableAllHooks`, `allowManagedHooksOnly`) or the user's own
 * `disableAllHooks`. The terminal works either way; only status and usage go.
 */
export function claudeHookBlocker(env: NodeJS.ProcessEnv = process.env): 'managed' | 'user' | null {
  for (const file of managedSettingsFiles()) {
    const settings = readSettings(file);
    if (settings?.disableAllHooks === true || settings?.allowManagedHooksOnly === true) return 'managed';
  }
  return readSettings(path.join(claudeConfigDir(env), 'settings.json'))?.disableAllHooks === true ? 'user' : null;
}

/** Git Bash, which Claude Code on Windows runs hook and status line commands with (PowerShell without it). */
export function gitBashPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const bases = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Programs')];
  const candidates = [env.CLAUDE_CODE_GIT_BASH_PATH, ...bases.filter(Boolean).map((base) => path.join(String(base), 'Git', 'bin', 'bash.exe'))];
  return candidates.find((file): file is string => typeof file === 'string' && existsSync(file)) ?? null;
}

/**
 * The status line the user would see without AgentHouse: the first one in local
 * project, shared project, then user settings (Claude's own order below managed
 * policy and the --settings flag). AgentHouse's status line runs it and prints
 * its output, so the user's status line stays as it was. The same goes for the
 * sub-agent status line (`subagentStatusLine`).
 */
export function userStatusLine(cwd: string, env: NodeJS.ProcessEnv = process.env, key: 'statusLine' | 'subagentStatusLine' = 'statusLine'): StatusLineSetting | null {
  const files = [path.join(cwd, '.claude', 'settings.local.json'), path.join(cwd, '.claude', 'settings.json'), path.join(claudeConfigDir(env), 'settings.json')];
  for (const file of files) {
    const statusLine = readSettings(file)?.[key] as { type?: unknown; command?: unknown; padding?: unknown } | undefined;
    if (statusLine?.type === 'command' && typeof statusLine.command === 'string' && statusLine.command.trim()) {
      return { command: statusLine.command, ...(typeof statusLine.padding === 'number' ? { padding: statusLine.padding } : {}) };
    }
  }
  return null;
}
