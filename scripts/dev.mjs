#!/usr/bin/env node
// Development: the server under `tsx watch` and Vite on 5173, sharing one token
// across server restarts. Prints the address to open.
//
// It keeps its own state folder (~/.agenthouse-dev) and port (7358), so it has
// its own session host: stopping or restarting dev never touches the sessions
// of `pnpm start`, including an agent that is working on AgentHouse itself.
//   node scripts/dev.mjs        start
//   node scripts/dev.mjs stop   end the dev sessions and the dev session host
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const DEV_PORT = 7358;
const devEnv = { AGENTHOUSE_HOME: path.join(os.homedir(), '.agenthouse-dev') };
const children = [];

function run(name, args, cwd, extraEnv = {}, filter = () => true) {
  const child = spawn('pnpm', args, { cwd, shell: isWindows, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } });
  const prefix = name ? `[${name}] ` : '';
  const forward = (stream, out) =>
    stream.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) if (line.trim() && filter(line)) out.write(prefix + line + '\n');
    });
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  children.push(child);
  return child;
}

if (process.argv[2] === 'stop') {
  run('', ['exec', 'tsx', 'src/main.ts', '--stop'], path.join(root, 'apps/server'), devEnv);
} else {
  const token = randomBytes(24).toString('base64url');
  const hideToken = (line) => !line.includes(token);
  run(
    'server',
    ['exec', 'tsx', 'watch', 'src/main.ts', '--port', String(DEV_PORT), '--dev-origin', 'http://localhost:5173', '--cwd', root],
    path.join(root, 'apps/server'),
    { ...devEnv, AGENTHOUSE_TOKEN: token },
    hideToken,
  );
  run('web', ['exec', 'vite'], path.join(root, 'apps/web'), { AGENTHOUSE_DEV_SERVER: `http://127.0.0.1:${DEV_PORT}` }, hideToken);

  setTimeout(() => {
    process.stdout.write(`\nAgentHouse (dev)  http://localhost:5173/auth?token=${token}\n`);
    process.stdout.write(`개발용 세션은 ${devEnv.AGENTHOUSE_HOME}의 호스트에서 돕니다. 끝내려면: pnpm dev:stop\n\n`);
  }, 1500);

  const stop = () => {
    for (const child of children) {
      if (isWindows && child.pid) {
        const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
        execFile(taskkill, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
      }
      else child.kill('SIGTERM');
    }
    setTimeout(() => process.exit(0), 500);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
