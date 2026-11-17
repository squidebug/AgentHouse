import { randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { VENDOR_NAMES, type AccountLimits, type CliStatus, type ComposeRequest, type LaunchOptions, type LinkKind, type SessionInfo, type SessionLink, type Vendor } from '@agenthouse/protocol';
import { claudeConfigDir } from '../claude/settings';
import { buildLaunch, LaunchError } from './cli/launch';
import { EnvService, INSTALL_COMMAND } from './doctor';
import { askSessions } from '../claude/sessions';
import { ExternalSessions } from './external';
import type { HostClient } from './host-client';
import { HostRequestError, type CloseResult, type ComposeOutcome } from '../shared/host-protocol';
import { removeTree } from '../shared/state';
import { childEnv } from '../shared/child-env';
import { LinkError, LinkStore, linksFile } from './links';
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
  /**
   * Claude Code's own list of sessions, parsed (see ExternalSessions): by default the installed
   * CLI's `agents --json`; a check gives its own; null when nothing is to be asked.
   */
  claudeSessions?: (() => Promise<unknown>) | null;
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
 * The sessions started outside AgentHouse, which it only watches, are listed
 * with the others. 'links' fires when the links change.
 */
export class SessionManager extends EventEmitter {
  private readonly registry: SessionRegistry;
  private readonly linkStore: LinkStore;
  private readonly usage: LimitsLog;
  /** Plan usage from the log, until sessions report again. */
  private readonly logged: AccountLimits[];
  private readonly onChange: () => void;
  private readonly onLimits: () => void;
  /** Ended sessions being started again right now. */
  private readonly resuming = new Set<string>();
  /** The Claude Code sessions started elsewhere; null when they are not looked for. */
  private readonly external: ExternalSessions | null;
  private readonly onExternal = () => this.emit('change');

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
    this.external =
      options.claudeSessions === null
        ? null
        : new ExternalSessions({ ask: options.claudeSessions ?? (() => this.askClaude()), own: () => host.sessions(), configDir: claudeConfigDir() });
    this.external?.on('change', this.onExternal);
  }

  /** The installed Claude Code's list of its sessions; null when there is no Claude to ask, or one from before it had the list. */
  private async askClaude(): Promise<unknown> {
    const status = await this.options.env.cli('claude');
    const install = status.selected === null || status.chosenError ? undefined : status.installs[status.selected];
    if (!install || !versionAtLeast(install.version, AGENTS_JSON_SINCE)) return null;
    return askSessions({ file: install.file, args: [...install.args, 'agents', '--json'] }, childEnv());
  }

  /** Looks for the sessions started outside AgentHouse from now on (someone is there to see them), or stops looking. */
  watchExternal(on: boolean): void {
    this.external?.watch(on);
  }

  /** Settles once the first look since watching started is done, or the time is up. */
  externalReady(timeoutMs: number): Promise<void> {
    return this.external?.ready(timeoutMs) ?? Promise.resolve();
  }

  /** Takes them off the list: the user turned watching off. */
  forgetExternal(): void {
    this.external?.clear();
  }

  /** Refuses what only a session of AgentHouse's own can do. */
  private ours(id: string): void {
    if (this.external?.get(id)) throw new LaunchError('AgentHouse가 띄운 세션이 아닙니다.', 'EXTERNAL_SESSION', 409);
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

  create(opts: LaunchOptions): Promise<SessionInfo> {
    return this.start(opts, randomUUID());
  }

  /**
   * Starts an ended session again where its conversation stopped (`claude --resume`), in its
   * folder and with what it was launched with. It is the same session to AgentHouse: the id stays,
   * and with it the row in the tree, the panes showing it and the work delegated to or from it.
   */
  async resume(id: string, theme?: LaunchOptions['theme']): Promise<SessionInfo> {
    const ended = this.get(id);
    if (!ended) throw new LaunchError('세션을 찾을 수 없습니다.', 'NOT_FOUND', 404);
    if (ended.state !== 'exited') throw new LaunchError('실행 중인 세션입니다.', 'SESSION_RUNNING', 409);
    // Codex has its own way (`codex resume`), not looked into yet.
    if (ended.vendor === 'codex') throw new LaunchError(`${VENDOR_NAMES[ended.vendor]} 세션은 이어서 열 수 없습니다.`, 'RESUME_UNSUPPORTED');
    // The conversation it ended in: after /clear, the one that came last.
    const last = ended.transcripts.at(-1);
    if (!last?.vendorSessionId || !existsSync(last.path)) throw new LaunchError('이어서 열 대화가 없습니다.', 'NO_CONVERSATION', 409);
    // Asked twice in a row (a double click): the first is still on its way.
    if (this.resuming.has(id)) throw new LaunchError('이미 여는 중입니다.', 'RESUME_IN_PROGRESS', 409);
    this.resuming.add(id);
    try {
      // A host that saw it end still holds it, for its last screen; it takes the id again once it let go.
      if (this.options.host.get(id)) await this.options.host.closeSession(id);
      return await this.start(
        {
          vendor: ended.vendor,
          title: ended.title,
          cwd: ended.cwd,
          cols: ended.cols,
          rows: ended.rows,
          ...(ended.model ? { model: ended.model } : {}),
          ...(ended.effort ? { effort: ended.effort } : {}),
          ...(ended.permissionMode ? { permissionMode: ended.permissionMode } : {}),
          ...(theme ? { theme } : {}),
        },
        id,
        last.vendorSessionId,
      );
    } finally {
      this.resuming.delete(id);
    }
  }

  /** Prepares the launch and hands it to the host: a new conversation, or `resume`, the CLI's id of one to go on with. */
  private async start(opts: LaunchOptions, id: string, resume?: string): Promise<SessionInfo> {
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
      titles: this.list().map((session) => session.title),
      guard: this.options.host.stateDir,
      ...(resume ? { resume } : {}),
    });
    try {
      return await this.options.host.spawn({
        id,
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
    // A session only watched goes with its process: nothing is placed under it, and it under nothing.
    if (this.external?.get(childId) || (parentId !== null && this.external?.get(parentId))) throw new LinkError('AgentHouse가 띄운 세션이 아닙니다.', 'INVALID_REQUEST');
    if (this.linkStore.set(childId, parentId, kind, this.known)) this.emit('links');
    return this.links();
  }

  get(id: string): SessionInfo | undefined {
    return this.options.host.get(id) ?? this.registry.get(id) ?? this.external?.get(id);
  }

  /** The host's sessions, the ended ones from earlier hosts and the ones started elsewhere, in the order they started. */
  list(): SessionInfo[] {
    const live = this.options.host.sessions();
    return [...live, ...this.registry.past(live), ...(this.external?.list() ?? [])].sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Ends the session. It stays listed, ended, with its conversation and the
   * work delegated to or from it, like a session that quit by itself.
   */
  async end(id: string): Promise<CloseResult> {
    this.ours(id);
    const result = this.options.host.get(id) ? await this.options.host.closeSession(id) : { exited: true, stillAlive: false };
    this.emit('change');
    return result;
  }

  /** Ends the session (if still running) and removes it from the list. */
  async remove(id: string): Promise<CloseResult> {
    this.ours(id);
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
    this.external?.off('change', this.onExternal);
    this.external?.close();
    this.registry.flush();
  }

  async compose(id: string, request: ComposeRequest): Promise<ComposeOutcome> {
    this.ours(id);
    return this.options.host.compose(id, request);
  }
}
