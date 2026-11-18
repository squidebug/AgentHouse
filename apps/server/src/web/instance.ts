// One web server per state folder. Two would each write sessions.json,
// state.json and delegations.json whole, undoing each other's groups and
// delegations and handing an answer over twice; a second start opens the
// first one's address instead.
import { readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { isAlive } from '../shared/kill-tree';
import { notSaved, writeJsonFile } from '../shared/state';

export interface WebServerRecord {
  pid: number;
  port: number;
  /** Its address, without a login code. */
  url: string;
  /** What it takes from local tools, e.g. to give out a login address (the file is the user's alone, like the host's). */
  key: string;
}

export const webServerFile = (stateDir: string) => path.join(stateDir, 'web.json');

function read(stateDir: string): WebServerRecord | null {
  try {
    const record = JSON.parse(readFileSync(webServerFile(stateDir), 'utf8')) as Partial<WebServerRecord>;
    const valid = typeof record.pid === 'number' && typeof record.port === 'number' && typeof record.url === 'string' && typeof record.key === 'string';
    return valid ? (record as WebServerRecord) : null;
  } catch {
    return null;
  }
}

/** An address that logs a browser in to the web server on this port, if one listens there and takes this key. */
function loginAddress(port: number, key: string): Promise<string | null> {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/auth/code', headers: { authorization: `Bearer ${key}` }, timeout: 2000 }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const url = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { url?: unknown }).url;
          resolve(res.statusCode === 200 && typeof url === 'string' ? url : null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

/**
 * The web server already serving this state folder, if one runs and answers, with
 * an address that logs a browser in to it; a record left by one that ended is ignored.
 */
export async function runningWebServer(stateDir: string): Promise<(WebServerRecord & { loginUrl: string }) | null> {
  const record = read(stateDir);
  if (!record || record.pid === process.pid || !isAlive(record.pid)) return null;
  const loginUrl = await loginAddress(record.port, record.key);
  return loginUrl ? { ...record, loginUrl } : null;
}

/** The web server serving this state folder, if one runs and takes its key; unlike runningWebServer, it asks for nothing. */
export function webServerAnswering(stateDir: string): Promise<WebServerRecord | null> {
  const record = read(stateDir);
  if (!record || record.pid === process.pid || !isAlive(record.pid)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: record.port, path: '/api/auth', headers: { authorization: `Bearer ${record.key}` }, timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200 ? record : null);
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
  });
}

/** Notes this web server for a later start to find; replaced atomically, readable by the user only. */
export function recordWebServer(stateDir: string, record: Omit<WebServerRecord, 'pid'>): void {
  try {
    writeJsonFile(webServerFile(stateDir), { pid: process.pid, ...record });
  } catch (error) {
    // Unrecorded: a second start then runs a second server, as before.
    notSaved(webServerFile(stateDir), error);
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
  const running = await webServerAnswering(stateDir);
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
