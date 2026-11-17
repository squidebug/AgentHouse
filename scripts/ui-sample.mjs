// A made-up ended Claude Code session for the UI check: a registry entry as an
// earlier session host would have left it in sessions.json, and its two
// transcripts (before and after /clear) in Claude's format. Synthetic content only.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ANSWER = `## 정리한 내용

- 설치 순서를 위로 옮겼습니다.
- \`pnpm dev\` 설명을 짧게 줄였습니다.

| 항목 | 전 | 후 |
|---|---|---|
| 줄 수 | 212 | 148 |
| 제목 | 9 | 6 |

\`\`\`sh
pnpm install
pnpm build
\`\`\`

테스트 하나가 실패합니다. 자세한 내용은 [문서](https://example.com/docs)를 보세요.`;

const REPORT = `**구조 요약**

1. \`apps/server\`: 웹 서버와 세션 호스트
2. \`apps/web\`: React 화면
3. \`packages/protocol\`: 공통 타입`;

/**
 * Made-up Claude Code sessions started outside AgentHouse (a terminal, an editor): the list the fake
 * agent prints in place of `claude agents --json` (agents.json in the config folder), and the
 * transcripts of the two that were asked something, where Claude would write them. One waits for an
 * approval, one works, one was only just started. Returns the entries of the list.
 */
export function writeOutsideSessions({ config, cwd, other }) {
  const now = Date.now();
  let n = 0;
  const transcript = (session, records) => {
    const dir = path.join(config, 'projects', session.cwd.replace(/[^A-Za-z0-9]/g, '-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${session.sessionId}.jsonl`), records.map((record) => `${JSON.stringify(record)}\n`).join(''));
  };
  const writer = (session, model, effort, start) => {
    let clock = start;
    const at = (seconds = 3) => new Date((clock += seconds * 1000)).toISOString();
    const base = { cwd: session.cwd, sessionId: session.sessionId, version: '2.1.326', userType: 'external', entrypoint: 'cli', isSidechain: false };
    const usage = (output) => ({ input_tokens: 6, cache_read_input_tokens: 30_000 + output * 2, cache_creation_input_tokens: 900, output_tokens: output });
    return {
      ask: (text) => ({ ...base, type: 'user', message: { role: 'user', content: text }, origin: { kind: 'human' }, uuid: `ou${(n += 1)}`, timestamp: at() }),
      say: (id, block, output = 200) => ({ ...base, type: 'assistant', effort, message: { id, model, role: 'assistant', content: [block], usage: usage(output) }, uuid: `oa${(n += 1)}`, timestamp: at() }),
      got: (id, content) => ({ ...base, type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: false }] }, toolUseResult: { stdout: content, stderr: '', interrupted: false }, uuid: `ou${(n += 1)}`, timestamp: at() }),
      done: (ms) => ({ ...base, type: 'system', subtype: 'turn_duration', durationMs: ms, uuid: `os${(n += 1)}`, timestamp: at() }),
    };
  };
  const use = (id, name, input) => ({ type: 'tool_use', id, name, input });

  const asks = { pid: 40101, cwd, kind: 'interactive', startedAt: now - 1_500_000, sessionId: '11111111-1111-4111-8111-111111111111', name: `${path.basename(cwd)}-14`, status: 'waiting', waitingFor: 'permission prompt' };
  const digs = { pid: 40102, cwd: other, kind: 'interactive', startedAt: now - 5_400_000, sessionId: '22222222-2222-4222-8222-222222222222', name: '로그 조사', status: 'busy' };
  const fresh = { pid: 40103, cwd: other, kind: 'interactive', startedAt: now - 20_000, sessionId: '33333333-3333-4333-8333-333333333333', name: `${path.basename(other)}-7`, status: 'idle' };

  const first = writer(asks, 'claude-sonnet-5-5', 'medium', now - 120_000);
  transcript(asks, [
    first.ask('주문 테이블에 인덱스를 추가하는 마이그레이션을 만들어 줘'),
    first.say('om1', use('ot1', 'Read', { file_path: path.join(cwd, 'db', 'schema.sql') })),
    first.got('ot1', '     1\tCREATE TABLE orders (id bigint primary key, placed_at timestamptz);\n'),
    first.say('om2', use('ot2', 'Bash', { command: 'pnpm migrate:new add-orders-index', description: 'Create the migration' })),
  ]);
  const second = writer(digs, 'claude-opus-5-5', 'high', now - 3_000_000);
  const earlier = [
    second.ask('배포 스크립트가 어디에 있는지 찾아 줘'),
    second.say('om3', { type: 'text', text: '배포 스크립트는 `scripts/deploy.sh` 하나이고, CI에서는 `.github/workflows/deploy.yml`이 이것을 부릅니다.' }, 420),
    second.done(38_000),
  ];
  const latest = writer(digs, 'claude-opus-5-5', 'high', now - 360_000);
  transcript(digs, [
    ...earlier,
    latest.ask('어제 배포 뒤 오류 로그를 유형별로 묶어 줘'),
    latest.say('om4', use('ot3', 'Bash', { command: 'ls logs/', description: 'List the logs' })),
    latest.got('ot3', 'app-11-16.log\nworker-11-16.log'),
    latest.say('om5', use('ot4', 'Read', { file_path: path.join(other, 'logs', 'app-11-16.log') })),
    latest.got('ot4', '     1\t2026-11-16T02:14:07Z ERROR payment timeout\n'),
    latest.say('om6', use('ot5', 'Grep', { pattern: 'ERROR|FATAL', path: path.join(other, 'logs') })),
    latest.got('ot5', 'logs/app-11-16.log:1: ERROR payment timeout'),
    latest.say('om7', use('ot6', 'Read', { file_path: path.join(other, 'logs', 'worker-11-16.log') })),
  ]);

  const list = [asks, digs, fresh];
  mkdirSync(config, { recursive: true });
  writeFileSync(path.join(config, 'agents.json'), JSON.stringify(list));
  return list;
}

export function writeSampleSession({ home, config, cwd }) {
  const dir = path.join(config, 'projects', 'sample');
  mkdirSync(dir, { recursive: true });
  let clock = Date.now() - 3_600_000;
  let n = 0;
  const at = (seconds = 2) => new Date((clock += seconds * 1000)).toISOString();
  const base = (session) => ({ cwd, sessionId: session, version: '2.1.322', userType: 'external', entrypoint: 'cli', isSidechain: false });
  const usage = (output) => ({ input_tokens: 4, cache_read_input_tokens: 45_000 + output * 3, cache_creation_input_tokens: 1200, output_tokens: output });
  const user = (session, content, extra = {}) => ({ ...base(session), type: 'user', message: { role: 'user', content }, uuid: `u${(n += 1)}`, timestamp: at(), ...extra });
  const reply = (session, id, block, out = 300) => ({ ...base(session), type: 'assistant', effort: 'high', message: { id, model: 'claude-opus-5-5', role: 'assistant', content: [block], usage: usage(out) }, uuid: `a${(n += 1)}`, timestamp: at() });
  const use = (id, name, input) => ({ type: 'tool_use', id, name, input });
  const result = (session, id, content, extra = {}, isError = false) =>
    user(session, [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }], { toolUseResult: { stdout: content, stderr: '', interrupted: false }, ...extra });
  const done = (session, ms) => ({ ...base(session), type: 'system', subtype: 'turn_duration', durationMs: ms, uuid: `s${(n += 1)}`, timestamp: at() });

  const first = [
    user('sample-1', 'README를 정리하고 테스트를 돌려 줘', { origin: { kind: 'human' } }),
    reply('sample-1', 'm1', { type: 'thinking', thinking: 'README 구조부터 보겠습니다. 설치 안내가 아래에 있습니다.' }),
    reply('sample-1', 'm1', use('t1', 'Read', { file_path: path.join(cwd, 'README.md') })),
    result('sample-1', 't1', '     1\t# Shop\n     2\t\n     3\tA small shop.\n'),
    reply('sample-1', 'm2', use('t2', 'Grep', { pattern: 'TODO', path: path.join(cwd, 'src') })),
    result('sample-1', 't2', 'src/cart.ts:12: // TODO: tax'),
    reply('sample-1', 'm3', use('t3', 'Edit', { file_path: path.join(cwd, 'README.md'), old_string: 'A small shop.', new_string: 'A small shop. Install first.' })),
    result('sample-1', 't3', 'The file README.md has been updated.', {
      toolUseResult: { filePath: path.join(cwd, 'README.md'), structuredPatch: [{ oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-A small shop.', '+A small shop. Install first.'] }] },
    }),
    reply('sample-1', 'm4', use('t4', 'Bash', { command: 'pnpm test', description: 'Run the tests' })),
    result('sample-1', 't4', 'Error: Exit code 1\nnot ok 3 - cart totals', { toolUseResult: 'Error: Exit code 1' }, true),
    reply('sample-1', 'm5', { type: 'text', text: ANSWER }, 640),
    done('sample-1', 83_000),
    user('sample-1', '프로젝트 구조를 조사해 줘', { origin: { kind: 'human' } }),
    reply('sample-1', 'm6', use('t5', 'Agent', { subagent_type: 'Explore', description: '폴더 구조 조사', prompt: '구조를 요약해 줘' })),
    result('sample-1', 't5', REPORT, { toolUseResult: { agentId: 'a1b2c3', status: 'completed' } }),
    reply('sample-1', 'm7', { type: 'text', text: '세 부분으로 나뉩니다. 서버, 화면, 공통 타입입니다.' }, 120),
    done('sample-1', 41_000),
    user('sample-1', '모든 파일을 한 줄씩 설명해 줘', { origin: { kind: 'human' } }),
    reply('sample-1', 'm8', { type: 'text', text: '첫 파일부터 시작합니다.' }, 40),
    user('sample-1', [{ type: 'text', text: '[Request interrupted by user]' }]),
  ];
  const second = [
    user('sample-2', '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>'),
    user('sample-2', '새 작업: 장바구니 세금 계산을 고쳐 줘', { origin: { kind: 'human' } }),
    reply('sample-2', 'm9', { type: 'text', text: '`src/cart.ts`의 세금 계산부터 보겠습니다.' }, 60),
    done('sample-2', 9000),
  ];
  const files = [path.join(dir, 'sample-1.jsonl'), path.join(dir, 'sample-2.jsonl')];
  writeFileSync(files[0], first.map((r) => `${JSON.stringify(r)}\n`).join(''));
  writeFileSync(files[1], second.map((r) => `${JSON.stringify(r)}\n`).join(''));

  const ended = Date.now() - 600_000;
  const session = {
    id: 'sample-ended-session',
    vendor: 'claude',
    title: 'readme-cleanup',
    cwd,
    model: 'opus',
    effort: 'high',
    permissionMode: null,
    cli: { file: 'claude.exe', version: '2.1.322' },
    vendorSessionId: 'sample-2',
    pid: 1,
    cols: 120,
    rows: 32,
    startedAt: Date.now() - 3_600_000,
    state: 'exited',
    exit: { code: null, signal: null, at: ended },
    screen: false,
    status: { value: 'exited', reason: null, tool: null, error: false, at: ended },
    telemetry: { level: 'full', model: 'Opus 5.5', effort: 'high', contextPct: 31, contextWindow: 1_000_000, costUsd: 1.2 },
    transcripts: files.map((file, i) => ({ vendorSessionId: `sample-${i + 1}`, path: file, since: Date.now() - 3_600_000 + i * 1_800_000 })),
  };
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, 'sessions.json'), JSON.stringify({ version: 1, sessions: [session] }));
  return session;
}
