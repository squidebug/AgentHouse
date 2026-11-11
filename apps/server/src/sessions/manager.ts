import { EventEmitter } from 'node:events';
import { rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ComposeRequest, LaunchOptions, SessionInfo, Vendor } from '@agenthouse/protocol';
import { buildLaunch, LaunchError } from '../cli/launch';
import { EnvService, INSTALL_COMMAND } from '../env/report';
import type { HostClient } from '../host/client';
import { HostRequestError, type CloseResult, type ComposeOutcome } from '../host/protocol';
import { childEnv } from './env';

const MISSING_TEXT: Record<Vendor, string> = {
  claude: 'Claude Code가 설치되어 있지 않습니다.',
  codex: 'Codex CLI가 설치되어 있지 않습니다.',
};

export interface ManagerOptions {
  env: EnvService;
  defaultCwd: string;
  host: HostClient;
  /** Path of the test double; only set when the server runs with --allow-fake. */
  fakeAgentPath?: string;
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

/**
 * The web server's side of the sessions: it prepares each launch (folder, CLI,
 * flags, environment) and hands it to the session host, which runs it.
 */
export class SessionManager extends EventEmitter {
  constructor(private readonly options: ManagerOptions) {
    super();
    options.host.on('change', () => this.emit('change'));
  }

  async create(opts: LaunchOptions): Promise<SessionInfo> {
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
    try {
      return await this.options.host.spawn({
        vendor: opts.vendor,
        title: spec.title,
        file: spec.file,
        args: spec.args,
        cwd,
        env: childEnv(),
        cols: opts.cols ?? 120,
        rows: opts.rows ?? 32,
        theme: opts.theme ?? 'dark',
        model: opts.model || null,
        effort: opts.effort || null,
        permissionMode: opts.permissionMode || null,
        cliVersion: install.version,
        vendorSessionId: spec.vendorSessionId,
        tempPaths: spec.tempPaths,
      });
    } catch (error) {
      // The host refused it, so nothing reads the temporary files. After a
      // timeout the host may have started it after all; they stay then.
      if (error instanceof HostRequestError) await Promise.all(spec.tempPaths.map((p) => rm(p, { recursive: true, force: true })));
      throw error;
    }
  }

  get(id: string): SessionInfo | undefined {
    return this.options.host.get(id);
  }

  list(): SessionInfo[] {
    return this.options.host.sessions();
  }

  /** Ends the session (if still running) and removes it from the list. */
  remove(id: string): Promise<CloseResult> {
    return this.options.host.closeSession(id);
  }

  compose(id: string, request: ComposeRequest): Promise<ComposeOutcome> {
    return this.options.host.compose(id, request);
  }
}
