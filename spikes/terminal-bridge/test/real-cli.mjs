#!/usr/bin/env node
// Local canary (never in CI): starts a real CLI through the spike server without
// sending any prompt, prints what its first screen looks like, then exits it the
// way a user would (Ctrl+C twice) and checks nothing is left running.
//   node test/real-cli.mjs [claude|codex] [--conpty-dll] [--wait 6000]
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { isAlive } from '../src/kill-tree.mjs';

const spikeRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const preset = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'claude';
const useConptyDll = process.argv.includes('--conpty-dll');
const waitMs = Number(process.argv[process.argv.indexOf('--wait') + 1]) || 6000;
// --compose-test pastes two lines without pressing Enter and shows the input box.
// The CLI is started with a model name that does not exist, so even if the paste
// were submitted by mistake the request fails instead of using the account.
const composeTest = process.argv.includes('--compose-test');
const bracketed = !process.argv.includes('--no-bracketed');
// --submit-test <ms> also presses Enter <ms> after the paste and reads the session
// transcript to count user messages. The pre-assigned session id lets the test
// delete exactly the transcript it created afterwards.
const submitIndex = process.argv.indexOf('--submit-test');
const submitDelay = submitIndex === -1 ? null : Number(process.argv[submitIndex + 1]) || 0;
const testSessionId = randomUUID();
const safeRun = (composeTest || submitDelay !== null) && preset === 'claude';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const stripEscapes = (text) =>
  text
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?<=>]*[ -/]*[@-~]/g, '\n')
    .replace(/\x1b[()][0-9A-B]/g, '');
const maskPersonal = (text) => text.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>');

function request(port, method, pathname, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathname, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: res.statusCode, headers: res.headers, json: text.startsWith('{') || text.startsWith('[') ? JSON.parse(text) : null, text });
      });
    });
    req.on('error', reject);
    if (body) {
      req.setHeader('content-type', 'application/json');
      req.end(JSON.stringify(body));
    } else req.end();
  });
}

const server = spawn(process.execPath, ['src/server.mjs', '--port', '0', '--json'], { cwd: spikeRoot, stdio: ['ignore', 'pipe', 'inherit'] });
const { port, token } = JSON.parse(await new Promise((resolve) => createInterface({ input: server.stdout }).once('line', resolve)));
const origin = `http://127.0.0.1:${port}`;

try {
  const login = await request(port, 'GET', `/?token=${token}`, {});
  const cookie = login.headers['set-cookie'][0].split(';')[0];
  const extraArgs = safeRun ? ['--model', 'agenthouse-invalid-model', '--session-id', testSessionId] : [];
  const created = await request(port, 'POST', '/api/sessions', { cookie, origin }, { preset, cols: 120, rows: 36, useConptyDll, extraArgs });
  if (created.status !== 201) {
    console.log(`세션을 시작하지 못했습니다 (${created.status}): ${created.json?.error ?? created.text}`);
    process.exitCode = 1;
  } else {
    const session = created.json;
    console.log(`${preset} 실행: ${session.file} (pid ${session.pid}, ConPTY: ${useConptyDll ? 'bundled' : 'built-in'})`);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?session=${session.id}`, { headers: { cookie, origin } });
    const received = [];
    let peakBytesPerSec = 0;
    ws.on('message', (raw) => {
      const message = JSON.parse(raw.toString('utf8'));
      received.push(message);
      if (message.type === 'stats') peakBytesPerSec = Math.max(peakBytesPerSec, message.bytesPerSec);
    });
    await new Promise((resolve) => ws.once('open', resolve));
    ws.send(JSON.stringify({ type: 'claim' }));
    await sleep(waitMs);

    if (composeTest) {
      ws.send(JSON.stringify({ type: 'composer', text: '첫 줄 테스트 AgentHouse\n둘째 줄 테스트 ✓', bracketed, submit: false }));
      await sleep(1500);
    }
    if (submitDelay !== null) {
      ws.send(
        JSON.stringify({ type: 'composer', text: '첫 줄 테스트 AgentHouse\n둘째 줄 테스트 ✓', bracketed, submit: true, enterDelayMs: submitDelay, quietMs: 0 }),
      );
      await sleep(5000);
      const transcript = findTranscript(testSessionId);
      if (!transcript) {
        console.log(`Enter ${submitDelay}ms: 트랜스크립트가 없음 (전송되지 않았거나 기록 전)`);
      } else {
        const userTexts = readFileSync(transcript, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
          .filter((r) => r.type === 'user' && !r.isSidechain)
          .map((r) => (typeof r.message?.content === 'string' ? r.message.content : (r.message?.content ?? []).map((c) => c.text ?? '').join('')))
          .filter((text) => text.includes('테스트'));
        const one = userTexts.length === 1 && userTexts[0].includes('첫 줄') && userTexts[0].includes('둘째 줄');
        console.log(`Enter ${submitDelay}ms: 사용자 메시지 ${userTexts.length}개 ${one ? '(두 줄이 한 메시지로 전송됨)' : JSON.stringify(userTexts)}`);
      }
    }

    // A fresh viewer gets the mirror's view of the screen.
    const probe = new WebSocket(`ws://127.0.0.1:${port}/ws?session=${session.id}`, { headers: { cookie, origin } });
    const snapshot = await new Promise((resolve) => probe.on('message', (raw) => {
      const message = JSON.parse(raw.toString('utf8'));
      if (message.type === 'snapshot') resolve(message.data);
    }));
    probe.close();
    const lines = maskPersonal(stripEscapes(snapshot))
      .split(/\r?\n/)
      .map((l) => l.replace(/\s+$/, ''))
      .filter((l) => l.trim());
    console.log(`\n--- 미러 스냅샷 (텍스트만, ${lines.length}줄 중 앞 30줄) ---`);
    console.log(lines.slice(0, 30).map((l) => l.slice(0, 110)).join('\n'));
    console.log(`--- 끝 --- 시작 직후 최대 출력 ${peakBytesPerSec} B/s, 스냅샷 ${snapshot.length}자\n`);
    if (submitDelay !== null) {
      // Without a transcript, the conversation area shows how the paste was sent.
      const rows = snapshot.split(/\r?\n/).map((row) => stripEscapes(row).replace(/\n+/g, ' ').trim());
      const shown = rows.filter((row) => row.includes('테스트'));
      console.log(`화면의 '테스트' 행 ${shown.length}개:\n  ${shown.join('\n  ')}`);
    }

    if (composeTest) {
      // The mirror's rendered screen, row by row, is what a person would see.
      const screen = await new Promise((resolve) => {
        const viewer = new WebSocket(`ws://127.0.0.1:${port}/ws?session=${session.id}`, { headers: { cookie, origin } });
        viewer.on('message', (raw) => {
          const message = JSON.parse(raw.toString('utf8'));
          if (message.type === 'snapshot') {
            viewer.close();
            resolve(message.data);
          }
        });
      });
      const dumpPath = process.env.AGENTHOUSE_DUMP;
      if (dumpPath) (await import('node:fs')).writeFileSync(dumpPath, screen);
      const plain = stripEscapes(screen).replace(/\n+/g, ' ');
      console.log(`화면에 첫 줄: ${plain.includes('첫 줄 테스트') ? '있음' : '없음'}, 둘째 줄: ${plain.includes('둘째 줄 테스트') ? '있음' : '없음'}, 붙여넣기 자리표시: ${/Pasted text/i.test(plain) ? '있음' : '없음'}`);
      console.log(`요청이 전송된 흔적(API 오류 메시지): ${/API Error|not_found_error|model.*not found|Invalid model/i.test(plain) ? '있음 (첫 줄이 Enter로 처리됨)' : '없음'}`);
    }

    // Exit like a user: Ctrl+C clears the input box first, then two more exit.
    for (const delay of [600, 600, 600]) {
      if (received.some((m) => m.type === 'exit')) break;
      ws.send(JSON.stringify({ type: 'input', data: '\x03' }));
      await sleep(delay);
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && !received.some((m) => m.type === 'exit')) await sleep(100);
    const exit = received.find((m) => m.type === 'exit');
    console.log(exit ? `Ctrl+C 두 번으로 정상 종료 (exit code ${exit.exitCode})` : 'Ctrl+C로 종료되지 않음 → 강제 종료');
    await request(port, 'DELETE', `/api/sessions/${session.id}`, { cookie, origin });
    await sleep(800);
    console.log(`종료 후 프로세스 남음: ${isAlive(session.pid) ? '예 (실패)' : '아니오'}`);
    ws.close();
  }
} finally {
  server.kill();
  if (safeRun) removeTestTranscript(testSessionId);
}

function findTranscript(sessionId) {
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'), 'projects');
  if (!existsSync(projects)) return null;
  for (const dir of readdirSync(projects)) {
    const file = path.join(projects, dir, `${sessionId}.jsonl`);
    if (existsSync(file)) return file;
  }
  return null;
}

/** Deletes only what this test created: <id>.jsonl and the <id>/ folder next to it. */
function removeTestTranscript(sessionId) {
  const file = findTranscript(sessionId);
  if (!file) return;
  rmSync(file, { force: true });
  rmSync(file.replace(/\.jsonl$/, ''), { recursive: true, force: true });
  console.log('테스트가 만든 트랜스크립트를 삭제했습니다.');
}
