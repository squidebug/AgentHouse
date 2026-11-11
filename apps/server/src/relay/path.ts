import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** relay.cjs sits next to this module in the source tree, and next to main.js in the build. */
export function relayPath(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'relay.cjs');
}
