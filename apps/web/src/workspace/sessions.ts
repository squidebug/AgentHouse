// The session list arrives whole whenever any session changes. Kept free of
// React so it can be tested directly.
import type { SessionInfo } from '@agenthouse/protocol';

/**
 * An ended session its CLI can start again where the conversation stopped: Claude Code keeps a
 * conversation under an id (`--resume`). Codex has a way of its own, not looked into yet.
 */
export const canResume = (session: Pick<SessionInfo, 'state' | 'vendor' | 'transcripts'>): boolean =>
  session.state === 'exited' && session.vendor !== 'codex' && Boolean(session.transcripts.at(-1)?.vendorSessionId);

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
