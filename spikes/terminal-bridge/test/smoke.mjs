#!/usr/bin/env node
// Drives the spike the way a browser would, with fake-agent instead of a real CLI,
// and prints one line per check. Exit code 1 if any check fails.
import { spawn } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { isAlive } from '../src/kill-tree.mjs';

const spikeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail });
const note = (name, detail) => results.push({ name, ok: null, detail });

function request(port, method, pathname, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path: pathname, headers: { host: `127.0.0.1:${port}`, ...headers } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (body !== undefined) {
      req.setHeader('content-type', 'application/json');
      req.end(JSON.stringify(body));
    } else {
      req.end();
    }
  });
}

function openSocket(port, sessionId, headers) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?session=${sessionId}`, { headers });
    const received = [];
    ws.on('message', (raw) => received.push(JSON.parse(raw.toString('utf8'))));
    ws.on('open', () => resolve({ ws, received, status: 101 }));
    ws.on('unexpected-response', (_req, res) => resolve({ ws: null, received, status: res.statusCode }));
    ws.on('error', () => resolve({ ws: null, received, status: 0 }));
  });
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  return predicate();
}

// ConPTY re-renders the CLI's screen, so plain text is interleaved with cursor
// movement and mode sequences.
const stripEscapes = (text) =>
  text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?<=>]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][0-9A-B]/g, '');

const useConptyDll = process.argv.includes('--conpty-dll');

const textOf = (messages) =>
  messages
    .filter((m) => m.type === 'snapshot' || m.type === 'output')
    .map((m) => m.data)
    .join('');

const server = spawn(process.execPath, ['src/server.mjs', '--port', '0', '--json'], {
  cwd: spikeRoot,
  stdio: ['ignore', 'pipe', 'inherit'],
});
const firstLine = await new Promise((resolve) => createInterface({ input: server.stdout }).once('line', resolve));
const { port, token } = JSON.parse(firstLine);
const origin = `http://127.0.0.1:${port}`;

try {
  // --- security baseline ---
  let res = await request(port, 'GET', '/api/sessions');
  check('토큰 없는 요청 거부 (401)', res.status === 401, `status ${res.status}`);

  res = await request(port, 'GET', `/?token=${token}`, { headers: { host: `evil.example:${port}` } });
  check('허용 목록 밖 Host 거부 (403, DNS rebinding 방어)', res.status === 403, `status ${res.status}`);

  res = await request(port, 'GET', '/?token=wrong');
  check('틀린 토큰 거부 (401)', res.status === 401, `status ${res.status}`);

  res = await request(port, 'GET', `/?token=${token}`);
  const cookie = (res.headers['set-cookie'] ?? [])[0]?.split(';')[0];
  check('토큰 로그인 → HttpOnly 쿠키', res.status === 302 && /HttpOnly/.test(res.headers['set-cookie']?.[0] ?? ''), `status ${res.status}`);

  res = await request(port, 'POST', '/api/sessions', {
    headers: { cookie, origin: 'http://evil.example' },
    body: { preset: 'fake' },
  });
  check('다른 Origin의 세션 생성 거부 (403)', res.status === 403, `status ${res.status}`);

  const assets = ['/', '/app.mjs', '/style.css', '/shared/terminal-responses.mjs', '/vendor/xterm.mjs', '/vendor/xterm.css', '/vendor/addon-fit.mjs', '/vendor/addon-webgl.mjs', '/vendor/addon-unicode11.mjs'];
  const missing = [];
  for (const asset of assets) {
    if ((await request(port, 'GET', asset, { headers: { cookie } })).status !== 200) missing.push(asset);
  }
  check('화면에 필요한 파일 모두 제공', missing.length === 0, missing.join(', '));

  // --- session with nobody watching ---
  res = await request(port, 'POST', '/api/sessions', {
    headers: { cookie, origin },
    body: { preset: 'fake', cols: 100, rows: 30, useConptyDll },
  });
  check('fake-agent 세션 생성', res.status === 201, `status ${res.status}`);
  const session = res.json;
  await sleep(2500); // the fake agent's startup queries time out after 1.5 s

  const rejected = await openSocket(port, session.id, { cookie, origin: 'http://evil.example' });
  check('다른 Origin의 WebSocket 거부 (403, CSWSH 방어)', rejected.status === 403, `status ${rejected.status}`);

  const first = await openSocket(port, session.id, { cookie, origin });
  check('WebSocket 연결', first.status === 101, `status ${first.status}`);
  await waitFor(() => first.received.some((m) => m.type === 'snapshot'), 3000);
  const snapshot = first.received.find((m) => m.type === 'snapshot')?.data ?? '';
  check('나중에 연결해도 이전 화면이 스냅샷으로 보임', snapshot.includes('fake-agent ready'));
  const plain = stripEscapes(snapshot);
  const cpr = plain.match(/REPORT cpr=([\d;]+|timeout)/)?.[1];
  const osc11 = plain.match(/REPORT osc11=(rgb:[0-9a-f/]+|timeout)/i)?.[1];
  check('보는 사람이 없어도 커서 위치 질의에 응답됨 (CLI가 멈추지 않음)', cpr && cpr !== 'timeout', `cpr=${cpr}`);
  note(
    '배경색 질의(OSC 11) 응답',
    osc11 && osc11 !== 'timeout'
      ? `응답됨 ${osc11} — CLI가 앱 테마를 감지할 수 있음`
      : '응답 없음 — 이 ConPTY는 질의를 넘기지 않으므로 Claude 테마는 light-ansi/dark-ansi로 직접 지정',
  );
  const childPid = Number(plain.match(/REPORT child=(\d+)/)?.[1]);

  // --- input path ---
  first.ws.send(JSON.stringify({ type: 'claim' }));
  first.ws.send(JSON.stringify({ type: 'input', data: '\x1b[5;10R' }));
  const korean = '안녕하세요 AgentHouse\n둘째 줄 ✓';
  first.ws.send(JSON.stringify({ type: 'composer', text: korean, bracketed: true, enterDelayMs: 100, quietMs: 100, submit: true }));
  const echoed = await waitFor(() => textOf(first.received).includes('둘째 줄 ✓'), 5000);
  const live = textOf(first.received);
  check('Composer 한글 여러 줄이 그대로 도착', echoed && live.includes('안녕하세요 AgentHouse'));
  note('bracketed paste 표식 도달', live.includes('\\u001b[200~') ? 'CLI에 ESC[200~ … ESC[201~ 그대로 전달됨' : 'ConPTY가 표식을 변환하거나 제거함');
  const sessionsNow = (await request(port, 'GET', '/api/sessions', { headers: { cookie } })).json;
  const dropped = sessionsNow.find((s) => s.id === session.id)?.droppedReplies ?? 0;
  check('브라우저가 만든 자동 응답은 서버에서 버림', dropped >= 1 && !live.includes('5;10R'), `dropped=${dropped}`);

  // --- reconnect ---
  first.ws.close();
  await sleep(200);
  const second = await openSocket(port, session.id, { cookie, origin });
  await waitFor(() => second.received.some((m) => m.type === 'snapshot'), 3000);
  const again = second.received.find((m) => m.type === 'snapshot')?.data ?? '';
  check('재접속 시 같은 화면 복원', again.includes('둘째 줄 ✓') && again.includes('fake-agent ready'));

  // --- shutdown leaves nothing behind ---
  res = await request(port, 'DELETE', `/api/sessions/${session.id}`, { headers: { cookie, origin } });
  await sleep(1000);
  check('세션 종료 후 CLI 프로세스 없음', res.status === 200 && !isAlive(session.pid), `pid ${session.pid}`);
  check('세션 종료 후 손자 프로세스(MCP 서버 역할)도 없음', Number.isFinite(childPid) && !isAlive(childPid), `pid ${childPid}`);
  second.ws?.close();
} finally {
  server.kill();
}

let failed = 0;
console.log(`ConPTY: ${useConptyDll ? 'node-pty에 포함된 conpty.dll' : 'Windows 기본'} · Node ${process.version}\n`);
for (const r of results) {
  const mark = r.ok === null ? 'INFO' : r.ok ? 'PASS' : 'FAIL';
  if (r.ok === false) failed += 1;
  console.log(`${mark.padEnd(4)}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
}
console.log(failed ? `\n${failed}개 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
