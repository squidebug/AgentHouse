// What the user chose in AgentHouse that outlives the web server: for now, which
// executable runs each CLI. The web server writes the file (one writer); the
// doctor only reads it.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Vendor } from '@agenthouse/protocol';

export interface AppSettings {
  /** Per CLI, the executable to run instead of the one the user's shell runs. */
  cli: Partial<Record<Vendor, string>>;
}

const FILE_VERSION = 1;

export const appSettingsFile = (stateDir: string) => path.join(stateDir, 'settings.json');

/** The settings as saved; a file that is missing, unreadable or of another shape counts as no choice made. */
export function readAppSettings(stateDir: string): AppSettings {
  const cli: AppSettings['cli'] = {};
  try {
    const data = JSON.parse(readFileSync(appSettingsFile(stateDir), 'utf8')) as { version?: unknown; cli?: Record<string, unknown> };
    if (data.version === FILE_VERSION && data.cli && typeof data.cli === 'object') {
      for (const vendor of ['claude', 'codex'] as const) {
        const file = data.cli[vendor];
        if (typeof file === 'string' && path.isAbsolute(file)) cli[vendor] = file;
      }
    }
  } catch {
    // none chosen
  }
  return { cli };
}

/** Replaces the file atomically, readable by the user only. */
export function writeAppSettings(stateDir: string, settings: AppSettings): void {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const file = appSettingsFile(stateDir);
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ version: FILE_VERSION, cli: settings.cli }), { mode: 0o600 });
  renameSync(temp, file);
}
