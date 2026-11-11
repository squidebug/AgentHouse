import { Terminal } from '/vendor/xterm.mjs';
import { FitAddon } from '/vendor/addon-fit.mjs';
import { Unicode11Addon } from '/vendor/addon-unicode11.mjs';
import { WebglAddon } from '/vendor/addon-webgl.mjs';
import { isAutoResponse } from '/shared/terminal-responses.mjs';

const $ = (id) => document.getElementById(id);

// ANSI palettes tuned for each background; light mode also raises contrast for
// CLIs that assume a dark terminal.
const THEMES = {
  dark: {
    background: '#1a1c1e', foreground: '#e3e2e6', cursor: '#aac7ff', selectionBackground: '#3a4859',
    black: '#1a1c1e', red: '#ffb4ab', green: '#9ad49a', yellow: '#e6c46a', blue: '#aac7ff', magenta: '#d8bafa', cyan: '#80d4dc', white: '#c3c6cf',
    brightBlack: '#8d9199', brightRed: '#ffdad6', brightGreen: '#b6f0b4', brightYellow: '#ffe08a', brightBlue: '#d6e3ff', brightMagenta: '#eedcff', brightCyan: '#a6f0f8', brightWhite: '#ffffff',
  },
  light: {
    background: '#fdfcff', foreground: '#1a1c1e', cursor: '#3b5f90', selectionBackground: '#d3e3fd',
    black: '#1a1c1e', red: '#ba1a1a', green: '#1d6b2e', yellow: '#7a5900', blue: '#3b5f90', magenta: '#6e4b9e', cyan: '#00696f', white: '#5a5f67',
    brightBlack: '#73777f', brightRed: '#d23b2f', brightGreen: '#2e8540', brightYellow: '#946c00', brightBlue: '#4f78b0', brightMagenta: '#8661b8', brightCyan: '#00838a', brightWhite: '#2e3036',
  },
};

let mode = localStorage.getItem('ah-theme') === 'light' ? 'light' : 'dark';
let ws = null;
let currentSession = null;
let isOwner = false;
let lastStats = {};

const info = await (await fetch('/api/info')).json();

const term = new Terminal({
  allowProposedApi: true,
  cursorBlink: true,
  fontFamily: "'D2Coding', 'JetBrains Mono', 'Cascadia Mono', Consolas, monospace",
  fontSize: 14,
  scrollback: 5000,
  theme: THEMES[mode],
  minimumContrastRatio: mode === 'light' ? 4.5 : 1,
  ...(info.windowsBuild ? { windowsPty: { backend: 'conpty', buildNumber: info.windowsBuild } } : {}),
});
const fit = new FitAddon();
term.loadAddon(fit);
term.loadAddon(new Unicode11Addon());
term.unicode.activeVersion = '11';
term.open($('term'));
try {
  term.loadAddon(new WebglAddon());
} catch {
  // DOM renderer fallback (e.g. WebGL context limit reached)
}

function send(message) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function notice(text) {
  $('notice').textContent = text ?? '';
  $('notice').hidden = !text;
}

const formatRate = (bytes) => (bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB/s` : `${bytes} B/s`);

function renderStatus() {
  if (!currentSession) {
    $('status').textContent = '세션 없음';
    return;
  }
  const s = { ...currentSession, ...lastStats };
  const parts = [s.preset, `PID ${s.pid}`, `${s.cols}×${s.rows}`, formatRate(s.bytesPerSec ?? 0)];
  if ((s.viewers ?? 1) > 1) parts.push(`창 ${s.viewers}`);
  if (!isOwner) parts.push('크기 고정');
  if (s.exit) parts.push(`종료 ${s.exit.exitCode}`);
  $('status').textContent = parts.join(' · ');
}

function applyTheme() {
  document.documentElement.dataset.theme = mode;
  term.options.theme = THEMES[mode];
  term.options.minimumContrastRatio = mode === 'light' ? 4.5 : 1;
  $('theme').textContent = mode === 'light' ? '다크' : '라이트';
  localStorage.setItem('ah-theme', mode);
  send({ type: 'theme', mode });
}

function fitAndReport() {
  const dims = fit.proposeDimensions();
  if (dims && isOwner) send({ type: 'resize', cols: dims.cols, rows: dims.rows });
}

function connect(session) {
  ws?.close();
  currentSession = session;
  lastStats = {};
  isOwner = false;
  ws = new WebSocket(`ws://${location.host}/ws?session=${encodeURIComponent(session.id)}`);
  ws.onopen = () => {
    send({ type: 'theme', mode });
    send({ type: 'claim' });
  };
  ws.onmessage = (event) => {
    const message = JSON.parse(event.data);
    switch (message.type) {
      case 'snapshot':
        term.reset();
        term.resize(message.cols, message.rows);
        term.write(message.data);
        currentSession = { ...currentSession, cols: message.cols, rows: message.rows };
        break;
      case 'output':
        term.write(message.data);
        break;
      case 'size':
        currentSession = { ...currentSession, cols: message.cols, rows: message.rows };
        if (!isOwner) term.resize(message.cols, message.rows);
        break;
      case 'owner':
        isOwner = message.you;
        if (isOwner) fitAndReport();
        break;
      case 'stats':
        lastStats = message;
        break;
      case 'exit':
        currentSession = { ...currentSession, exit: message };
        break;
      case 'composer-result':
        if (!message.sent) notice(`전송 실패: ${message.reason}`);
        break;
      default:
        break;
    }
    renderStatus();
  };
  ws.onclose = () => renderStatus();
}

async function refreshSessions(selectId) {
  const list = await (await fetch('/api/sessions')).json();
  $('sessions').innerHTML = list
    .map((s) => `<option value="${s.id}">${s.preset} · pid ${s.pid}${s.exit ? ' (종료)' : ''}</option>`)
    .join('');
  const chosen = list.find((s) => s.id === selectId) ?? list[0];
  if (chosen) {
    $('sessions').value = chosen.id;
    if (chosen.id !== currentSession?.id) connect(chosen);
  }
  return list;
}

term.onData((data) => {
  // xterm.js answers terminal queries through onData too; the server-side mirror
  // already answered them, so a second reply must not reach the CLI.
  if (isAutoResponse(data)) return;
  send({ type: 'input', data });
});
term.onBinary((data) => send({ type: 'input', data, binary: true }));
term.textarea?.addEventListener('focus', () => send({ type: 'claim' }));
new ResizeObserver(() => {
  if (isOwner) {
    fit.fit();
    fitAndReport();
  }
}).observe($('term'));

$('theme').addEventListener('click', () => {
  mode = mode === 'light' ? 'dark' : 'light';
  applyTheme();
});

$('start').addEventListener('click', async () => {
  notice(null);
  const dims = fit.proposeDimensions() ?? { cols: 120, rows: 32 };
  const response = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      preset: $('preset').value,
      cwd: $('cwd').value.trim() || undefined,
      extraArgs: $('extra').value.trim() ? $('extra').value.trim().split(/\s+/) : [],
      claudeTheme: $('claudeTheme').value || undefined,
      useConptyDll: $('conptyDll').checked,
      cols: dims.cols,
      rows: dims.rows,
    }),
  });
  const body = await response.json();
  if (!response.ok) {
    notice(body.error);
    return;
  }
  await refreshSessions(body.id);
  term.focus();
});

$('sessions').addEventListener('change', async (event) => {
  const list = await (await fetch('/api/sessions')).json();
  const chosen = list.find((s) => s.id === event.target.value);
  if (chosen) connect(chosen);
});

$('kill').addEventListener('click', async () => {
  if (!currentSession) return;
  await fetch(`/api/sessions/${currentSession.id}`, { method: 'DELETE' });
  currentSession = null;
  ws?.close();
  term.reset();
  await refreshSessions();
  renderStatus();
});

function sendComposer() {
  const text = $('text').value;
  if (!text) return;
  send({
    type: 'composer',
    text,
    bracketed: $('bracketed').checked,
    enterDelayMs: Number($('delay').value),
    quietMs: Number($('quiet').value),
    submit: $('submit').checked,
  });
  $('text').value = '';
  term.focus();
}
$('send').addEventListener('click', sendComposer);
$('text').addEventListener('keydown', (event) => {
  // Ignore Enter while an IME (Korean, Japanese, …) is still composing a syllable.
  if (event.isComposing) return;
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    sendComposer();
  }
});

window.addEventListener('beforeunload', (event) => {
  if (currentSession && !currentSession.exit) event.preventDefault();
});

applyTheme();
await refreshSessions();
renderStatus();
