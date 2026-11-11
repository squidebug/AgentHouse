// Markers an agent CLI sets for the processes it runs. When AgentHouse itself is
// started from inside a Claude Code or Codex session, they would make every
// session it launches think it is that session's child (Claude then stops saving
// its transcript), and the messaging token is that session's secret. User
// configuration such as CLAUDE_CONFIG_DIR or CLAUDE_CODE_EFFORT_LEVEL is kept.
const INHERITED_SESSION_VARS = [
  'AGENTHOUSE_TOKEN',
  'AGENTHOUSE_WEB_TOKEN',
  'AI_AGENT',
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_SSE_PORT',
  'CODEX_SANDBOX',
  'CODEX_SANDBOX_NETWORK_DISABLED',
];

/** The environment a CLI starts with: the web server's own, minus session markers and AgentHouse secrets. */
export function childEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) if (value !== undefined) env[key] = value;
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  for (const name of INHERITED_SESSION_VARS) delete env[name];
  return env;
}
