import { VENDOR_NAMES, type CliStatus, type EnvMessage, type EnvReport, type Vendor } from '@agenthouse/protocol';
import { t } from './strings';

/** Radio values of the executable dialog: follow PATH, a typed file, or `install:<index>`. */
export const SHELL = 'shell';
export const CUSTOM = 'custom';

/**
 * Where the dialog starts: the file chosen (one of those on PATH, or typed), else
 * the shell's. The first install on PATH is the shell's, so choosing it is shown
 * as following PATH; a chosen file that cannot run is shown typed, to correct.
 */
export function initialChoice(status: CliStatus): { value: string; custom: string } {
  if (!status.chosen) return { value: SHELL, custom: '' };
  const install = status.selected === null ? undefined : status.installs[status.selected];
  if (install?.onPath) return { value: status.selected === firstOnPath(status) ? SHELL : `install:${status.selected}`, custom: '' };
  return { value: CUSTOM, custom: status.chosen };
}

/** The path to save for a radio value: null to follow PATH again. */
export function chosenPath(status: CliStatus, value: string, custom: string): string | null {
  if (value === SHELL) return null;
  if (value === CUSTOM) return custom.trim();
  return status.installs[Number(value.slice('install:'.length))]?.shim ?? null;
}

export function firstOnPath(status: CliStatus): number {
  return status.installs.findIndex((install) => install.onPath);
}

/** What stops the start screen: errors and warnings. Notes (no Codex, an old Node) stay in the environment check. */
export function startupIssues(env: EnvReport): EnvMessage[] {
  return env.messages.filter((message) => message.level !== 'info');
}

/**
 * An issue as one line of the start screen: a short label (the server's
 * sentence otherwise), the CLI it is about, and whether 변경 fixes it.
 */
export function describeIssue(message: EnvMessage): { label: string; vendor: Vendor | null; change: boolean } {
  const match = /^ENV_(CLAUDE|CODEX)_(.+)$/.exec(message.id);
  const vendor = match ? (match[1]!.toLowerCase() as Vendor) : null;
  const cli = vendor ? VENDOR_NAMES[vendor] : '';
  const kind = match?.[2] ?? message.id;
  const labels: Record<string, string> = {
    ENV_NO_CLI: t.issue.noCli,
    CHOSEN_UNUSABLE: t.issue.fileUnusable(cli),
    NOT_LOGGED_IN: t.issue.loggedOut(cli),
    HOOKS_BLOCKED: t.issue.hooksBlocked,
    HOOKS_DISABLED: t.issue.hooksOff,
    NO_HOOK_SHELL: t.issue.noHookShell,
    ENV_HOST_OUTDATED: t.issue.hostOutdated,
    ENV_HOST_OLDER_VERSION: t.issue.hostOlder,
  };
  return { label: labels[kind] ?? message.text, vendor, change: kind === 'CHOSEN_UNUSABLE' };
}
