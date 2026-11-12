// One web server per state folder. Two would each write sessions.json,
// state.json and delegations.json whole, undoing each other's groups and
// delegations and handing an answer over twice; a second start opens the
// first one's address instead.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { isAlive } from '../shared/kill-tree';

export interface WebServerRecord {
  pid: number;
  port: number;
  /** The address to open, login token included (the file is the user's alone, like the host's). */
  url: string;
  token: string;
}

export const webServerFile = (stateDir: string) => path.join(stateDir, 'web.json');

function read(stateDir: string): WebServerRecord | null {
  try {
    const record = JSON.parse(readFileSync(webServerFile(stateDir), 'utf8')) as Partial<WebServerRecord>;
    const valid = typeof record.pid === 'number' && typeof record.port === 'number' && typeof record.url === 'string' && typeof record.token === 'string';
    return valid ? (record as WebServerRecord) : null;
  } catch {
    return null;
  }
}

/** Whether a web server listens on this port and takes this token: the login answers with a redirect and a cookie. */
function answers(port: number, token: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: `/auth?token=${encodeURIComponent(token)}`, timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 302 && Boolean(res.headers['set-cookie']));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

/** The web server already serving this state folder, if one runs and answers; a record left by one that ended is ignored. */
export async function runningWebServer(stateDir: string): Promise<WebServerRecord | null> {
  const record = read(stateDir);
  if (!record || record.pid === process.pid || !isAlive(record.pid)) return null;
  return (await answers(record.port, record.token)) ? record : null;
}

/** Notes this web server for a later start to find; replaced atomically, readable by the user only. */
export function recordWebServer(stateDir: string, record: Omit<WebServerRecord, 'pid'>): void {
  try {
    mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    const file = webServerFile(stateDir);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify({ pid: process.pid, ...record }), { mode: 0o600 });
    renameSync(temp, file);
  } catch {
    // unrecorded: a second start then runs a second server, as before
  }
}

/** Removes the note when that web server (this one by default) ends, unless another one has written its own since. */
export function forgetWebServer(stateDir: string, pid = process.pid): void {
  if (read(stateDir)?.pid !== pid) return;
  rmSync(webServerFile(stateDir), { force: true });
}

/**
 * Ends the web server serving this state folder, before its host goes: it
 * would start a new host the moment the old one is gone. True if one ran.
 */
export async function stopWebServer(stateDir: string): Promise<boolean> {
  const running = await runningWebServer(stateDir);
  if (!running) return false;
  try {
    process.kill(running.pid);
  } catch {
    // already gone
  }
  for (let i = 0; i < 60 && isAlive(running.pid); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  forgetWebServer(stateDir, running.pid);
  return true;
}
