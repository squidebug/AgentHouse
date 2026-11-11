import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { resolveShim } from '../src/cli/resolve';

const windowsOnly = { skip: process.platform !== 'win32' };

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

test('shims for other shells are skipped', windowsOnly, () => {
  assert.equal(resolveShim('C:\\npm\\claude.ps1', ''), null);
  assert.equal(resolveShim('C:\\npm\\claude', ''), null);
});
