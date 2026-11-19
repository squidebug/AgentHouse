import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { CliStatus, EnvReport } from '@agenthouse/protocol';
import { appSettingsFile, readAppSettings, writeAppSettings } from '../src/web/app-settings';
import { resolveChosen } from '../src/web/cli/resolve';
import { installFakeClaude, login, request, startServer, type TestServer } from './helpers';

const isWindows = process.platform === 'win32';
let app: TestServer;
let headers: Record<string, string>;
let scratch: string;

before(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), 'agenthouse-cli-choice-'));
  app = await startServer();
  headers = { authorization: await login(app), origin: `http://127.0.0.1:${app.port}` };
});

after(async () => {
  await app.close();
  await rm(scratch, { recursive: true, force: true });
});

test('the CLIs are looked for where the server was told: nowhere for a test, unless it names the folder of a stand-in', async () => {
  // Told of no folder, it finds none of the CLIs installed on this machine, and so runs none.
  const none = (await request(app.port, 'GET', '/api/env', { headers })).json as EnvReport;
  assert.deepEqual([none.clis.claude.installs, none.clis.codex.installs], [[], []]);
  assert.ok(none.messages.some((m) => m.id === 'ENV_NO_CLI'), JSON.stringify(none.messages));

  const bin = path.join(scratch, 'on-path');
  const fake = installFakeClaude(bin, '2.1.401');
  const own = await startServer({ cliPath: [path.join(scratch, 'empty'), bin].join(path.delimiter) });
  try {
    const { claude, codex } = ((await request(own.port, 'GET', '/api/env', { headers: { authorization: `Bearer ${own.key}` } })).json as EnvReport).clis;
    assert.deepEqual(claude.installs.map((install) => [install.shim, install.version, install.onPath]), [[fake, '2.1.401', true]]);
    assert.deepEqual([claude.selected, claude.loggedIn, claude.chosen, codex.installs], [0, true, null, []]);
  } finally {
    await own.close();
  }
});

test('the settings file keeps a full path per CLI; anything else reads as no choice', () => {
  const dir = path.join(scratch, 'settings');
  assert.deepEqual(readAppSettings(dir), { cli: {}, external: true }, 'no file');
  writeAppSettings(dir, { cli: { claude: path.join(scratch, 'claude.exe') }, external: true });
  assert.deepEqual(readAppSettings(dir), { cli: { claude: path.join(scratch, 'claude.exe') }, external: true });
  for (const text of ['not json', JSON.stringify({ version: 2, cli: { claude: '/x' } }), JSON.stringify({ version: 1, cli: { claude: 'relative', codex: 7 } })]) {
    writeFileSync(appSettingsFile(dir), text);
    assert.deepEqual(readAppSettings(dir), { cli: {}, external: true }, text);
  }
});

test('the settings file keeps the sessions started elsewhere turned off, next to the chosen CLI', () => {
  const dir = path.join(scratch, 'settings-external');
  const claude = path.join(scratch, 'claude.exe');
  writeAppSettings(dir, { cli: { claude }, external: false });
  assert.deepEqual(readAppSettings(dir), { cli: { claude }, external: false });
  assert.deepEqual(JSON.parse(readFileSync(appSettingsFile(dir), 'utf8')), { version: 1, cli: { claude }, external: false });
  // On is how it comes: nothing is written for it, and anything but `false` reads as on.
  writeAppSettings(dir, { cli: {}, external: true });
  assert.deepEqual(JSON.parse(readFileSync(appSettingsFile(dir), 'utf8')), { version: 1, cli: {} });
  writeFileSync(appSettingsFile(dir), JSON.stringify({ version: 1, cli: {}, external: 'no' }));
  assert.equal(readAppSettings(dir).external, true);
});

test('a chosen file runs only as a full path to a program', () => {
  const fake = installFakeClaude(path.join(scratch, 'resolve'));
  const resolved = resolveChosen(fake);
  assert.equal(resolved?.shim, fake);
  if (isWindows) assert.deepEqual(resolved?.args, [path.join(scratch, 'resolve', 'node_modules', 'fake-claude', 'cli.js')], 'an npm shim, resolved');
  assert.equal(resolveChosen(path.basename(fake)), null, 'relative');
  assert.equal(resolveChosen(path.join(scratch, 'missing.exe')), null);
  if (isWindows) {
    const script = path.join(scratch, 'claude.ps1');
    writeFileSync(script, 'claude @args');
    assert.equal(resolveChosen(script), null, 'a PowerShell script');
  }
});

test('a file chosen in the environment check is checked by running it, then launched; null follows PATH again', async () => {
  const fake = installFakeClaude(path.join(scratch, 'bin'), '2.1.400');
  const choose = (body: unknown) => request(app.port, 'PUT', '/api/cli/claude', { headers, body });

  const refused = async (body: unknown, pattern: RegExp) => {
    const res = await choose(body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal((res.json as { code: string }).code, 'INVALID_CLI');
    assert.match((res.json as { error: string }).error, pattern);
  };
  await refused({ path: 'claude' }, /전체 경로/);
  await refused({ path: path.join(scratch, 'nothing', 'claude.exe') }, /파일이 없습니다/);
  await refused({ path: process.execPath }, /Claude Code가 아닙니다/);

  // Pasted as Explorer's "Copy as path" gives it, in quotes.
  const res = await choose({ path: `"${fake}"` });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  const status = res.json as CliStatus;
  assert.equal(status.chosen, fake);
  assert.deepEqual([status.installs[status.selected!]?.version, status.installs[status.selected!]?.onPath, status.loggedIn], ['2.1.400', false, true]);
  const env = (await request(app.port, 'GET', '/api/env', { headers })).json as EnvReport;
  assert.equal(env.clis.claude.chosen, fake);
  assert.ok(!env.messages.some((m) => m.level === 'error'), JSON.stringify(env.messages));

  // Gone since: the launch looks again and refuses, rather than running something else.
  await rm(path.join(scratch, 'bin'), { recursive: true, force: true });
  const launch = await request(app.port, 'POST', '/api/sessions', { headers, body: { vendor: 'claude' } });
  assert.equal(launch.status, 409);
  assert.equal((launch.json as { code: string }).code, 'ENV_CLI_CHOSEN_UNUSABLE');
  const after = (await request(app.port, 'GET', '/api/env', { headers })).json as EnvReport;
  assert.deepEqual([after.clis.claude.selected, after.clis.claude.chosenError], [null, '파일이 없습니다.']);
  assert.ok(after.messages.some((m) => m.id === 'ENV_CLAUDE_CHOSEN_UNUSABLE' && m.level === 'error'));
  // A page that speaks English is told the same in English: the check's sentences, and a refusal.
  const english = { ...headers, 'accept-language': 'en' };
  const said = (await request(app.port, 'GET', '/api/env', { headers: english })).json as EnvReport;
  assert.equal(said.clis.claude.chosenError, 'There is no such file.');
  assert.equal(said.messages.find((m) => m.id === 'ENV_CLAUDE_CHOSEN_UNUSABLE')?.text, 'The file chosen for Claude Code cannot be used. There is no such file.');
  assert.equal(after.messages.find((m) => m.id === 'ENV_CLAUDE_CHOSEN_UNUSABLE')?.text, '지정한 Claude Code 실행 파일을 쓸 수 없습니다. 파일이 없습니다.');
  const refusedInEnglish = await request(app.port, 'POST', '/api/sessions', { headers: english, body: { vendor: 'claude' } });
  assert.deepEqual([refusedInEnglish.status, (refusedInEnglish.json as { error: string }).error], [409, 'The file chosen for Claude Code cannot be used. There is no such file.']);
  assert.equal((launch.json as { error: string }).error, '지정한 Claude Code 실행 파일을 쓸 수 없습니다. 파일이 없습니다.');

  const reset = await choose({ path: null });
  assert.equal(reset.status, 200);
  assert.equal((reset.json as CliStatus).chosen, null);
  assert.deepEqual(readAppSettings(app.stateDir), { cli: {}, external: true });
});

test('only known CLIs, only from the page\'s own origin', async () => {
  assert.equal((await request(app.port, 'PUT', '/api/cli/gemini', { headers, body: { path: null } })).status, 404);
  assert.equal((await request(app.port, 'PUT', '/api/cli/claude', { headers: { ...headers, origin: 'http://evil.example' }, body: { path: null } })).status, 403);
  assert.equal((await request(app.port, 'PUT', '/api/cli/claude', { headers: { origin: headers.origin! }, body: { path: null } })).status, 401);
});
