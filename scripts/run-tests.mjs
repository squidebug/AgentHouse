#!/usr/bin/env node
// Runs `node --test` on every *.test.ts in the given folder through tsx.
// Shells on Windows do not expand globs and Node 18/20 `--test` does not either,
// so the file list is built here. Usage: node ../../scripts/run-tests.mjs test
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import os from 'node:os';
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

// Node starts as many test files at once as there are CPUs, less one. Many of these start session
// hosts and terminals, and fifteen starting together (16 CPUs) made the first seconds too slow for
// limits that hold otherwise: a host started from source did not answer within ten seconds, a CLI's
// first output did not come within five. So at most four at a time; a machine on which Node would
// run fewer keeps its number.
const MOST_AT_ONCE = 4;
const cpus = os.availableParallelism?.() ?? os.cpus().length;
const atOnce = `--test-concurrency=${Math.max(1, Math.min(MOST_AT_ONCE, cpus - 1))}`;
// An older Node 18 may not have the option, and Node refuses to start with one it does not know.
const known = spawnSync(process.execPath, [atOnce, '--version'], { stdio: 'ignore' }).status === 0;

const result = spawnSync(process.execPath, ['--import', 'tsx', '--test', ...(known ? [atOnce] : []), ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
