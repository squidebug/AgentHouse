import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CliInstall, CliStatus } from '@agenthouse/protocol';
import { chosenPath, CUSTOM, initialChoice, SHELL } from '../src/cli-choice';

const install = (shim: string, onPath: boolean): CliInstall => ({ file: shim, args: [], shim, version: '2.1.0', onPath });
const status = (extra: Partial<CliStatus>): CliStatus => ({
  vendor: 'claude',
  installs: [install('C:\\a\\claude.cmd', true), install('C:\\b\\claude.cmd', true)],
  selected: 0,
  loggedIn: true,
  chosen: null,
  ...extra,
});

test('the dialog starts on what runs now: the shell\'s, another install on PATH, or the typed file', () => {
  assert.deepEqual(initialChoice(status({})), { value: SHELL, custom: '' });
  assert.deepEqual(initialChoice(status({ chosen: 'C:\\b\\claude.cmd', selected: 1 })), { value: 'install:1', custom: '' });
  assert.deepEqual(initialChoice(status({ chosen: 'C:\\a\\claude.cmd', selected: 0 })), { value: SHELL, custom: '' }, 'the shell\'s own, chosen');
  const typed = status({ chosen: 'D:\\tools\\claude.exe', selected: 2, installs: [...status({}).installs, install('D:\\tools\\claude.exe', false)] });
  assert.deepEqual(initialChoice(typed), { value: CUSTOM, custom: 'D:\\tools\\claude.exe' });
  assert.deepEqual(initialChoice(status({ chosen: 'D:\\gone.exe', selected: null, chosenError: '파일이 없습니다.' })), { value: CUSTOM, custom: 'D:\\gone.exe' }, 'to correct');
});

test('what each choice saves: null to follow PATH, an install\'s own path, or the typed text', () => {
  const s = status({});
  assert.equal(chosenPath(s, SHELL, 'ignored'), null);
  assert.equal(chosenPath(s, 'install:1', ''), 'C:\\b\\claude.cmd');
  assert.equal(chosenPath(s, CUSTOM, '  D:\\tools\\claude.exe  '), 'D:\\tools\\claude.exe');
});
