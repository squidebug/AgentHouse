// Skills and memory are the user's and a folder's, not a session's: every
// session (and sub-agent) of a folder shares them. Kept free of React so it can
// be tested directly.
import type { SessionInfo } from '@agenthouse/protocol';
import { folderName } from './tree';

export interface LibraryFolder {
  cwd: string;
  /** The folder's own name, as the tree heads its sessions with. */
  label: string;
  /** The session the folder's skills and memory are read through: its latest with a conversation, else its latest. */
  sessionId: string;
  /** The skills and commands the folder's sessions ran, by name. */
  used: string[];
}

/**
 * The folders that have a session of a CLI with skills and memory (Claude
 * Code), in the order the sessions are listed.
 */
export function libraryFolders(sessions: SessionInfo[]): LibraryFolder[] {
  const byFolder = new Map<string, SessionInfo[]>();
  for (const session of sessions) {
    if (session.vendor === 'codex') continue;
    byFolder.set(session.cwd, [...(byFolder.get(session.cwd) ?? []), session]);
  }
  return [...byFolder].map(([cwd, list]) => {
    const latest = (candidates: SessionInfo[]) => [...candidates].sort((a, b) => b.startedAt - a.startedAt)[0];
    const through = latest(list.filter((session) => session.transcripts.length > 0)) ?? latest(list)!;
    return { cwd, label: folderName(cwd), sessionId: through.id, used: [...new Set(list.flatMap((session) => session.invoked))] };
  });
}

/** The folder to show first: the one of the session the user is at, else the first. */
export function startFolder(folders: LibraryFolder[], cwd: string | undefined): LibraryFolder | undefined {
  return folders.find((folder) => folder.cwd === cwd) ?? folders[0];
}
