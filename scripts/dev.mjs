#!/usr/bin/env node
// Development: the server under `tsx watch` on 7357 and Vite on 5173, sharing one
// token across server restarts. Prints the address to open.
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const token = randomBytes(24).toString('base64url');
const isWindows = process.platform === 'win32';
const children = [];

function run(name, args, cwd, extraEnv = {}) {
  const child = spawn('pnpm', args, { cwd, shell: isWindows, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } });
  const prefix = `[${name}] `;
  const forward = (stream, out) =>
    stream.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) if (line.trim() && !line.includes(token)) out.write(prefix + line + '\n');
    });
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  children.push(child);
  return child;
}

run('server', ['exec', 'tsx', 'watch', 'src/main.ts', '--port', '7357', '--dev-origin', 'http://localhost:5173', '--cwd', root], path.join(root, 'apps/server'), {
  AGENTHOUSE_TOKEN: token,
});
run('web', ['exec', 'vite'], path.join(root, 'apps/web'));

setTimeout(() => {
  process.stdout.write(`\nAgentHouse (dev)  http://localhost:5173/auth?token=${token}\n\n`);
}, 1500);

function stop() {
  for (const child of children) {
    if (isWindows && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    else child.kill('SIGTERM');
  }
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
