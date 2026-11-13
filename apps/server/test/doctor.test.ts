import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { writeAppSettings } from '../src/web/app-settings';
import { formatChecks, outsidePath, type Check } from '../src/web/doctor-command';
import { installFakeClaude } from './helpers';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';

test('checks line up, Hangul taking two columns, with a fix under its check and a sum at the end', () => {
  const checks: Check[] = [
    { level: 'ok', label: 'Node.js', detail: '22.16.0' },
    { level: 'error', label: '상태 폴더', detail: '다른 계정의 폴더입니다.', command: 'pnpm stop' },
    { level: 'warn', label: 'hook', detail: 'x' },
    { level: 'info', label: 'Codex CLI', detail: '없음' },
  ];
  assert.equal(
    formatChecks(checks),
    ['✓ Node.js    22.16.0', '✗ 상태 폴더  다른 계정의 폴더입니다.', '    → pnpm stop', '⚠ hook       x', '· Codex CLI  없음', '', '문제 1개 · 주의 1개', ''].join('\n'),
  );
  assert.match(formatChecks([{ level: 'warn', label: 'a', detail: 'b' }]), /\n\n실행할 수 있음 · 주의 1개\n$/);
  assert.match(formatChecks([{ level: 'ok', label: 'a', detail: 'b' }]), /\n\n실행할 수 있음\n$/);
});

test('an install off the user\'s PATH is found in the usual folders; one on PATH is not reported', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agenthouse-doctor-'));
  const saved = process.env.PATH;
  try {
    const file = path.join(dir, isWindows ? 'claude.cmd' : 'claude');
    writeFileSync(file, '');
    if (!isWindows) chmodSync(file, 0o755);
    process.env.PATH = os.tmpdir();
    assert.deepEqual(outsidePath('claude', [dir]), [file]);
    process.env.PATH = dir;
    assert.deepEqual(outsidePath('claude', [dir]), [], 'the shell runs that one, and so does AgentHouse');
  } finally {
    process.env.PATH = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});

function runDoctor(env: NodeJS.ProcessEnv): { status: number | null; ok: boolean; checks: Check[] } {
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/main.ts', 'doctor', '--json'], { cwd: serverDir, env, encoding: 'utf8', timeout: 60_000 });
  const report = JSON.parse(result.stdout) as { ok: boolean; checks: Check[] };
  return { status: result.status, ...report };
}

test('doctor: without a CLI on PATH it fails; with one, that is the one it reports, logged in', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'agenthouse-doctor-home-'));
  const bin = path.join(home, 'bin');
  mkdirSync(bin);
  // A home of its own, so no real install in the usual folders shows up.
  const base = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData'), AGENTHOUSE_HOME: path.join(home, '.agenthouse') };
  const system = isWindows ? [path.join(process.env.SystemRoot || 'C:\\Windows', 'System32')] : [path.dirname(process.execPath), '/usr/bin', '/bin'];
  try {
    const none = runDoctor({ ...base, PATH: system.join(path.delimiter) });
    assert.equal(none.status, 1);
    assert.equal(none.ok, false);
    assert.ok(none.checks.some((c) => c.level === 'error' && c.label === 'CLI'), JSON.stringify(none.checks));
    assert.ok(none.checks.some((c) => c.label === 'node-pty' && c.level === 'ok'));
    assert.ok(none.checks.some((c) => c.label === '상태 폴더' && c.level === 'ok'), 'a folder not made yet is fine');

    const fake = installFakeClaude(bin);
    const found = runDoctor({ ...base, PATH: [bin, ...system].join(path.delimiter) });
    const claude = found.checks.filter((c) => c.label === 'Claude Code');
    assert.equal(found.status, 0, JSON.stringify(found.checks));
    assert.equal(claude.length, 1);
    assert.equal(claude[0]?.level, 'ok');
    assert.match(claude[0]?.detail ?? '', /^9\.9\.9 · 로그인됨 · .*claude(\.cmd)?$/);

    // Chosen in the environment check: off PATH, it is still the one run, and said so.
    writeAppSettings(base.AGENTHOUSE_HOME, { cli: { claude: fake } });
    const chosen = runDoctor({ ...base, PATH: system.join(path.delimiter) });
    assert.equal(chosen.status, 0, JSON.stringify(chosen.checks));
    assert.match(chosen.checks.find((c) => c.label === 'Claude Code')?.detail ?? '', /^9\.9\.9 · 지정함 · 로그인됨 · /);

    rmSync(bin, { recursive: true, force: true });
    const gone = runDoctor({ ...base, PATH: system.join(path.delimiter) });
    assert.equal(gone.status, 1);
    assert.ok(gone.checks.some((c) => c.label === 'Claude Code' && c.level === 'error' && c.detail.includes('파일이 없습니다')), JSON.stringify(gone.checks));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
