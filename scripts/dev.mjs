#!/usr/bin/env node
// Development: the server under `tsx watch` and Vite on 5173. Prints the address
// to open, with the one-time login code the server gives out on every start; a
// page that logged in stays logged in across server restarts (the dev host keeps
// its login secret).
//
// It keeps its own state folder (~/.agenthouse-dev) and port (7358), so it has
// its own session host: stopping or restarting dev never touches the sessions
// of `pnpm start`, including an agent that is working on AgentHouse itself.
//   node scripts/dev.mjs        start
//   node scripts/dev.mjs stop   end the dev sessions and the dev session host
import { execFile, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const DEV_PORT = 7358;
const server = path.join(root, 'apps/server');
const web = path.join(root, 'apps/web');
const devEnv = { AGENTHOUSE_HOME: path.join(os.homedir(), '.agenthouse-dev') };
const children = [];

/** The command-line script of a package as one app has it installed. */
function bin(pkg, app) {
  const require = createRequire(path.join(app, 'package.json'));
  const manifest = require(`${pkg}/package.json`);
  const entry = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin[pkg];
  return path.join(path.dirname(require.resolve(`${pkg}/package.json`)), entry);
}

/**
 * Runs a package's script (tsx, vite) with node itself: no shell and no pnpm in
 * between, which would split or rewrite a folder path with spaces. Each output
 * line goes through `map` (null drops it).
 */
function run(name, pkg, args, cwd, extraEnv = {}, map = (line) => line) {
  const child = spawn(process.execPath, [bin(pkg, cwd), ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...extraEnv } });
  const prefix = name ? `[${name}] ` : '';
  const forward = (stream, out) =>
    stream.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const shown = line.trim() ? map(line) : null;
        if (shown !== null) out.write(shown.startsWith('\n') ? shown : prefix + shown + '\n');
      }
    });
  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);
  children.push(child);
  return child;
}

if (process.argv[2] === 'stop') {
  run('', 'tsx', ['src/main.ts', '--stop'], server, devEnv);
} else {
  let noted = false;
  // The server's own address becomes Vite's, which serves the page and passes the API on.
  const login = /^AgentHouse\s+http:\/\/127\.0\.0\.1:\d+\/(\?code=\S+)$/;
  const showLogin = (line) => {
    const match = login.exec(line.trim());
    if (!match) return line;
    const note = noted ? '' : `개발용 세션은 ${devEnv.AGENTHOUSE_HOME}의 호스트에서 돕니다. 끝내려면: pnpm dev:stop\n`;
    noted = true;
    return `\nAgentHouse (dev)  http://localhost:5173/${match[1]}\n${note}\n`;
  };
  run('server', 'tsx', ['watch', 'src/main.ts', '--port', String(DEV_PORT), '--dev-origin', 'http://localhost:5173', '--cwd', root], server, devEnv, showLogin);
  run('web', 'vite', [], web, { AGENTHOUSE_DEV_SERVER: `http://127.0.0.1:${DEV_PORT}` });

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
