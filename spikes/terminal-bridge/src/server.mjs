#!/usr/bin/env node
// Phase 0 spike: runs CLIs in PTYs and serves them to the browser on 127.0.0.1.
// The security checks are the ones the product needs from day one, because this
// is effectively a remote shell: a per-launch token, a Host allowlist (DNS
// rebinding) and an Origin check on every WebSocket upgrade and state change.
import { execFile } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { resolveCli } from './resolve-cli.mjs';
import { Session } from './session.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const spikeRoot = path.resolve(here, '..');
const repoRoot = path.resolve(spikeRoot, '..', '..');
const require = createRequire(import.meta.url);

const options = parseArgs(process.argv.slice(2));
const token = randomBytes(24).toString('base64url');
const sessions = new Map();
let allowedHosts = new Set();
let allowedOrigins = new Set();

const THEME_COLORS = {
  dark: { foreground: '#e3e2e6', background: '#1a1c1e' },
  light: { foreground: '#1a1c1e', background: '#fdfcff' },
};
let currentColors = THEME_COLORS.dark;

const MESSAGES = {
  ENV_CLI_MISSING: {
    claude: 'Claude Code가 설치되어 있지 않습니다. `npm i -g @anthropic-ai/claude-code` 또는 `claude install`로 설치한 뒤 다시 시도하세요.',
    codex: 'Codex CLI가 설치되어 있지 않습니다. `npm i -g @openai/codex`로 설치하고 `codex login`으로 로그인한 뒤 다시 시도하세요.',
  },
};

function parseArgs(argv) {
  const result = { port: 0, json: false, open: false };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--port') result.port = Number(argv[++i]);
    else if (argv[i] === '--json') result.json = true;
    else if (argv[i] === '--open') result.open = true;
  }
  return result;
}

function windowsBuild() {
  if (process.platform !== 'win32') return null;
  const build = Number(os.release().split('.')[2]);
  return Number.isFinite(build) ? build : null;
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

function tokenMatches(candidate) {
  if (!candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isAuthenticated(req) {
  const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
  return tokenMatches(readCookie(req, 'ah_token')) || tokenMatches(bearer);
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'content-type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readJsonBody(req, limit = 64 * 1024) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(chunk);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const STATIC = {
  '/': [path.join(spikeRoot, 'public', 'index.html'), 'text/html; charset=utf-8'],
  '/app.mjs': [path.join(spikeRoot, 'public', 'app.mjs'), 'text/javascript; charset=utf-8'],
  '/style.css': [path.join(spikeRoot, 'public', 'style.css'), 'text/css; charset=utf-8'],
  '/shared/terminal-responses.mjs': [path.join(here, 'terminal-responses.mjs'), 'text/javascript; charset=utf-8'],
};

const pkgDir = (name) => path.dirname(require.resolve(`${name}/package.json`));
const VENDOR = {
  '/vendor/xterm.mjs': [path.join(pkgDir('@xterm/xterm'), 'lib', 'xterm.mjs'), 'text/javascript; charset=utf-8'],
  '/vendor/xterm.css': [path.join(pkgDir('@xterm/xterm'), 'css', 'xterm.css'), 'text/css; charset=utf-8'],
  '/vendor/addon-fit.mjs': [path.join(pkgDir('@xterm/addon-fit'), 'lib', 'addon-fit.mjs'), 'text/javascript; charset=utf-8'],
  '/vendor/addon-webgl.mjs': [path.join(pkgDir('@xterm/addon-webgl'), 'lib', 'addon-webgl.mjs'), 'text/javascript; charset=utf-8'],
  '/vendor/addon-unicode11.mjs': [path.join(pkgDir('@xterm/addon-unicode11'), 'lib', 'addon-unicode11.mjs'), 'text/javascript; charset=utf-8'],
};

function childEnv() {
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  delete env.AGENTHOUSE_TOKEN;
  return env;
}

async function launchSpec({ preset, extraArgs = [], claudeTheme }) {
  const extra = Array.isArray(extraArgs) ? extraArgs.map(String) : [];
  if (preset === 'fake') {
    return { file: process.execPath, args: [path.join(spikeRoot, 'test', 'fake-agent.mjs'), ...extra] };
  }
  if (preset === 'shell') {
    return process.platform === 'win32'
      ? { file: 'powershell.exe', args: ['-NoLogo', ...extra] }
      : { file: process.env.SHELL || '/bin/bash', args: extra };
  }
  if (preset === 'claude' || preset === 'codex') {
    const [install] = resolveCli(preset);
    if (!install) {
      throw Object.assign(new Error(MESSAGES.ENV_CLI_MISSING[preset]), { status: 409, code: 'ENV_CLI_MISSING' });
    }
    const args = [...install.args];
    let cleanupDir = null;
    if (preset === 'claude' && claudeTheme) {
      // Only the theme is injected here; hooks and statusLine come in M4.
      cleanupDir = await mkdtemp(path.join(os.tmpdir(), 'agenthouse-'));
      const settingsPath = path.join(cleanupDir, 'settings.json');
      await writeFile(settingsPath, JSON.stringify({ theme: String(claudeTheme) }));
      args.push('--settings', settingsPath);
    }
    return { file: install.file, args: [...args, ...extra], cleanupDir };
  }
  throw Object.assign(new Error(`unknown preset: ${preset}`), { status: 400 });
}

async function createSession(body) {
  const spec = await launchSpec(body);
  const session = new Session({
    preset: body.preset,
    file: spec.file,
    args: spec.args,
    cwd: body.cwd || repoRoot,
    env: childEnv(),
    cols: Number(body.cols) || 120,
    rows: Number(body.rows) || 32,
    colors: currentColors,
    useConptyDll: Boolean(body.useConptyDll),
    onExit: () => {
      if (spec.cleanupDir) rm(spec.cleanupDir, { recursive: true, force: true }).catch(() => {});
    },
  });
  sessions.set(session.id, session);
  return session;
}

async function handleApi(req, res, url) {
  if (req.method !== 'GET' && !allowedOrigins.has(req.headers.origin)) {
    send(res, 403, { error: 'origin not allowed' });
    return;
  }
  if (url.pathname === '/api/info' && req.method === 'GET') {
    send(res, 200, {
      platform: process.platform,
      windowsBuild: windowsBuild(),
      node: process.version,
      installs: { claude: resolveCli('claude'), codex: resolveCli('codex') },
    });
    return;
  }
  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    send(res, 200, [...sessions.values()].map((s) => s.info()));
    return;
  }
  if (url.pathname === '/api/sessions' && req.method === 'POST') {
    const session = await createSession(await readJsonBody(req));
    send(res, 201, session.info());
    return;
  }
  const match = url.pathname.match(/^\/api\/sessions\/([\w-]+)$/);
  if (match && req.method === 'DELETE') {
    const session = sessions.get(match[1]);
    if (!session) {
      send(res, 404, { error: 'no such session' });
      return;
    }
    const result = await session.close();
    sessions.delete(session.id);
    send(res, 200, result);
    return;
  }
  send(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    if (!allowedHosts.has(req.headers.host)) {
      send(res, 403, 'host not allowed');
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/' && url.searchParams.has('token')) {
      if (!tokenMatches(url.searchParams.get('token'))) {
        send(res, 401, 'invalid token');
        return;
      }
      send(res, 302, '', {
        location: '/',
        'set-cookie': `ah_token=${token}; HttpOnly; SameSite=Strict; Path=/`,
      });
      return;
    }
    if (!isAuthenticated(req)) {
      send(res, 401, '토큰이 필요합니다. 서버를 시작할 때 출력된 주소로 접속하세요.');
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
      return;
    }
    const file = STATIC[url.pathname] ?? VENDOR[url.pathname];
    if (!file || req.method !== 'GET') {
      send(res, 404, 'not found');
      return;
    }
    send(res, 200, await readFile(file[0]), { 'content-type': file[1] });
  } catch (error) {
    send(res, error.status ?? 500, { error: error.message, code: error.code });
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const reject = (status) => {
    socket.write(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
  };
  if (!allowedHosts.has(req.headers.host)) return reject(403);
  // Browsers do not apply same-origin rules to WebSockets, so the Origin check is
  // what stops any web page from opening a shell here.
  if (!allowedOrigins.has(req.headers.origin)) return reject(403);
  if (!isAuthenticated(req)) return reject(401);
  const url = new URL(req.url, 'http://localhost');
  const session = sessions.get(url.searchParams.get('session'));
  if (url.pathname !== '/ws' || !session) return reject(404);
  wss.handleUpgrade(req, socket, head, (ws) => attachViewer(ws, session));
});

function attachViewer(ws, session) {
  const viewer = session.attach(ws);
  ws.on('message', async (raw) => {
    let message;
    try {
      message = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    switch (message.type) {
      case 'input':
        session.input(String(message.data), { binary: Boolean(message.binary) });
        break;
      case 'resize':
        session.resize(viewer, Number(message.cols), Number(message.rows));
        break;
      case 'claim':
        session.claim(viewer);
        break;
      case 'theme':
        currentColors = THEME_COLORS[message.mode] ?? currentColors;
        for (const s of sessions.values()) s.setColors(currentColors);
        break;
      case 'composer':
        viewer.send({ type: 'composer-result', ...(await session.compose(message)) });
        break;
      default:
        break;
    }
  });
  ws.on('close', () => session.detach(viewer));
}

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32' ? ['explorer.exe', [url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  execFile(cmd, args, { windowsHide: true }, () => {});
}

async function shutdown() {
  await Promise.all([...sessions.values()].map((s) => s.close()));
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(options.port, '127.0.0.1', () => {
  const { port } = server.address();
  allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  allowedOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const url = `http://127.0.0.1:${port}/?token=${token}`;
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ url, port, token })}\n`);
  } else {
    process.stdout.write(`AgentHouse terminal spike: ${url}\n`);
  }
  if (options.open) openBrowser(url);
});
