// What the page tells the user about while they look elsewhere. Kept free of
// React and the DOM so it can be tested directly.
import { isAgentBusy, isAsking, type SessionInfo, type StatusValue } from '@agenthouse/protocol';

/**
 * In a turn: working, or stopped at a dialog of its own. The session host
 * reports at most every 150 ms, so what is left of a turn after its dialog was
 * answered may never arrive as working.
 */
const inTurn = (value: StatusValue | undefined) => value === 'working' || isAsking(value);

/**
 * Sessions whose work ended since the list before: in a turn then, idle now,
 * with no sub-agent still at work. Claude runs sub-agents in the background, so
 * the main conversation is idle while they work and takes a turn of its own for
 * each report: the turn after the last report is the one that ends the work.
 */
export function finished(before: ReadonlyMap<string, StatusValue>, sessions: SessionInfo[]): SessionInfo[] {
  return sessions.filter((s) => inTurn(before.get(s.id)) && s.state === 'running' && s.status.value === 'idle' && !s.agents.some(isAgentBusy));
}

/** What each session was doing, to compare the next list with. */
export const statusesOf = (sessions: SessionInfo[]): Map<string, StatusValue> => new Map(sessions.map((s) => [s.id, s.status.value]));

const DONE_KEY = 'ah-notify-done';

/** Whether this browser was asked to announce finished work; off until the user turns it on. */
export function loadNotifyDone(storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): boolean {
  try {
    return storage?.getItem(DONE_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveNotifyDone(on: boolean, storage: Pick<Storage, 'setItem' | 'removeItem'> | undefined = globalThis.localStorage): void {
  try {
    if (on) storage?.setItem(DONE_KEY, '1');
    else storage?.removeItem(DONE_KEY);
  } catch {
    // private windows and blocked storage: the choice lasts until the page is closed
  }
}
