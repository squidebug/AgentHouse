import assert from 'node:assert/strict';
import { test } from 'node:test';
import { childEnv } from '../src/shared/child-env';
import { runQuick } from '../src/web/cli/probe';

test('sessions do not inherit the markers of an agent session AgentHouse runs inside', () => {
  const env = childEnv({
    PATH: '/bin',
    CLAUDECODE: '1',
    CLAUDE_CODE_SESSION_ID: 'parent',
    CLAUDE_CODE_CHILD_SESSION: '1',
    CLAUDE_CODE_MESSAGING_TOKEN: 'secret',
    AGENTHOUSE_TOKEN: 'secret',
    AGENTHOUSE_WEB_TOKEN: 'secret',
    CODEX_SANDBOX: 'seatbelt',
    CLAUDE_CONFIG_DIR: 'D:\\claude',
    CLAUDE_CODE_EFFORT_LEVEL: 'high',
  });
  for (const name of ['CLAUDECODE', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_MESSAGING_TOKEN', 'AGENTHOUSE_TOKEN', 'AGENTHOUSE_WEB_TOKEN', 'CODEX_SANDBOX']) {
    assert.equal(env[name], undefined, name);
  }
  assert.equal(env.CLAUDE_CONFIG_DIR, 'D:\\claude', 'user configuration is kept');
  assert.equal(env.CLAUDE_CODE_EFFORT_LEVEL, 'high', 'user configuration is kept');
  assert.equal(env.TERM, 'xterm-256color');
  assert.equal(env.PATH, '/bin');
});

test('the environment check asks a CLI without those markers too', async () => {
  const saved = process.env.CLAUDE_CODE_CHILD_SESSION;
  process.env.CLAUDE_CODE_CHILD_SESSION = '1';
  try {
    const asked = await runQuick(process.execPath, ['-e', 'process.stdout.write(String(process.env.CLAUDE_CODE_CHILD_SESSION))']);
    assert.deepEqual(asked, { code: 0, stdout: 'undefined' });
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CODE_CHILD_SESSION;
    else process.env.CLAUDE_CODE_CHILD_SESSION = saved;
  }
});
