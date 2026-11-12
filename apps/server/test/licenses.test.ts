import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('the license gate reads SPDX expressions as SPDX does, and fails on what it does not allow', () => {
  const run = spawnSync(process.execPath, [path.join(root, 'scripts', 'check-licenses.mjs')], {
    env: { ...process.env, AGENTHOUSE_LICENSES_FIXTURE: path.join(root, 'scripts', 'test', 'license-fixture.json') },
    encoding: 'utf8',
  });
  assert.equal(run.status, 1);
  const refused = [...run.stderr.matchAll(/^\s+(prod|dev)\s+(\S+)@/gm)].map((m) => `${m[1]} ${m[2]}`).sort();
  assert.deepEqual(refused, ['dev bad-agpl-dev', 'prod bad-and-gpl', 'prod bad-gpl', 'prod bad-mpl-in-prod', 'prod bad-unparsed']);
});
