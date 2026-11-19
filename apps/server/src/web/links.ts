import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { LinkKind, SessionLink } from '@agenthouse/protocol';
import { notSaved, writeJsonFile } from '../shared/state';
import { Told, words, type Words } from './words';

const FILE_VERSION = 1;

export const linksFile = (stateDir: string) => path.join(stateDir, 'state.json');

export class LinkError extends Told {
  constructor(
    message: Words | string,
    readonly code: 'NOT_FOUND' | 'INVALID_REQUEST',
  ) {
    super(message);
  }
}

function isLink(value: unknown): value is SessionLink {
  const link = value as Partial<SessionLink> | null;
  return typeof link?.childId === 'string' && typeof link.parentId === 'string' && (link.kind === 'group' || link.kind === 'delegate') && link.childId !== link.parentId;
}

/**
 * Which session the user placed under which, kept by the web server in
 * state.json: unlike the pane layout, it is the same in every browser and
 * outlives restarts. One level only: a parent is never under another session.
 */
export class LinkStore {
  /** By child: a session sits under one parent at most. */
  private readonly links = new Map<string, SessionLink>();

  constructor(private readonly file: string) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown; links?: unknown };
      if (data.version === FILE_VERSION && Array.isArray(data.links)) {
        for (const link of data.links) if (isLink(link)) this.links.set(link.childId, { childId: link.childId, parentId: link.parentId, kind: link.kind });
      }
    } catch {
      // none yet, or unreadable: start over
    }
    // A file edited by hand could nest deeper than the tree shows; such links go.
    for (const link of [...this.links.values()]) if (this.links.has(link.parentId)) this.links.delete(link.childId);
  }

  list(): SessionLink[] {
    return [...this.links.values()];
  }

  /**
   * Places a session under another (`parentId`), or back at the top (null).
   * `known` tells which sessions exist. Returns whether anything changed.
   */
  set(childId: string, parentId: string | null, kind: LinkKind, known: (id: string) => boolean): boolean {
    if (!known(childId)) throw new LinkError(words('세션을 찾을 수 없습니다.', 'The session was not found.'), 'NOT_FOUND');
    if (parentId === null) {
      if (!this.links.delete(childId)) return false;
      this.save();
      return true;
    }
    if (parentId === childId || !known(parentId)) throw new LinkError(words('묶을 세션을 찾을 수 없습니다.', 'The session to go under was not found.'), 'INVALID_REQUEST');
    if (this.links.has(parentId)) throw new LinkError(words('묶인 세션 아래에는 묶을 수 없습니다.', 'Nothing goes under a session that is under another.'), 'INVALID_REQUEST');
    if ([...this.links.values()].some((l) => l.parentId === childId)) throw new LinkError(words('아래에 묶인 세션이 있는 세션은 옮길 수 없습니다.', 'A session with sessions under it cannot be moved.'), 'INVALID_REQUEST');
    const current = this.links.get(childId);
    if (current?.parentId === parentId && current.kind === kind) return false;
    this.links.set(childId, { childId, parentId, kind });
    this.save();
    return true;
  }

  /** Drops the links of sessions that are gone; the sessions under a removed one go back to the top. */
  prune(known: (id: string) => boolean): boolean {
    let changed = false;
    for (const link of [...this.links.values()]) {
      if (known(link.childId) && known(link.parentId)) continue;
      this.links.delete(link.childId);
      changed = true;
    }
    if (changed) this.save();
    return changed;
  }

  private save(): void {
    try {
      writeJsonFile(this.file, { version: FILE_VERSION, links: this.list() });
    } catch (error) {
      // Kept in memory; the next change tries again.
      notSaved(this.file, error);
    }
  }
}
