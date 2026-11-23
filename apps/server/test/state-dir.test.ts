import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
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
  // No list of who may enter at all is everyone, not no one. .NET leaves the part out; Windows itself writes it so.
  assert.deepEqual(othersAllowed('', me), ['WD']);
  assert.deepEqual(othersAllowed(`O:${me}G:${me}`, me), ['WD']);
  assert.deepEqual(othersAllowed(`O:${me}G:${me}D:NO_ACCESS_CONTROL`, me), ['WD']);
  assert.deepEqual(othersAllowed(`O:${me}G:${me}D:P`, me), [], 'an empty list is no one');
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

test('Windows: a folder with no list of who may enter is everyone\'s, and one that cannot be read is not', { skip: process.platform !== 'win32' }, async () => {
  const dir = await tempStateDir();
  const profile = process.env.USERPROFILE;
  try {
    assert.equal(await windowsOthers(path.join(dir, 'gone')), null, 'nothing to read: it cannot tell');
    // The list is taken off the way the check reads it: Windows PowerShell and .NET, no module.
    execFileSync(
      path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$none = New-Object Security.AccessControl.DirectorySecurity; $none.SetSecurityDescriptorSddlForm('D:NO_ACCESS_CONTROL', 'Access'); [IO.Directory]::SetAccessControl($env:AGENTHOUSE_CHECK_DIR, $none)",
      ],
      { env: { ...process.env, AGENTHOUSE_CHECK_DIR: dir }, stdio: 'ignore' },
    );
    assert.deepEqual(await windowsOthers(dir), ['WD']);
    // And as a start asks: of a folder that is not in the user's profile.
    process.env.USERPROFILE = path.join(dir, 'profile');
    assert.match((await stateDirProblem(dir)) ?? '', /WD/);
  } finally {
    if (profile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = profile;
    await rm(dir, { recursive: true, force: true });
  }
});

test('Windows: they are read when AgentHouse was started from PowerShell 7 too', { skip: process.platform !== 'win32' }, async () => {
  const dir = await tempStateDir();
  const modulePath = process.env.PSModulePath;
  try {
    // What a program started from PowerShell 7 inherits: a module path with PowerShell 7's modules
    // first. Windows PowerShell finds Get-Acl in the one made like this, and cannot load it: its
    // type file says again what Windows PowerShell has built in.
    const module = path.join(dir, 'modules', 'Microsoft.PowerShell.Security');
    mkdirSync(module, { recursive: true });
    writeFileSync(
      path.join(module, 'Microsoft.PowerShell.Security.psd1'),
      '@{ GUID="A94C8C7E-9810-47C0-B8AF-65089C13A35A"; ModuleVersion="7.0.0.0"; CmdletsToExport="Get-Acl"; NestedModules="Microsoft.PowerShell.Security.dll"; TypesToProcess="Security.types.ps1xml" }',
    );
    writeFileSync(
      path.join(module, 'Security.types.ps1xml'),
      '<Types><Type><Name>System.Security.AccessControl.ObjectSecurity</Name><Members><ScriptProperty><Name>Sddl</Name><GetScriptBlock>$null</GetScriptBlock></ScriptProperty></Members></Type></Types>',
    );
    process.env.PSModulePath = `${path.join(dir, 'modules')};${modulePath ?? ''}`;
    assert.deepEqual(await windowsOthers(dir), []);
  } finally {
    if (modulePath === undefined) delete process.env.PSModulePath;
    else process.env.PSModulePath = modulePath;
    await rm(dir, { recursive: true, force: true });
  }
});
