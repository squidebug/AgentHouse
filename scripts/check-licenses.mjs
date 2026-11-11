#!/usr/bin/env node
// License gate for a public repository (plan §13). Fails when an installed
// dependency's license is outside the allowlist.
//  - Production dependencies end up in what we publish (server code, the bundled
//    web app), so they get the strict list.
//  - Development-only dependencies (build tools, test runners) are not shipped,
//    so weak file-level copyleft such as MPL-2.0 is tolerated there.
// Anything else needs an entry with a reason in scripts/license-exceptions.json.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PROD_ALLOWED = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  '0BSD',
  'CC0-1.0',
  'Unlicense',
  'OFL-1.1', // fonts
  'BlueOak-1.0.0', // permissive, common in small Node utilities
  'Zlib',
]);
const DEV_ALLOWED = new Set([...PROD_ALLOWED, 'MPL-2.0', 'CC-BY-4.0', 'Python-2.0']);

const exceptions = JSON.parse(readFileSync(path.join(root, 'scripts', 'license-exceptions.json'), 'utf8'));

// Tests can supply {"prod": {...}, "dev": {...}} in pnpm's format instead of the real install.
const fixture = process.env.AGENTHOUSE_LICENSES_FIXTURE
  ? JSON.parse(readFileSync(process.env.AGENTHOUSE_LICENSES_FIXTURE, 'utf8'))
  : null;

function list(scope) {
  if (fixture) return fixture[scope] ?? {};
  const flag = scope === 'prod' ? '--prod' : '--dev';
  const out = execSync(`pnpm licenses list --json ${flag}`, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const trimmed = out.trim();
  // pnpm prints a plain message instead of JSON when there is nothing to list.
  return trimmed.startsWith('{') ? JSON.parse(trimmed) : {};
}

/** Evaluates simple SPDX expressions: "A OR B" passes if either passes, "A AND B" needs both. */
function permitted(expression, allowed) {
  const clean = expression.replace(/[()]/g, '').trim();
  if (/ OR /i.test(clean)) return clean.split(/ OR /i).some((part) => permitted(part, allowed));
  if (/ AND /i.test(clean)) return clean.split(/ AND /i).every((part) => permitted(part, allowed));
  return allowed.has(clean.split(/ WITH /i)[0].trim());
}

function isExcepted(name, version) {
  return exceptions.some((e) => e.name === name && (!e.version || e.version === version));
}

const violations = [];
const counts = new Map();
for (const [scope, allowed] of [
  ['prod', PROD_ALLOWED],
  ['dev', DEV_ALLOWED],
]) {
  for (const [license, packages] of Object.entries(list(scope))) {
    for (const pkg of packages) {
      for (const version of pkg.versions) {
        counts.set(license, (counts.get(license) ?? 0) + 1);
        if (!permitted(license, allowed) && !isExcepted(pkg.name, version)) {
          violations.push(`${scope}  ${pkg.name}@${version}  ${license}`);
        }
      }
    }
  }
}

const summary = [...counts].sort((a, b) => b[1] - a[1]).map(([license, n]) => `${license} ${n}`).join(', ');
console.log(`licenses: ${summary || 'no dependencies'}`);
if (violations.length) {
  console.error(`\n허용되지 않은 라이선스 ${violations.length}건 (scripts/license-exceptions.json에 사유와 함께 등록하거나 의존성을 바꾸세요):`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log('license check passed');
