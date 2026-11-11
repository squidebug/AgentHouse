import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CLAUDE_EFFORTS,
  CLAUDE_PERMISSION_MODES,
  CODEX_EFFORTS,
  type CliInstall,
  type LaunchOptions,
} from '@agenthouse/protocol';

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
  cleanup: () => Promise<void>;
}

// Aliases (opus), full ids (claude-opus-5-5, gpt-6.1-sol) and variants like [1m].
const MODEL_NAME = /^[A-Za-z0-9][\w.:\-[\]]{0,79}$/;
const noCleanup = async () => {};

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
): Promise<LaunchSpec> {
  const title = sessionTitle(opts.title, cwd);
  const args = [...install.args];

  if (opts.vendor === 'claude') {
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

    let cleanup = noCleanup;
    if (opts.theme) {
      // Windows' ConPTY never forwards background-color queries, so Claude's
      // theme detection cannot see the app theme; tell it directly instead.
      const dir = await mkdtemp(path.join(os.tmpdir(), 'agenthouse-'));
      const settingsPath = path.join(dir, 'settings.json');
      await writeFile(settingsPath, JSON.stringify({ theme: opts.theme }));
      args.push('--settings', settingsPath);
      cleanup = () => rm(dir, { recursive: true, force: true });
    }
    return { file: install.file, args, title, vendorSessionId, cleanup };
  }

  if (opts.vendor === 'codex') {
    const chosenModel = model(opts.model);
    if (chosenModel) args.push('-m', chosenModel);
    const effort = pick(opts.effort, CODEX_EFFORTS, 'effort');
    if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
    return { file: install.file, args, title, vendorSessionId: null, cleanup: noCleanup };
  }

  return { file: install.file, args, title, vendorSessionId: null, cleanup: noCleanup };
}
