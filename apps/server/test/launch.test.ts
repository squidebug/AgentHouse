import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { buildLaunch, HOOK_EVENTS, LaunchError, sessionTitle } from '../src/cli/launch';
import { versionAtLeast } from '../src/sessions/manager';

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

test('an observed claude session gets relay hooks and keeps the user status line', async () => {
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'agenthouse-claude-config-'));
  await writeFile(path.join(configDir, 'settings.json'), JSON.stringify({ statusLine: { type: 'command', command: 'my-status --short', padding: 1 } }));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    const spec = await buildLaunch({ vendor: 'claude' }, install, cwd, { port: 4321, token: 'secret' });
    const settingsPath = spec.args[spec.args.indexOf('--settings') + 1] ?? '';
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.deepEqual(Object.keys(settings.hooks).sort(), [...HOOK_EVENTS].sort());
    const hook = settings.hooks.Stop[0].hooks[0];
    assert.equal(hook.async, true, 'Claude never waits for AgentHouse');
    assert.match(hook.command, /relay\.cjs' 'hook' '/);
    assert.match(settings.statusLine.command, /relay\.cjs' 'status' '/);
    assert.equal(settings.statusLine.padding, 1, "the user's padding is kept");
    const relayConfig = JSON.parse(readFileSync(path.join(path.dirname(settingsPath), 'relay.json'), 'utf8'));
    assert.deepEqual(relayConfig, { port: 4321, token: 'secret', statusCommand: 'my-status --short' });
    await rm(spec.tempPaths[0] ?? '', { recursive: true, force: true });
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    await rm(configDir, { recursive: true, force: true });
  }
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

test('CLI features are gated by version; an unknown version counts as recent', () => {
  assert.equal(versionAtLeast('2.1.322 (Claude Code)', [2, 1, 145]), true);
  assert.equal(versionAtLeast('2.1.144', [2, 1, 145]), false);
  assert.equal(versionAtLeast('1.0.126 (Claude Code)', [2, 1, 145]), false);
  assert.equal(versionAtLeast(null, [2, 1, 145]), true);
});

test('titles default to the folder name and drop control characters', () => {
  assert.equal(sessionTitle(undefined, 'C:\\work\\web-app'), 'web-app');
  assert.equal(sessionTitle('a\u0007b', cwd), 'ab');
});
