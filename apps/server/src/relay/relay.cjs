#!/usr/bin/env node
'use strict';
// Claude Code runs this for each hook event (`relay.cjs hook <config>`), as its
// status line (`relay.cjs status <config>`) and as its sub-agent status line
// (`relay.cjs subagent <config>`); it hands what it receives to the AgentHouse
// session host. As a hook it prints nothing (hook output can reach the model) and
// always exits 0 (exit code 2 would block a tool). As a status line it runs the
// user's own command for it and prints that output unchanged; with none, the
// sub-agent status line prints nothing and Claude keeps its own rows.
// No dependencies: it starts on every event and must stay fast.
const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');

const [mode, configPath] = process.argv.slice(2);
const finish = () => process.exit(0);
process.on('uncaughtException', finish);
const statusLine = mode === 'status' || mode === 'subagent';
// Never outlive a slow host or a stuck status command.
setTimeout(finish, statusLine ? 15000 : 3000).unref();

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

// The shell Claude Code runs commands with: Git Bash on Windows (the one the
// user named for Claude in CLAUDE_CODE_GIT_BASH_PATH, else where Git installs
// it; PowerShell when it is missing), sh elsewhere. Always by absolute path,
// never a bare name that could run a same-named file from the current folder.
function shellFor(command) {
  if (process.env.SHELL && path.isAbsolute(process.env.SHELL)) return [process.env.SHELL, ['-c', command]];
  if (process.platform !== 'win32') return ['/bin/sh', ['-c', command]];
  const named = process.env.CLAUDE_CODE_GIT_BASH_PATH;
  const bases = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && `${process.env.LOCALAPPDATA}\\Programs`];
  const installed = bases.filter(Boolean).map((base) => `${base}\\Git\\bin\\bash.exe`);
  const bash = [...(named && path.isAbsolute(named) ? [named] : []), ...installed].find((file) => fs.existsSync(file));
  if (bash) return [bash, ['-c', command]];
  const powershell = `${process.env.SystemRoot || 'C:\\Windows'}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  return [powershell, ['-NoProfile', '-NonInteractive', '-Command', command]];
}

function runStatusCommand(command, input) {
  return new Promise((resolve) => {
    const [shell, args] = shellFor(command);
    let child;
    try {
      child = spawn(shell, args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
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
  if (!statusLine) {
    await post('/hook', body);
    return finish();
  }
  const posted = post(mode === 'subagent' ? '/subagents' : '/status', body);
  const command = config && (mode === 'subagent' ? config.subagentCommand : config.statusCommand);
  const output = command ? await runStatusCommand(command, body) : Buffer.alloc(0);
  process.stdout.write(output, async () => {
    await posted;
    finish();
  });
});
