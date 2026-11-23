// The state folder holds the session host's token and the web server's key, so
// only the user may get into it. Windows ignores POSIX modes: a file takes the
// permissions of its folder, and a folder outside the user's profile (C:\Temp,
// a shared drive) may let other accounts in.
import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Who may have access besides the user: SYSTEM, Administrators, and CREATOR OWNER / OWNER RIGHTS,
// which stand for whoever creates or owns an item (the user, for what AgentHouse writes).
const TRUSTED = new Set(['SY', 'S-1-5-18', 'BA', 'S-1-5-32-544', 'CO', 'S-1-3-0', 'OW', 'S-1-3-4']);
const ALLOW = new Set(['A', 'OA', 'XA', 'ZA']);

/** The accounts other than the user and TRUSTED that an allow entry of this security descriptor (SDDL) lets in. */
export function othersAllowed(sddl: string, userSid: string): string[] {
  // A folder without a list of who may enter lets everyone in. Read through .NET its descriptor has
  // no `D:` part at all; Windows itself writes one that says `NO_ACCESS_CONTROL`.
  if (!sddl.includes('D:') || /D:[^(]*NO_ACCESS_CONTROL/.test(sddl)) return ['WD'];
  const dacl = sddl.match(/D:[^(]*((?:\([^)]*\))*)/)?.[1] ?? '';
  const others = new Set<string>();
  for (const [, type, sid] of dacl.matchAll(/\(([A-Z]+);[^;]*;[^;]*;[^;]*;[^;]*;([^;)]+)/g)) {
    if (ALLOW.has(type!) && sid !== userSid && !TRUSTED.has(sid!)) others.add(sid!);
  }
  return [...others];
}

/** Windows: the accounts besides the user, SYSTEM and Administrators that this folder lets in; null if it cannot tell. */
export function windowsOthers(dir: string): Promise<string[] | null> {
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // The path goes in through the environment, never into the script text. .NET is asked directly,
  // not Get-Acl: a cmdlet is loaded from PSModulePath, and started from PowerShell 7 (a terminal, a
  // CI step) this Windows PowerShell inherits a path with PowerShell 7's modules first, cannot load
  // them, and the check could tell nothing.
  // Each answer says what it is. A folder without a list of who may enter answers with nothing:
  // on a line of its own that could not be told from a folder that was not read at all.
  const script =
    "'acl=' + [IO.Directory]::GetAccessControl($env:AGENTHOUSE_CHECK_DIR).GetSecurityDescriptorSddlForm('Access'); 'me=' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value";
  return new Promise((resolve) => {
    execFile(
      powershell,
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { env: { ...process.env, AGENTHOUSE_CHECK_DIR: dir }, windowsHide: true, timeout: 20_000 },
      (error, stdout) => {
        const lines = String(stdout).split(/\r?\n/).map((line) => line.trim());
        const said = (name: string) => lines.find((line) => line.startsWith(name))?.slice(name.length);
        const sddl = said('acl=');
        const sid = said('me=');
        resolve(error || sddl === undefined || !sid?.startsWith('S-') ? null : othersAllowed(sddl, sid));
      },
    );
  });
}

/**
 * Creates the state folder if needed and makes sure it is the user's alone: null
 * when it is, else what is wrong. POSIX: it must be the user's, and loses group and
 * other access. Windows: a folder in the user's profile is as private as the
 * profile; one elsewhere must let in no one but the user, SYSTEM and Administrators.
 * A check that cannot run does not stop AgentHouse. Without `fix` (the doctor) it
 * changes nothing: a folder not made yet passes, and on POSIX group and other
 * access is left for the start to drop.
 */
export async function stateDirProblem(dir: string, fix = true): Promise<string | null> {
  if (fix) mkdirSync(dir, { recursive: true, mode: 0o700 });
  else if (!existsSync(dir)) return null;
  if (process.platform !== 'win32') {
    const stat = statSync(dir);
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) return '다른 계정의 폴더입니다.';
    if (fix && stat.mode & 0o077) chmodSync(dir, 0o700);
    return null;
  }
  const inside = path.relative(os.homedir(), path.resolve(dir));
  if (!inside.startsWith('..') && !path.isAbsolute(inside)) return null;
  const others = await windowsOthers(dir);
  return others?.length ? `다른 계정도 들어올 수 있습니다: ${others.join(', ')}` : null;
}
