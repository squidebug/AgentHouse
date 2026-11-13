// `agenthouse doctor`: the app's environment check in the terminal, without
// starting anything, plus what matters before the app can come up at all
// (node-pty, the state folder, the port). It changes nothing and reads no
// credentials: logins are asked of the CLIs themselves.
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { VENDOR_NAMES, type CliStatus, type EnvReport } from '@agenthouse/protocol';
import { gitBashPath } from '../claude/settings';
import { hostBuildId } from '../shared/build';
import { findOnPath } from './cli/resolve';
import { EnvService, INSTALL_COMMAND, LOGIN_COMMAND } from './doctor';
import { hostSummary, olderHosts } from './host-client';
import { webServerAnswering } from './instance';
import { AGENTS_JSON_SINCE, SUBAGENT_STATUS_LINE_SINCE, versionAtLeast } from './manager';
import { stateDirProblem } from './state-dir';

export type CheckLevel = 'ok' | 'info' | 'warn' | 'error';

export interface Check {
  level: CheckLevel;
  label: string;
  detail: string;
  /** What fixes it, to copy. */
  command?: string;
}

export interface DoctorOptions {
  stateDir: string;
  /** The port the web server takes when it is free. */
  port: number;
  /** Ends the session host: `pnpm stop`. */
  stopCommand: string;
  /** Puts AgentHouse's own dependencies back, node-pty among them. */
  installCommand: string;
}

const MARK: Record<CheckLevel, string> = { ok: '✓', info: '·', warn: '⚠', error: '✗' };

// Terminal columns: Hangul and other wide characters take two.
const columns = (text: string) => [...text].reduce((sum, char) => sum + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠]/.test(char) ? 2 : 1), 0);

/** The checks as lines for a terminal, a fix under the line it fixes, and a last line that sums them up. */
export function formatChecks(checks: Check[]): string {
  const width = Math.max(...checks.map((check) => columns(check.label)));
  const lines = checks.flatMap((check) => [
    `${MARK[check.level]} ${check.label}${' '.repeat(width - columns(check.label))}  ${check.detail}`,
    ...(check.command ? [`    → ${check.command}`] : []),
  ]);
  const errors = checks.filter((check) => check.level === 'error').length;
  const warnings = checks.filter((check) => check.level === 'warn').length;
  const summary = errors ? `문제 ${errors}개${warnings ? ` · 주의 ${warnings}개` : ''}` : warnings ? `실행할 수 있음 · 주의 ${warnings}개` : '실행할 수 있음';
  return `${lines.join('\n')}\n\n${summary}\n`;
}

/** Folders where a CLI often lands when its installer did not put it on PATH. */
function usualFolders(): string[] {
  const home = os.homedir();
  // Claude Code's own installer
  const folders = [path.join(home, '.local', 'bin')];
  if (process.platform === 'win32') {
    // npm's global folder unless its prefix was changed
    if (process.env.APPDATA) folders.push(path.join(process.env.APPDATA, 'npm'));
  } else {
    folders.push(path.join(home, '.claude', 'local'), '/opt/homebrew/bin', '/usr/local/bin');
  }
  return folders;
}

/** Installs of a CLI in those folders when the user's PATH does not lead to them. */
export function outsidePath(name: string, folders = usualFolders()): string[] {
  const onPath = new Set(findOnPath(name).map((file) => path.dirname(file).toLowerCase()));
  return findOnPath(name, { ...process.env, PATH: folders.join(path.delimiter) }).filter((file) => !onPath.has(path.dirname(file).toLowerCase()));
}

function cliChecks(status: CliStatus, other: CliStatus): Check[] {
  const name = VENDOR_NAMES[status.vendor];
  if (!status.installs.length) {
    const elsewhere = outsidePath(status.vendor);
    // AgentHouse runs what the user's shell would; this one the shell does not find either.
    if (elsewhere.length) return elsewhere.map((file) => ({ level: 'warn', label: name, detail: `PATH 밖에 있어 쓰지 않음 · ${file}` }));
    // With neither CLI, one line says so for both.
    return other.installs.length ? [{ level: 'info', label: name, detail: '없음', command: INSTALL_COMMAND[status.vendor] }] : [];
  }
  return status.installs.map((install, index): Check => {
    const version = install.version ?? '버전 확인 못 함';
    if (index !== status.selected) return { level: 'info', label: name, detail: `${version} · 쓰지 않음 · ${install.shim}` };
    if (status.loggedIn === false) return { level: 'warn', label: name, detail: `${version} · 로그인 안 됨 · ${install.shim}`, command: LOGIN_COMMAND[status.vendor] };
    return { level: 'ok', label: name, detail: `${version} · ${status.loggedIn ? '로그인됨' : '로그인 확인 못 함'} · ${install.shim}` };
  });
}

/** What an older Claude Code turns off (features are gated by version, the terminal works either way). */
function claudeFeatureChecks(status: CliStatus): Check[] {
  const version = status.selected === null ? null : (status.installs[status.selected]?.version ?? null);
  if (!version) return [];
  const checks: Check[] = [];
  if (!versionAtLeast(version, AGENTS_JSON_SINCE)) {
    checks.push({ level: 'warn', label: 'Claude Code', detail: `${version}: Esc·대화상자 다시 확인 없음 (2.1.145 이상)`, command: 'claude update' });
  }
  if (!versionAtLeast(version, SUBAGENT_STATUS_LINE_SINCE)) {
    checks.push({ level: 'info', label: 'Claude Code', detail: `${version}: 서브에이전트 모델·토큰 없음 (2.1.322 이상)`, command: 'claude update' });
  }
  return checks;
}

function hookCheck(report: EnvReport): Check {
  const problem = report.messages.find((m) => ['ENV_CLAUDE_HOOKS_BLOCKED', 'ENV_CLAUDE_HOOKS_DISABLED', 'ENV_CLAUDE_NO_HOOK_SHELL'].includes(m.id));
  if (problem) return { level: 'warn', label: 'hook', detail: problem.text };
  if (process.platform !== 'win32') return { level: 'ok', label: 'hook', detail: 'sh' };
  const bash = gitBashPath();
  return { level: 'ok', label: 'hook', detail: bash ? `Git Bash · ${bash}` : 'PowerShell · node' };
}

function windowsCheck(build: number | null): Check[] {
  if (build === null) return [];
  if (build < 17763) return [{ level: 'error', label: 'Windows', detail: `빌드 ${build}: ConPTY 없음 (1809, 빌드 17763 이상)` }];
  if (build < 21376) return [{ level: 'warn', label: 'Windows', detail: `빌드 ${build}: 창 크기를 바꾸면 줄을 다시 맞추지 못함 (빌드 21376 이상)` }];
  return [{ level: 'ok', label: 'Windows', detail: `빌드 ${build}` }];
}

function nodePtyCheck(installCommand: string): Check {
  try {
    createRequire(import.meta.url)('node-pty');
    return { level: 'ok', label: 'node-pty', detail: '불러옴' };
  } catch (error) {
    return { level: 'error', label: 'node-pty', detail: `불러오지 못함: ${String((error as Error).message).split('\n')[0]}`, command: installCommand };
  }
}

/** Whether something already listens on the port (127.0.0.1). */
function portTaken(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(true));
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(false)));
  });
}

async function hostChecks(options: DoctorOptions): Promise<Check[]> {
  const checks: Check[] = [];
  const host = await hostSummary(options.stateDir);
  if (!host) checks.push({ level: 'info', label: '세션 호스트', detail: '실행 중 아님 · 시작할 때 띄움' });
  else if (host.build !== hostBuildId()) {
    checks.push({ level: 'warn', label: '세션 호스트', detail: `이전 코드로 실행 중 · 세션 ${host.running}개 · 다시 시작하면 끝남`, command: options.stopCommand });
  } else checks.push({ level: 'ok', label: '세션 호스트', detail: `실행 중 · 세션 ${host.running}개` });
  const older = await olderHosts(options.stateDir);
  if (older) checks.push({ level: 'warn', label: '세션 호스트', detail: `이전 버전 ${older}개 실행 중 · 그 세션은 보이지 않음`, command: options.stopCommand });

  const web = await webServerAnswering(options.stateDir);
  if (web) checks.push({ level: 'ok', label: '웹 서버', detail: `실행 중 · ${web.url}` });
  else if (await portTaken(options.port)) checks.push({ level: 'warn', label: '웹 서버', detail: `포트 ${options.port}을 다른 프로그램이 씀 · 다른 포트로 엶` });
  else checks.push({ level: 'info', label: '웹 서버', detail: `실행 중 아님 · 포트 ${options.port} 비어 있음` });
  return checks;
}

/** Every check, in the order a user would fix them. */
export async function runChecks(options: DoctorOptions): Promise<Check[]> {
  const report = await new EnvService(process.cwd()).report(true);
  const { claude, codex } = report.clis;
  const checks: Check[] = [];

  const node = report.node;
  checks.push(node.eol ? { level: 'warn', label: 'Node.js', detail: `${node.version} · 보안 지원이 끝난 버전` } : { level: 'ok', label: 'Node.js', detail: node.version });
  checks.push(nodePtyCheck(options.installCommand));
  checks.push(...windowsCheck(report.windowsBuild));

  if (!claude.installs.length && !codex.installs.length) {
    checks.push({ level: 'error', label: 'CLI', detail: 'Claude Code 또는 Codex CLI가 필요합니다', command: INSTALL_COMMAND.claude });
  }
  for (const [status, other] of [
    [claude, codex],
    [codex, claude],
  ] as const) {
    checks.push(...cliChecks(status, other));
    if (status.vendor === 'claude' && status.installs.length) checks.push(...claudeFeatureChecks(status), hookCheck(report));
  }

  const folder = await stateDirProblem(options.stateDir, false);
  checks.push(folder ? { level: 'error', label: '상태 폴더', detail: `${folder} · ${options.stateDir}` } : { level: 'ok', label: '상태 폴더', detail: options.stateDir });
  checks.push(...(await hostChecks(options)));
  return checks;
}

/** Prints the checks (or JSON); the exit code is 1 when something keeps AgentHouse from running. */
export async function doctor(options: DoctorOptions & { json: boolean }): Promise<number> {
  const checks = await runChecks(options);
  const ok = !checks.some((check) => check.level === 'error');
  process.stdout.write(options.json ? `${JSON.stringify({ ok, checks }, null, 2)}\n` : formatChecks(checks));
  return ok ? 0 : 1;
}
