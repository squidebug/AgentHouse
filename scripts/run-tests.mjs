#!/usr/bin/env node
// Runs `node --test` on every *.test.ts in the given folder through tsx.
// Shells on Windows do not expand globs and Node 18/20 `--test` does not either,
// so the file list is built here. Usage: node ../../scripts/run-tests.mjs test
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.argv[2] ?? 'test');
const files = readdirSync(dir)
  .filter((name) => name.endsWith('.test.ts'))
  .sort()
  .map((name) => path.join(dir, name));

if (!files.length) {
  console.error(`테스트 파일이 없습니다: ${dir}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
