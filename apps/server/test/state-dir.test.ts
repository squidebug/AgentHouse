import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { othersAllowed, stateDirProblem, windowsOthers } from '../src/web/state-dir';
import { tempStateDir } from './helpers';

const me = 'S-1-5-21-1111111111-2222222222-3333333333-1001';

test('a folder only the user, SYSTEM and Administrators get into lets no one else in', () => {
  assert.deepEqual(othersAllowed(`O:${me}G:${me}D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${me})`, me), []);
  assert.deepEqual(othersAllowed(`D:AI(A;OICIID;FA;;;S-1-5-18)(A;OICIIOID;GA;;;CO)(A;OICIID;FA;;;${me})`, me), [], 'numeric SIDs, CREATOR OWNER');
});

test('anyone else an allow entry names is reported; deny entries are not', () => {
  const shared = `O:BAG:SYD:AI(A;OICIID;FA;;;BA)(A;OICIID;0x1200a9;;;BU)(A;OICIIOID;SDGXGWGR;;;AU)(A;OICIID;FA;;;${me})(D;OICI;FA;;;WD)(A;;FR;;;S-1-5-21-9-9-9-1002)`;
  assert.deepEqual(othersAllowed(shared, me), ['BU', 'AU', 'S-1-5-21-9-9-9-1002']);
});

test('POSIX: the state folder loses group and other access', { skip: process.platform === 'win32' }, async () => {
  const dir = await tempStateDir();
  try {
    chmodSync(dir, 0o755);
    assert.equal(await stateDirProblem(dir), null);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Windows: the folder\'s own permissions are read, and an account let in is named', { skip: process.platform !== 'win32' }, async () => {
  const dir = await tempStateDir();
  try {
    assert.equal(await stateDirProblem(dir), null, 'in the profile, like ~/.agenthouse');
    assert.deepEqual(await windowsOthers(dir), [], 'a temporary folder is the user\'s alone');
    // Users (by SID: account names are translated) may read it now.
    execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'icacls.exe'), [dir, '/grant', '*S-1-5-32-545:(OI)(CI)R'], { stdio: 'ignore' });
    assert.deepEqual(await windowsOthers(dir), ['BU']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
