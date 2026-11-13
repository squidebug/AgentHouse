// Resolves the real executable behind an npm shim, so the PTY's child is the CLI
// itself rather than cmd.exe. That keeps its pid comparable with the one
// `claude agents --json` reports and avoids cmd.exe argument quoting.
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const isWindows = process.platform === 'win32';

export interface ResolvedCommand {
  shim: string;
  file: string;
  args: string[];
}

function isExecutableFile(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    if (!isWindows) accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every match for `name` in PATH order, like `where`/`which -a`, but never the
 * current folder: cmd.exe, where.exe and Node's spawn all look there first on
 * Windows, so a repository AgentHouse is started in could otherwise supply its
 * own `claude.cmd`. Empty and relative PATH entries (the current folder in
 * disguise) are skipped too.
 */
export function findOnPath(name: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const dirs = (env.PATH ?? '').split(path.delimiter).map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'));
  const extensions = isWindows ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  const hits: string[] = [];
  for (const dir of dirs) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const ext of extensions) {
      const candidate = path.join(dir, name + ext.toLowerCase());
      if (!hits.includes(candidate) && isExecutableFile(candidate)) hits.push(candidate);
    }
  }
  return hits;
}

/**
 * Turns one PATH hit into something node-pty can spawn directly.
 * Windows npm shims (`foo.cmd`) end with a line such as
 *   "%dp0%\node_modules\pkg\bin\foo.exe"   %*
 * or, for packages whose bin is a script,
 *   "%_prog%"  "%dp0%\node_modules\pkg\bin\foo.js" %*
 * and pnpm's (global installs) with
 *   "%~dp0\node.exe"  "%~dp0\..\pkg\bin\foo.js" %*
 */
export function resolveShim(candidate: string, shimText?: string): Omit<ResolvedCommand, 'shim'> | null {
  if (!isWindows) return { file: candidate, args: [] };
  const ext = path.extname(candidate).toLowerCase();
  if (ext === '.exe') return { file: candidate, args: [] };
  // Extensionless and .ps1 shims are for other shells; the .cmd sibling covers them.
  if (ext !== '.cmd') return null;
  const dir = path.dirname(candidate);
  const text = shimText ?? readFileSync(candidate, 'utf8');
  const targets = [...text.matchAll(/"%(?:dp0%|~dp0)\\([^"]+)"/g)].map((m) => path.join(dir, m[1] ?? ''));
  const exe = targets.find((t) => /\.exe$/i.test(t) && !/\\node\.exe$/i.test(t));
  if (exe && existsSync(exe)) return { file: exe, args: [] };
  const script = targets.find((t) => /\.[cm]?js$/i.test(t));
  if (script && existsSync(script)) return { file: process.execPath, args: [script] };
  return null;
}

/** What makes two installs one: the program and script they run. */
export const installKey = (install: Pick<ResolvedCommand, 'file' | 'args'>) => [install.file, ...install.args].join('\0').toLowerCase();

/** Distinct installs of `name`; the first is the one the user's shell runs. */
export function resolveCli(name: string): ResolvedCommand[] {
  const installs: ResolvedCommand[] = [];
  const seen = new Set<string>();
  for (const hit of findOnPath(name)) {
    const resolved = resolveShim(hit);
    if (!resolved) continue;
    const key = installKey(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    installs.push({ shim: hit, ...resolved });
  }
  return installs;
}

/**
 * A file the user chose to run as a CLI, as node-pty can start it; null if it
 * is not one: a full path to a program (on Windows a .exe, or an npm or pnpm
 * .cmd shim, which is resolved like those found on PATH).
 */
export function resolveChosen(file: string): ResolvedCommand | null {
  if (!path.isAbsolute(file) || !isExecutableFile(file)) return null;
  const resolved = resolveShim(file);
  return resolved ? { shim: file, ...resolved } : null;
}
