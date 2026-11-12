import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { findOnPath, resolveShim } from '../src/web/cli/resolve';

const windowsOnly = { skip: process.platform !== 'win32' };

test('PATH lookup never picks a program from the current folder', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agenthouse-path-'));
  const cwd = process.cwd();
  try {
    const name = 'agenthouse-probe-cli';
    const file = process.platform === 'win32' ? `${name}.cmd` : name;
    const bin = path.join(root, 'bin');
    const repo = path.join(root, 'repo');
    mkdirSync(bin);
    mkdirSync(repo);
    for (const dir of [bin, repo]) writeFileSync(path.join(dir, file), '', { mode: 0o755 });
    process.chdir(repo);
    // An empty and a relative entry both mean "the current folder".
    const env = { PATH: ['', '.', bin].join(path.delimiter), PATHEXT: '.EXE;.CMD' };
    assert.deepEqual(findOnPath(name, env), [path.join(bin, file)]);
  } finally {
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  }
});

test('an npm .cmd shim that wraps a native exe resolves to the exe', windowsOnly, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agenthouse-shim-'));
  try {
    const exe = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    mkdirSync(path.dirname(exe), { recursive: true });
    writeFileSync(exe, '');
    const shim = path.join(dir, 'claude.cmd');
    const text = '@ECHO off\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';
    assert.deepEqual(resolveShim(shim, text), { file: exe, args: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an npm .cmd shim that runs a script resolves to node + script', windowsOnly, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agenthouse-shim-'));
  try {
    const script = path.join(dir, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    mkdirSync(path.dirname(script), { recursive: true });
    writeFileSync(script, '');
    const shim = path.join(dir, 'codex.cmd');
    const text = '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n';
    assert.deepEqual(resolveShim(shim, text), { file: process.execPath, args: [script] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a pnpm .cmd shim (global install) resolves to node + script', windowsOnly, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agenthouse-shim-'));
  try {
    const bin = path.join(dir, 'bin');
    const script = path.join(dir, '@anthropic-ai', 'claude-code', 'cli.js');
    mkdirSync(path.dirname(script), { recursive: true });
    mkdirSync(bin);
    writeFileSync(script, '');
    const shim = path.join(bin, 'claude.cmd');
    const text = [
      '@SETLOCAL',
      '@IF EXIST "%~dp0\\node.exe" (',
      '  "%~dp0\\node.exe"  "%~dp0\\..\\@anthropic-ai\\claude-code\\cli.js" %*',
      ') ELSE (',
      '  node  "%~dp0\\..\\@anthropic-ai\\claude-code\\cli.js" %*',
      ')',
      '',
    ].join('\r\n');
    assert.deepEqual(resolveShim(shim, text), { file: process.execPath, args: [script] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('shims for other shells are skipped', windowsOnly, () => {
  assert.equal(resolveShim('C:\\npm\\claude.ps1', ''), null);
  assert.equal(resolveShim('C:\\npm\\claude', ''), null);
});
