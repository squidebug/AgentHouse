import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { buildLaunch, LaunchError, sessionTitle } from '../src/cli/launch';

const install = { file: 'claude.exe', args: [] };
const cwd = process.cwd();

test('only options the user picked become flags', async () => {
  const spec = await buildLaunch({ vendor: 'claude' }, install, cwd);
  assert.deepEqual(spec.args.slice(0, 1), ['--session-id']);
  assert.equal(spec.args.length, 2, 'just the pre-chosen session id');
  assert.match(String(spec.vendorSessionId), /^[0-9a-f-]{36}$/);
});

test('claude options map to its flags', async () => {
  const spec = await buildLaunch(
    { vendor: 'claude', title: '로그인 리팩터링', model: 'opus', effort: 'max', permissionMode: 'plan', theme: 'light' },
    install,
    cwd,
  );
  const args = spec.args.join(' ');
  assert.match(args, /--name 로그인 리팩터링/);
  assert.match(args, /--model opus/);
  assert.match(args, /--effort max/);
  assert.match(args, /--permission-mode plan/);
  const settingsPath = spec.args[spec.args.indexOf('--settings') + 1] ?? '';
  assert.deepEqual(JSON.parse(readFileSync(settingsPath, 'utf8')), { theme: 'light' });
  assert.equal(spec.tempPaths.length, 1);
  assert.ok(settingsPath.startsWith(spec.tempPaths[0] ?? '\0'), 'the settings file is listed for removal');
  await rm(spec.tempPaths[0] ?? '', { recursive: true, force: true });
  assert.equal(existsSync(settingsPath), false);
});

test('codex options map to its flags', async () => {
  const spec = await buildLaunch({ vendor: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, { file: 'codex.exe', args: [] }, cwd);
  assert.deepEqual(spec.args, ['-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="high"']);
  assert.equal(spec.vendorSessionId, null);
});

test('invalid values are refused before anything runs', async () => {
  await assert.rejects(buildLaunch({ vendor: 'claude', effort: 'ultra-max' }, install, cwd), LaunchError);
  await assert.rejects(buildLaunch({ vendor: 'claude', model: 'opus --dangerously-skip-permissions' }, install, cwd), LaunchError);
  await assert.rejects(buildLaunch({ vendor: 'claude', permissionMode: 'bypassPermissions' }, install, cwd), LaunchError);
});

test('titles default to the folder name and drop control characters', () => {
  assert.equal(sessionTitle(undefined, 'C:\\work\\web-app'), 'web-app');
  assert.equal(sessionTitle('a\u0007b', cwd), 'ab');
});
