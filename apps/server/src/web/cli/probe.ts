import { execFile } from 'node:child_process';
import type { CliInstall } from '@agenthouse/protocol';
import { childEnv } from '../../shared/child-env';

interface QuickResult {
  code: number | null;
  stdout: string;
}

/**
 * Runs a short-lived CLI command (version, login status) without a console window, in the
 * environment a session gets: started from inside an agent's session, AgentHouse would else
 * ask the CLI as that session's child.
 */
export function runQuick(file: string, args: string[], timeoutMs = 10_000): Promise<QuickResult> {
  return new Promise((resolve) => {
    execFile(file, args, { env: childEnv(), timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (error, stdout) => {
      const code = error ? (typeof error.code === 'number' ? error.code : null) : 0;
      resolve({ code, stdout: String(stdout ?? '') });
    });
  });
}

export async function detectVersion(install: Pick<CliInstall, 'file' | 'args'>): Promise<string | null> {
  return (await identify(install)).version;
}

/** What `--version` says: the version, and the whole line, which names the program ("2.1.323 (Claude Code)", "codex-cli 0.167.2"). */
export async function identify(install: Pick<CliInstall, 'file' | 'args'>): Promise<{ version: string | null; text: string }> {
  const { stdout } = await runQuick(install.file, [...install.args, '--version']);
  return { version: stdout.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null, text: stdout.trim() };
}

export async function claudeLoggedIn(install: Pick<CliInstall, 'file' | 'args'>): Promise<boolean | null> {
  const { stdout } = await runQuick(install.file, [...install.args, 'auth', 'status', '--json']);
  try {
    return (JSON.parse(stdout) as { loggedIn?: boolean }).loggedIn === true;
  } catch {
    return null;
  }
}

export async function codexLoggedIn(install: Pick<CliInstall, 'file' | 'args'>): Promise<boolean | null> {
  const { code } = await runQuick(install.file, [...install.args, 'login', 'status']);
  if (code === null) return null;
  return code === 0;
}
