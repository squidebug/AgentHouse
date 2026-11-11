import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CLAUDE_EFFORTS,
  CLAUDE_PERMISSION_MODES,
  CODEX_EFFORTS,
  type CliInstall,
  type LaunchOptions,
} from '@agenthouse/protocol';
import { relayPath } from '../../relay/path';
import { STATUS_EVENTS } from '../../claude/status';
import { userStatusLine } from '../../claude/settings';
import { findOnPath } from './resolve';

export class LaunchError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 400,
    readonly command?: string,
  ) {
    super(message);
  }
}

export interface LaunchSpec {
  file: string;
  args: string[];
  title: string;
  vendorSessionId: string | null;
  /** Temporary files the CLI reads while it runs; whoever runs it removes them when it ends. */
  tempPaths: string[];
}

// Aliases (opus), full ids (claude-opus-5-5, gpt-6.1-sol) and variants like [1m].
const MODEL_NAME = /^[A-Za-z0-9][\w.:\-[\]]{0,79}$/;

function pick<T extends string>(value: string | undefined, allowed: readonly T[], label: string): T | undefined {
  if (!value) return undefined;
  if (!(allowed as readonly string[]).includes(value)) throw new LaunchError(`${label} 값이 올바르지 않습니다: ${value}`, 'INVALID_OPTION');
  return value as T;
}

function model(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!MODEL_NAME.test(value)) throw new LaunchError(`모델 이름이 올바르지 않습니다: ${value}`, 'INVALID_OPTION');
  return value;
}

/** Where the relay delivers a session's hook events and status line: the session host. */
export interface ObserveTarget {
  port: number;
  token: string;
}

// The events the status reads, plus the sub-agent events for the agent tree.
// All run async, so Claude never waits for AgentHouse; each one starts the
// relay once, so events nobody reads are left out.
export const HOOK_EVENTS: readonly string[] = [...STATUS_EVENTS, 'SubagentStart', 'SubagentStop'];

function shellQuote(value: string): string {
  return `'${value.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
}

/**
 * The relay's command line. Claude runs hook and status line commands with
 * Git Bash on Windows (PowerShell when Git Bash is missing) and sh elsewhere.
 * A bare `node` with double-quoted paths reads the same in all of them. Only
 * when node is not on PATH is its absolute path used, quoted for bash and sh.
 */
function relayCommand(mode: 'hook' | 'status', configPath: string): string {
  const files = [relayPath(), configPath].map((p) => p.replace(/\\/g, '/'));
  if (findOnPath('node').length && files.every((p) => !/["$`]/.test(p))) return `node "${files[0]}" ${mode} "${files[1]}"`;
  return [process.execPath, relayPath(), mode, configPath].map(shellQuote).join(' ');
}

/**
 * Hooks and a status line that pass everything to the session host through the
 * relay. The user's own status line keeps showing: the relay runs it.
 */
async function observeSettings(dir: string, target: ObserveTarget, cwd: string): Promise<Record<string, unknown>> {
  const userLine = userStatusLine(cwd);
  const configPath = path.join(dir, 'relay.json');
  const config = { port: target.port, token: target.token, ...(userLine ? { statusCommand: userLine.command } : {}) };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const hook = [{ hooks: [{ type: 'command', command: relayCommand('hook', configPath), async: true }] }];
  return {
    statusLine: { type: 'command', command: relayCommand('status', configPath), ...(userLine?.padding !== undefined ? { padding: userLine.padding } : {}) },
    hooks: Object.fromEntries(HOOK_EVENTS.map((name) => [name, hook])),
  };
}

export function sessionTitle(title: string | undefined, cwd: string): string {
  const clean = (title ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80);
  return clean || path.basename(cwd) || cwd;
}

/**
 * Builds the command line for one session. Only what the user picked in the
 * launcher becomes a flag; everything else stays whatever their CLI config says.
 */
export async function buildLaunch(
  opts: LaunchOptions,
  install: Pick<CliInstall, 'file' | 'args'>,
  cwd: string,
  { observe, tempRoot = os.tmpdir() }: { observe?: ObserveTarget; tempRoot?: string } = {},
): Promise<LaunchSpec> {
  const title = sessionTitle(opts.title, cwd);
  const args = [...install.args];

  // The test double takes the same flags and reports the way Claude Code does.
  if (opts.vendor === 'claude' || opts.vendor === 'fake') {
    // A pre-chosen id makes the transcript path known before the CLI writes it.
    const vendorSessionId = randomUUID();
    args.push('--session-id', vendorSessionId);
    if (opts.title) args.push('--name', title);
    const chosenModel = model(opts.model);
    if (chosenModel) args.push('--model', chosenModel);
    const effort = pick(opts.effort, CLAUDE_EFFORTS, 'effort');
    if (effort) args.push('--effort', effort);
    const mode = pick(opts.permissionMode, CLAUDE_PERMISSION_MODES, '권한 모드');
    if (mode) args.push('--permission-mode', mode);

    const tempPaths: string[] = [];
    if (opts.theme || observe) {
      await mkdir(tempRoot, { recursive: true, mode: 0o700 });
      const dir = await mkdtemp(path.join(tempRoot, 'agenthouse-'));
      tempPaths.push(dir);
      const settings: Record<string, unknown> = {};
      // Windows' ConPTY never forwards background-color queries, so Claude's
      // theme detection cannot see the app theme; tell it directly instead.
      if (opts.theme) settings.theme = opts.theme;
      if (observe) Object.assign(settings, await observeSettings(dir, observe, cwd));
      const settingsPath = path.join(dir, 'settings.json');
      await writeFile(settingsPath, JSON.stringify(settings));
      args.push('--settings', settingsPath);
    }
    return { file: install.file, args, title, vendorSessionId, tempPaths };
  }

  if (opts.vendor === 'codex') {
    const chosenModel = model(opts.model);
    if (chosenModel) args.push('-m', chosenModel);
    const effort = pick(opts.effort, CODEX_EFFORTS, 'effort');
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    return { file: install.file, args, title, vendorSessionId: null, tempPaths: [] };
  }

  return { file: install.file, args, title, vendorSessionId: null, tempPaths: [] };
}
