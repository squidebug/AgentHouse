import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SessionInfo } from '@agenthouse/protocol';
import { libraryFolders, startFolder } from '../src/workspace/library';

const session = (id: string, cwd: string, extra: Partial<SessionInfo> = {}) => ({ id, vendor: 'claude', cwd, startedAt: 0, transcripts: [], invoked: [], ...extra }) as unknown as SessionInfo;
const talked = [{ vendorSessionId: 'x', path: 'x.jsonl', since: 0 }];

test("skills and memory are a folder's: one entry per folder, in the order the sessions are listed", () => {
  const folders = libraryFolders([
    session('a', 'C:\\work\\api', { startedAt: 1, invoked: ['loop'] }),
    session('b', '/home/me/web', { startedAt: 2 }),
    session('c', 'C:\\work\\api', { startedAt: 3, invoked: ['deploy', 'loop'] }),
    session('codex', '/home/me/other', { vendor: 'codex' }),
  ]);
  assert.deepEqual(
    folders.map((f) => [f.cwd, f.label, f.sessionId, f.used]),
    [
      ['C:\\work\\api', 'api', 'c', ['loop', 'deploy']],
      ['/home/me/web', 'web', 'b', []],
    ],
    "a folder's latest session stands for it, what any of its sessions ran is used, and a CLI without skills has no entry",
  );
});

test('a folder is read through its latest session that has a conversation, when one has', () => {
  const folders = libraryFolders([session('old', '/w', { startedAt: 1, transcripts: talked }), session('new', '/w', { startedAt: 2 })]);
  assert.equal(folders[0]?.sessionId, 'old', 'the listing of skills is in a transcript');
  assert.equal(libraryFolders([session('one', '/w', { startedAt: 1, transcripts: talked }), session('two', '/w', { startedAt: 2, transcripts: talked })])[0]?.sessionId, 'two');
  // A session started outside AgentHouse names its transcript before anything is in it: one of AgentHouse's own goes first.
  const outside = session('outside', '/w', { startedAt: 3, transcripts: talked, external: true });
  assert.equal(libraryFolders([session('own', '/w', { startedAt: 1, transcripts: talked }), outside])[0]?.sessionId, 'own');
  assert.deepEqual(libraryFolders([outside]).map((f) => [f.cwd, f.sessionId]), [['/w', 'outside']], 'a folder only such a session runs in has its skills and memory too');
});

test("the window opens on the folder of the session the user is at, else on the first", () => {
  const folders = libraryFolders([session('a', '/one'), session('b', '/two')]);
  assert.equal(startFolder(folders, '/two')?.cwd, '/two');
  assert.equal(startFolder(folders, '/gone')?.cwd, '/one');
  assert.equal(startFolder(folders, undefined)?.cwd, '/one');
  assert.equal(startFolder([], '/one'), undefined);
});
