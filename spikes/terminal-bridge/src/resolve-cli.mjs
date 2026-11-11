// Resolves the real executable behind an npm shim, so the PTY's child is the CLI
// itself rather than cmd.exe. That keeps its pid comparable with the one
// `claude agents --json` reports and avoids cmd.exe argument quoting.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const isWindows = process.platform === 'win32';

/** Every location the shell would consider for `name`, in PATH order. */
export function findOnPath(name) {
  try {
    const out = execFileSync(isWindows ? 'where.exe' : 'which', isWindows ? [name] : ['-a', name], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Turns one PATH hit into something node-pty can spawn directly.
 * Windows npm shims (`foo.cmd`) end with a line such as
 *   "%dp0%\node_modules\pkg\bin\foo.exe"   %*
 * or, for packages whose bin is a script,
 *   "%_prog%"  "%dp0%\node_modules\pkg\bin\foo.js" %*
 */
export function resolveShim(candidate) {
  if (!isWindows) return { file: candidate, args: [] };
  const ext = path.extname(candidate).toLowerCase();
  if (ext === '.exe') return { file: candidate, args: [] };
  // Extensionless and .ps1 shims are for other shells; the .cmd sibling covers them.
  if (ext !== '.cmd') return null;
  const dir = path.dirname(candidate);
  const text = readFileSync(candidate, 'utf8');
  const targets = [...text.matchAll(/"%dp0%\\([^"]+)"/g)].map((m) => path.join(dir, m[1]));
  const exe = targets.find((t) => /\.exe$/i.test(t) && !/\\node\.exe$/i.test(t));
  if (exe && existsSync(exe)) return { file: exe, args: [] };
  const script = targets.find((t) => /\.[cm]?js$/i.test(t));
  if (script && existsSync(script)) return { file: process.execPath, args: [script] };
  return null;
}

/** Distinct installs of `name`; the first is the one a shell would run. */
export function resolveCli(name) {
  const installs = [];
  const seen = new Set();
  for (const hit of findOnPath(name)) {
    const resolved = resolveShim(hit);
    if (!resolved) continue;
    const key = [resolved.file, ...resolved.args].join('\0').toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    installs.push({ shim: hit, ...resolved });
  }
  return installs;
}
