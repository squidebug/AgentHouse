import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// What the session host runs, relative to apps/server/src during development
// (AGENTS.md lists the same). Built, all of it is in dist/host.js.
const HOST_SOURCES = ['host', 'shared', 'claude/status.ts', 'claude/settings.ts', 'claude/agents.ts', '../../../packages/protocol/src'];

function filesUnder(entry: string): string[] {
  let stats;
  try {
    stats = statSync(entry);
  } catch {
    return [];
  }
  if (stats.isFile()) return [entry];
  return readdirSync(entry)
    .sort()
    .flatMap((name) => filesUnder(path.join(entry, name)));
}

/** A short hash of these files' names and contents. */
export function buildIdOf(root: string, entries: string[]): string {
  const hash = createHash('sha256');
  for (const entry of entries) {
    for (const file of filesUnder(path.resolve(root, entry))) {
      hash.update(path.relative(root, file).replace(/\\/g, '/'));
      hash.update('\0');
      hash.update(readFileSync(file));
      hash.update('\0');
    }
  }
  return hash.digest('hex').slice(0, 12);
}

/**
 * Identifies the code a session host runs. The host reports the id it started
 * with; a web server computes it again from the files on disk now, so a
 * different id means the host still runs older code.
 */
export function hostBuildId(): string {
  const here = fileURLToPath(import.meta.url);
  if (!here.endsWith('.ts')) return buildIdOf(path.dirname(here), ['host.js']);
  return buildIdOf(path.resolve(path.dirname(here), '..'), HOST_SOURCES);
}
