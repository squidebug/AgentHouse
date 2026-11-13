import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { CliInstall, CliStatus, EnvReport } from '@agenthouse/protocol';
import { chosenPath, CUSTOM, describeIssue, initialChoice, issueKey, SHELL, startupIssues, stopsStartup } from '../src/cli-choice';

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

test('the start screen stops for errors and warnings, not for notes', () => {
  const env = (levels: Array<'error' | 'warn' | 'info'>) => ({ messages: levels.map((level, i) => ({ id: `M${i}`, level, text: level })) }) as unknown as EnvReport;
  assert.deepEqual(startupIssues(env(['info', 'info'])), []);
  assert.deepEqual(
    startupIssues(env(['info', 'warn', 'error'])).map((m) => m.level),
    ['warn', 'error'],
  );
});

test('a warning stops the start screen once; an error, and a warning that says something new, every time', () => {
  const message = (id: string, level: 'error' | 'warn' | 'info', text = id) => ({ id, level, text });
  const env = (...messages: ReturnType<typeof message>[]) => ({ messages }) as unknown as EnvReport;
  const loggedOut = message('ENV_CODEX_NOT_LOGGED_IN', 'warn');
  assert.equal(stopsStartup(env(loggedOut), []), true);
  assert.equal(stopsStartup(env(loggedOut), [issueKey(loggedOut)]), false, 'the user went on past it before');
  assert.equal(stopsStartup(env(message('ENV_CODEX_NOT_LOGGED_IN', 'warn', 'other words')), [issueKey(loggedOut)]), true);
  assert.equal(stopsStartup(env(loggedOut, message('ENV_HOST_OUTDATED', 'warn')), [issueKey(loggedOut)]), true, 'one of them is new');
  const noCli = message('ENV_NO_CLI', 'error');
  assert.equal(stopsStartup(env(noCli), [issueKey(noCli)]), true, 'nothing runs without it');
  assert.equal(stopsStartup(env(message('ENV_NODE_EOL', 'info')), []), false);
});

test('an issue on the start screen is a short line, with 변경 when the chosen file is the problem', () => {
  const issue = (id: string, text = 'the server says') => describeIssue({ id, level: 'error', text });
  assert.deepEqual(issue('ENV_CLAUDE_CHOSEN_UNUSABLE'), { label: 'Claude Code 실행 파일을 쓸 수 없음', vendor: 'claude', change: true });
  assert.deepEqual(issue('ENV_CODEX_NOT_LOGGED_IN'), { label: 'Codex CLI 로그인 필요', vendor: 'codex', change: false });
  assert.deepEqual(issue('ENV_NO_CLI'), { label: 'Claude Code 또는 Codex 필요', vendor: null, change: false });
  assert.deepEqual(issue('ENV_HOST_OUTDATED'), { label: '세션 호스트가 이전 코드', vendor: null, change: false });
  assert.deepEqual(issue('ENV_SOMETHING_NEW', '새 문제'), { label: '새 문제', vendor: null, change: false }, 'the server\'s own words otherwise');
});
