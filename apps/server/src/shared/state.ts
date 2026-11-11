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

/** Replaced atomically and readable only by the user: the token controls every session. */
export function writeState(dir: string, state: HostState): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temp = `${stateFile(dir)}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
  renameSync(temp, stateFile(dir));
}

/** Removes the state file if it still describes this process (a newer host may have replaced it). */
export function clearState(dir: string, pid: number): void {
  if (readState(dir)?.pid === pid) rmSync(stateFile(dir), { force: true });
}

/** The host runs without a console, so it writes what happened to a small log file. */
export function hostLogger(dir: string): (line: string) => void {
  const file = logFile(dir);
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
      // logging must never take the host down
    }
  };
}
