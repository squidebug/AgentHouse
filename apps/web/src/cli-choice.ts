import type { CliStatus } from '@agenthouse/protocol';

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
