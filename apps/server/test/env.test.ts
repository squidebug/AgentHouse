import assert from 'node:assert/strict';
import { test } from 'node:test';
import { childEnv } from '../src/shared/child-env';

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
