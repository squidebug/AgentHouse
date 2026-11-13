import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { HOST_PROTOCOL, type HostState } from './host-protocol';

/** `~/.agenthouse` unless AGENTHOUSE_HOME points elsewhere (tests use a temporary folder). */
export function defaultStateDir(): string {
  return process.env.AGENTHOUSE_HOME || path.join(os.homedir(), '.agenthouse');
}

export const stateFile = (dir: string) => path.join(dir, `host-${HOST_PROTOCOL}.json`);
export const logFile = (dir: string) => path.join(dir, 'logs', 'host.log');
/** Per-session files (settings, relay config) for hosts of this protocol; the host clears it when it starts. */
export const runDir = (dir: string) => path.join(dir, 'run', String(HOST_PROTOCOL));

/** Removes a folder, retrying while Windows still holds a file in it (a CLI that just exited, a relay reading its config). */
export function removeTree(target: string): Promise<void> {
  return rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

function readStateFile(file: string): HostState | null {
  try {
    const state = JSON.parse(readFileSync(file, 'utf8')) as HostState;
    const valid = Number.isInteger(state.protocol) && Number.isInteger(state.pid) && Number.isInteger(state.port) && typeof state.token === 'string';
    return valid ? state : null;
  } catch {
    return null;
  }
}

/** The state of this protocol's host, if one was written. */
export function readState(dir: string): HostState | null {
  const state = readStateFile(stateFile(dir));
  return state?.protocol === HOST_PROTOCOL ? state : null;
}

/** The states of hosts of every protocol version (an older one keeps running its sessions). */
export function readAllStates(dir: string): HostState[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const states: HostState[] = [];
  for (const name of names) {
    const protocol = name.match(/^host-(\d+)\.json$/)?.[1];
    const state = protocol ? readStateFile(path.join(dir, name)) : null;
    if (state && String(state.protocol) === protocol) states.push(state);
  }
  return states;
}

/** Renames over the target, trying again while Windows has it open (a virus scanner, an indexer, a reader). */
function renameOver(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 5 || (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES')) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * (attempt + 1));
    }
  }
}

/**
 * Writes a file of the state folder whole or not at all, readable by the user
 * only: a temporary file beside it, renamed over it, so a reader never sees
 * half a file. One writer per file.
 */
export function writeFileAtomic(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, text, { mode: 0o600 });
  try {
    renameOver(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
}

export const writeJsonFile = (file: string, value: unknown) => writeFileAtomic(file, JSON.stringify(value));

/** Readable only by the user: the token controls every session. */
export function writeState(dir: string, state: HostState): void {
  writeJsonFile(stateFile(dir), state);
}

/** Removes the state file if it still describes this process (a newer host may have replaced it). */
export function clearState(dir: string, pid: number): void {
  if (readState(dir)?.pid === pid) rmSync(stateFile(dir), { force: true });
}

/** The host runs without a console, so it writes what happened to a small log file. */
export const hostLogger = (dir: string) => fileLogger(logFile(dir));

export const webLogFile = (dir: string) => path.join(dir, 'logs', 'web.log');
/** The web server's log: what it could not save and errors nothing else caught, which its console may no longer show. */
export const webLogger = (dir: string) => fileLogger(webLogFile(dir));

/** A file of the state folder could not be written: it stays in memory until the next change, and the log says so. */
export function notSaved(file: string, error: unknown): void {
  webLogger(path.dirname(file))(`${path.basename(file)} not saved: ${(error as Error)?.message ?? error}`);
}

function fileLogger(file: string): (line: string) => void {
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (statSync(file).size > 1024 * 1024) renameSync(file, `${file}.1`);
  } catch {
    // no log yet
  }
  return (line) => {
    try {
      appendFileSync(file, `${new Date().toISOString()} [${process.pid}] ${line}\n`);
    } catch {
      // logging must never take a server down
    }
  };
}
