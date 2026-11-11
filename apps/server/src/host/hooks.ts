import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AccountLimits } from '@agenthouse/protocol';
import { limitsFrom, type HookEvent, type StatusLineInput } from '../claude/status';
import type { ClaudeObserver } from './observer';

// Hook events carry tool input and output; a huge one is dropped, not buffered.
const MAX_EVENT_BYTES = 8 * 1024 * 1024;

export interface RelayInbox {
  /** The observer whose hook token this is. */
  find(token: string): ClaudeObserver | undefined;
  /** Plan usage from a status line: account-wide, the latest from any session. */
  limits(update: Omit<AccountLimits, 'vendor'>): void;
}

/**
 * POST /hook and /status from a session's relay. The hook token picks the
 * session; browsers (which always send Origin) are refused like on /control.
 * Returns false for any other request, which the caller answers.
 */
export function receiveFromRelay(req: IncomingMessage, res: ServerResponse, inbox: RelayInbox): boolean {
  const route = req.method === 'POST' ? req.url : undefined;
  if (route !== '/hook' && route !== '/status') return false;
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  const observer = req.headers.origin === undefined && bearer ? inbox.find(bearer) : undefined;
  if (!observer) {
    res.writeHead(401);
    res.end();
    req.resume();
    return true;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  req.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size <= MAX_EVENT_BYTES) chunks.push(chunk);
  });
  req.on('end', () => {
    res.writeHead(size > MAX_EVENT_BYTES ? 413 : 204);
    res.end();
    if (size > MAX_EVENT_BYTES) return;
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return;
    }
    if (!payload || typeof payload !== 'object') return;
    if (route === '/hook') {
      observer.onHook(payload as HookEvent);
      return;
    }
    observer.onStatusLine(payload as StatusLineInput);
    const update = limitsFrom(payload as StatusLineInput);
    if (update) inbox.limits(update);
  });
  return true;
}
