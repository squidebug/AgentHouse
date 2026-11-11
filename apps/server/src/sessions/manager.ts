import { EventEmitter } from 'node:events';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { LaunchOptions, SessionInfo, TerminalColors, ThemeMode, Vendor } from '@agenthouse/protocol';
import { buildLaunch, LaunchError } from '../cli/launch';
import { EnvService, INSTALL_COMMAND } from '../env/report';
import { Session } from './session';

export const THEME_COLORS: Record<ThemeMode, TerminalColors> = {
  light: { foreground: '#1f2328', background: '#fbfcfe' },
  dark: { foreground: '#dfe2ea', background: '#12151a' },
};

const MISSING_TEXT: Record<Vendor, string> = {
  claude: 'Claude Code가 설치되어 있지 않습니다.',
  codex: 'Codex CLI가 설치되어 있지 않습니다.',
};

export interface ManagerOptions {
  env: EnvService;
  defaultCwd: string;
  /** Path of the test double; only set when the server runs with --allow-fake. */
  fakeAgentPath?: string;
}

// Markers an agent CLI sets for the processes it runs. When AgentHouse itself is
// started from inside a Claude Code or Codex session, they would make every
// session it launches think it is that session's child (Claude then stops saving
// its transcript), and the messaging token is that session's secret. User
// configuration such as CLAUDE_CONFIG_DIR or CLAUDE_CODE_EFFORT_LEVEL is kept.
const INHERITED_SESSION_VARS = [
  'AGENTHOUSE_TOKEN',
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

export function childEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...source, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
  for (const name of INHERITED_SESSION_VARS) delete env[name];
  return env;
}

async function resolveCwd(requested: string | undefined, fallback: string): Promise<string> {
  const cwd = path.resolve(requested?.trim() || fallback);
  try {
    if ((await stat(cwd)).isDirectory()) return cwd;
  } catch {
    // reported below
  }
  throw new LaunchError(`작업 폴더를 찾을 수 없습니다: ${cwd}`, 'CWD_NOT_FOUND');
}

/** Owns every running session and tells listeners when the list changes. */
export class SessionManager extends EventEmitter {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly options: ManagerOptions) {
    super();
  }

  async create(opts: LaunchOptions): Promise<Session> {
    const cwd = await resolveCwd(opts.cwd, this.options.defaultCwd);
    let install: { file: string; args: string[]; version: string | null };
    if (opts.vendor === 'fake') {
      if (!this.options.fakeAgentPath) throw new LaunchError('알 수 없는 CLI입니다.', 'INVALID_OPTION');
      install = { file: process.execPath, args: [this.options.fakeAgentPath], version: null };
    } else {
      const status = await this.options.env.cli(opts.vendor);
      const selected = status.selected === null ? undefined : status.installs[status.selected];
      if (!selected) throw new LaunchError(MISSING_TEXT[opts.vendor], 'ENV_CLI_MISSING', 409, INSTALL_COMMAND[opts.vendor]);
      install = selected;
    }

    const spec = await buildLaunch(opts, install, cwd);
    const session = new Session({
      vendor: opts.vendor,
      title: spec.title,
      file: spec.file,
      args: spec.args,
      cwd,
      env: childEnv(),
      cols: opts.cols ?? 120,
      rows: opts.rows ?? 32,
      colors: THEME_COLORS[opts.theme ?? 'dark'],
      model: opts.model || null,
      effort: opts.effort || null,
      permissionMode: opts.permissionMode || null,
      cliVersion: install.version,
      vendorSessionId: spec.vendorSessionId,
      cleanup: spec.cleanup,
    });
    session.on('exit', () => this.emit('change'));
    this.sessions.set(session.id, session);
    this.emit('change');
    return session;
  }

  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  list(): SessionInfo[] {
    return [...this.sessions.values()].map((s) => s.info());
  }

  /** Ends the session (if still running) and removes it from the list. */
  async remove(id: string): Promise<{ exited: boolean; stillAlive: boolean } | null> {
    const session = this.sessions.get(id);
    if (!session) return null;
    const result = await session.close();
    this.sessions.delete(id);
    this.emit('change');
    return result;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.close()));
  }
}
