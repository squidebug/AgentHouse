import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { VENDOR_NAMES, type AccountLimits, type CliStatus, type ComposeRequest, type LaunchOptions, type LinkKind, type SessionInfo, type SessionLink, type Vendor } from '@agenthouse/protocol';
import { buildLaunch, LaunchError } from './cli/launch';
import { EnvService, INSTALL_COMMAND } from './doctor';
import type { HostClient } from './host-client';
import { HostRequestError, type CloseResult, type ComposeOutcome } from '../shared/host-protocol';
import { removeTree } from '../shared/state';
import { childEnv } from '../shared/child-env';
import { LinkStore, linksFile } from './links';
import { registryFile, SessionRegistry } from './registry';
import { LimitsLog, stillValid } from './usage-log';

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

// `claude agents --json` (lists sessions as idle, busy or waiting) arrived in 2.1.145.
export const AGENTS_JSON_SINCE = [2, 1, 145];
// The sub-agent status line (each sub-agent's model and tokens), first checked on
// 2.1.322; older versions may have it too, but an unknown settings key is not risked.
export const SUBAGENT_STATUS_LINE_SINCE = [2, 1, 322];

/** Compares the first x.y.z in a CLI's version text; an unknown version counts as recent enough. */
export function versionAtLeast(version: string | null, minimum: number[]): boolean {
  const parts = version?.match(/(\d+)\.(\d+)\.(\d+)/)?.slice(1).map(Number);
  if (!parts) return true;
  for (let i = 0; i < minimum.length; i += 1) {
    const a = parts[i] ?? 0;
    const b = minimum[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

/** The install the check picked is still there to run: its program and the script it runs. */
function stillThere(status: CliStatus): boolean {
  const install = status.selected === null ? undefined : status.installs[status.selected];
  return Boolean(install) && [install!.file, ...install!.args].every((part) => existsSync(part));
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
 * flags, environment) and hands it to the session host, which runs it. It also
 * keeps the session registry, the usage log and the links between sessions,
 * so the list, the tree and the last plan usage outlive a host restart.
 * 'links' fires when the links change.
 */
export class SessionManager extends EventEmitter {
  private readonly registry: SessionRegistry;
  private readonly linkStore: LinkStore;
  private readonly usage: LimitsLog;
  /** Plan usage from the log, until sessions report again. */
  private readonly logged: AccountLimits[];
  private readonly onChange: () => void;
  private readonly onLimits: () => void;

  constructor(private readonly options: ManagerOptions) {
    super();
    const { host } = options;
    this.registry = new SessionRegistry(registryFile(host.stateDir));
    this.usage = new LimitsLog(path.join(host.stateDir, 'usage'));
    this.logged = this.usage.last();
    this.registry.record(host.sessions());
    this.linkStore = new LinkStore(linksFile(host.stateDir));
    this.linkStore.prune(this.known);
    this.onChange = () => {
      this.registry.record(host.sessions());
      this.emit('change');
      if (this.linkStore.prune(this.known)) this.emit('links');
    };
    this.onLimits = () => {
      this.usage.append(host.limits());
      this.emit('limits');
    };
    host.on('change', this.onChange);
    host.on('limits', this.onLimits);
  }

  /** Plan usage per vendor account: the newest a session reported, or the log's; windows that reset since are dropped. */
  limits(): AccountLimits[] {
    const newest = new Map<string, AccountLimits>();
    for (const entry of [...this.logged, ...this.options.host.limits()]) {
      const before = newest.get(entry.vendor);
      if (!before || entry.at >= before.at) newest.set(entry.vendor, entry);
    }
    return [...newest.values()].map((entry) => stillValid(entry)).filter((entry): entry is AccountLimits => entry !== null);
  }

  async create(opts: LaunchOptions): Promise<SessionInfo> {
    const cwd = await resolveCwd(opts.cwd, this.options.defaultCwd);
    let install: { file: string; args: string[]; version: string | null };
    if (opts.vendor === 'fake') {
      if (!this.options.fakeAgentPath) throw new LaunchError('알 수 없는 CLI입니다.', 'INVALID_OPTION');
      install = { file: process.execPath, args: [this.options.fakeAgentPath], version: null };
    } else {
      let status = await this.options.env.cli(opts.vendor);
      // The check is a minute old at most: a CLI installed, removed or moved since is looked for again.
      if (!stillThere(status)) status = await this.options.env.cli(opts.vendor, true);
      if (status.chosenError) {
        throw new LaunchError(`지정한 ${VENDOR_NAMES[opts.vendor]} 실행 파일을 쓸 수 없습니다. ${status.chosenError}`, 'ENV_CLI_CHOSEN_UNUSABLE', 409);
      }
      const selected = status.selected === null ? undefined : status.installs[status.selected];
      if (!selected) throw new LaunchError(MISSING_TEXT[opts.vendor], 'ENV_CLI_MISSING', 409, INSTALL_COMMAND[opts.vendor]);
      install = selected;
    }

    // Claude (and the test double) report status through hooks and the status
    // line; the relay proves which session it speaks for with this token.
    const hookToken = opts.vendor === 'codex' ? null : randomBytes(24).toString('base64url');
    const spec = await buildLaunch(opts, install, cwd, {
      ...(hookToken ? { observe: { port: this.options.host.port, token: hookToken, subagents: versionAtLeast(install.version, SUBAGENT_STATUS_LINE_SINCE) } } : {}),
      tempRoot: this.options.host.runDir,
    });
    try {
      return await this.options.host.spawn({
        id: randomUUID(),
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
        hookToken,
        agentsCommand: opts.vendor === 'claude' && versionAtLeast(install.version, AGENTS_JSON_SINCE) ? { file: install.file, args: [...install.args, 'agents', '--json'] } : null,
      });
    } catch (error) {
      // The host refused it, so nothing reads the temporary files. After a
      // timeout the host may have started it after all; they stay then.
      if (error instanceof HostRequestError) await Promise.all(spec.tempPaths.map(removeTree));
      throw error;
    }
  }

  private readonly known = (id: string) => Boolean(this.get(id));

  /** Which session the user placed under which. */
  links(): SessionLink[] {
    return this.linkStore.list();
  }

  /** Places a session under another, or back at the top with null. Throws LinkError for what the tree cannot show. */
  link(childId: string, parentId: string | null, kind: LinkKind = 'group'): SessionLink[] {
    if (this.linkStore.set(childId, parentId, kind, this.known)) this.emit('links');
    return this.links();
  }

  get(id: string): SessionInfo | undefined {
    return this.options.host.get(id) ?? this.registry.get(id);
  }

  /** The host's sessions and the ended ones from earlier hosts, in the order they started. */
  list(): SessionInfo[] {
    const live = this.options.host.sessions();
    return [...live, ...this.registry.past(live)].sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Ends the session. It stays listed, ended, with its conversation and the
   * work delegated to or from it, like a session that quit by itself.
   */
  async end(id: string): Promise<CloseResult> {
    const result = this.options.host.get(id) ? await this.options.host.closeSession(id) : { exited: true, stillAlive: false };
    this.emit('change');
    return result;
  }

  /** Ends the session (if still running) and removes it from the list. */
  async remove(id: string): Promise<CloseResult> {
    const result = this.options.host.get(id) ? await this.options.host.closeSession(id) : { exited: true, stillAlive: false };
    this.registry.remove(id);
    this.emit('change');
    // Sessions under it go back to the top.
    if (this.linkStore.prune(this.known)) this.emit('links');
    return result;
  }

  /** Saves what is pending and stops following the host; the web server is closing. */
  close(): void {
    this.options.host.off('change', this.onChange);
    this.options.host.off('limits', this.onLimits);
    this.registry.flush();
  }

  compose(id: string, request: ComposeRequest): Promise<ComposeOutcome> {
    return this.options.host.compose(id, request);
  }
}
