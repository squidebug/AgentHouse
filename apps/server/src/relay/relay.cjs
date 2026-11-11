#!/usr/bin/env node
'use strict';
// Claude Code runs this for each hook event (`relay.cjs hook <config>`) and as its
// status line (`relay.cjs status <config>`); it hands what it receives to the
// AgentHouse session host. As a hook it prints nothing (hook output can reach the
// model) and always exits 0 (exit code 2 would block a tool). As the status line
// it runs the user's own status line command and prints that output unchanged.
// No dependencies: it starts on every event and must stay fast.
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');

const [mode, configPath] = process.argv.slice(2);
const finish = () => process.exit(0);
process.on('uncaughtException', finish);
// Never outlive a slow host or a stuck status command.
setTimeout(finish, mode === 'status' ? 15000 : 3000).unref();

let config = null;
try {
  config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
} catch {
  // no config: behave as a no-op
}

function post(path, body) {
  return new Promise((resolve) => {
    if (!config || !config.port || !config.token) return resolve();
    const req = http.request(
      {
        host: '127.0.0.1',
        port: config.port,
        path,
        method: 'POST',
        headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json', 'content-length': body.length },
        timeout: 1500,
      },
      (res) => {
        res.resume();
        res.on('end', resolve);
      },
    );
    req.on('error', resolve);
    req.on('timeout', () => {
      req.destroy();
      resolve();
    });
    req.end(body);
  });
}

// The same shell Claude Code runs commands with: Git Bash on Windows, sh elsewhere.
function runStatusCommand(command, input) {
  return new Promise((resolve) => {
    const shell = process.env.SHELL || (process.platform === 'win32' ? 'bash' : '/bin/sh');
    let child;
    try {
      child = spawn(shell, ['-c', command], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    } catch {
      return resolve(Buffer.alloc(0));
    }
    const out = [];
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.on('error', () => resolve(Buffer.alloc(0)));
    child.on('close', () => resolve(Buffer.concat(out)));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

const chunks = [];
process.stdin.on('data', (chunk) => chunks.push(chunk));
process.stdin.on('error', finish);
process.stdin.on('end', async () => {
  const body = Buffer.concat(chunks);
  if (mode !== 'status') {
    await post('/hook', body);
    return finish();
  }
  const posted = post('/status', body);
  const output = config && config.statusCommand ? await runStatusCommand(config.statusCommand, body) : Buffer.alloc(0);
  process.stdout.write(output, async () => {
    await posted;
    finish();
  });
});
