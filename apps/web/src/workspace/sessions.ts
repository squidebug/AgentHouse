// The session list arrives whole whenever any session changes. Kept free of
// React so it can be tested directly.
import type { SessionInfo } from '@agenthouse/protocol';

/**
 * The new list, with every session that did not change as the object it was
 * before (and the list itself, when none did): what draws one session, or
 * depends on it, can then tell at a glance that it has nothing to do.
 */
export function keepUnchanged(previous: SessionInfo[], next: SessionInfo[]): SessionInfo[] {
  const before = new Map(previous.map((session) => [session.id, session]));
  let same = previous.length === next.length;
  const list = next.map((session, i) => {
    const old = before.get(session.id);
    const kept = old && JSON.stringify(old) === JSON.stringify(session) ? old : session;
    if (kept !== previous[i]) same = false;
    return kept;
  });
  return same ? previous : list;
}
