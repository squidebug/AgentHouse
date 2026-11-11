#!/usr/bin/env node
// Diagnostic: a timeline of terminal queries and replies through ConPTY, to see who
// asks (ConPTY itself or the CLI), what blocks startup, and whether the CLI gets
// the replies. Pass --conpty-dll for node-pty's bundled ConPTY, --silent to never reply.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';

const spikeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const useConptyDll = process.argv.includes('--conpty-dll');
const silent = process.argv.includes('--silent');
const start = Date.now();
const log = (text) => console.log(`${String(Date.now() - start).padStart(5)} ms  ${text}`);

const REPLIES = [
  [/\x1b\[6n/g, () => '\x1b[11;21R', 'DSR 6n (cursor position)'],
  [/\x1b\[0?c/g, () => '\x1b[?61;4;22c', 'DA1 (device attributes)'],
  [/\x1b\]11;\?(?:\x07|\x1b\\)/g, () => '\x1b]11;rgb:ffff/ffff/ffff\x1b\\', 'OSC 11 (background color)'],
];

const term = pty.spawn(process.execPath, [path.join(spikeRoot, 'test', 'fake-agent.mjs')], {
  name: 'xterm-256color',
  cols: 100,
  rows: 30,
  cwd: spikeRoot,
  env: process.env,
  useConptyDll,
});
term.onData((data) => {
  log(`raw ${JSON.stringify(data).slice(0, 160)}`);
  for (const [pattern, reply, label] of REPLIES) {
    for (const _ of data.matchAll(pattern)) {
      if (silent) {
        log(`  query ${label} (not answering)`);
      } else {
        log(`  query ${label} -> reply ${JSON.stringify(reply())}`);
        term.write(reply());
      }
    }
  }
});
setTimeout(() => {
  term.kill();
  process.exit(0);
}, 3500);
