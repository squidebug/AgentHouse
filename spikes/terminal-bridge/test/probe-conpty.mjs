#!/usr/bin/env node
// Diagnostic: shows exactly which bytes ConPTY passes between a CLI and the terminal.
// Prints the escaped PTY output of fake-agent, then what the agent received for a
// bracketed paste with an embedded newline.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pty from 'node-pty';

const spikeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const useConptyDll = process.argv.includes('--conpty-dll');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const term = pty.spawn(process.execPath, [path.join(spikeRoot, 'test', 'fake-agent.mjs')], {
  name: 'xterm-256color',
  cols: 100,
  rows: 30,
  cwd: spikeRoot,
  env: process.env,
  useConptyDll,
});
let output = '';
term.onData((data) => {
  output += data;
});

await sleep(800);
const sawCpr = output.includes('\x1b[6n');
const sawOsc11 = output.includes('\x1b]11;?');
console.log(`ConPTY (${useConptyDll ? 'bundled conpty.dll' : 'built-in'}) forwarded to terminal: DSR 6n=${sawCpr}, OSC 11 query=${sawOsc11}`);
if (sawCpr) term.write('\x1b[7;9R');
if (sawOsc11) term.write('\x1b]11;rgb:ffff/ffff/ffff\x1b\\');
await sleep(2000);

const before = output.length;
term.write('\x1b[200~first line\rsecond line\x1b[201~');
await sleep(600);
term.write('\r');
await sleep(800);

const lines = output
  .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
  .split(/\r?\n/)
  .filter((l) => /REPORT|IN /.test(l))
  .map((l) => l.trim());
console.log(lines.join('\n'));
console.log(`\nraw tail after paste: ${JSON.stringify(output.slice(before)).slice(0, 600)}`);
term.kill();
process.exit(0);
