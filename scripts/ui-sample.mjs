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
