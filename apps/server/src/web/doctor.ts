import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { VENDOR_NAMES, type CliInstall, type CliStatus, type EnvMessage, type EnvReport, type Vendor } from '@agenthouse/protocol';
import { claudeHookBlocker, gitBashPath } from '../claude/settings';
import { hostBuildId } from '../shared/build';
import { readAppSettings, writeAppSettings } from './app-settings';
import { claudeLoggedIn, codexLoggedIn, detectVersion, identify } from './cli/probe';
import { findOnPath, installKey, resolveChosen, resolveCli, type ResolvedCommand } from './cli/resolve';
import { olderHosts } from './host-client';
import { Told, words, type Lang, type Words } from './words';

const CACHE_MS = 60_000;
// Node lines whose security support has ended (as of 2026-11).
const EOL_MAJORS = new Set([18, 19, 20, 21, 23, 25]);

export const INSTALL_COMMAND: Record<Vendor, string> = {
  claude: 'npm i -g @anthropic-ai/claude-code',
  codex: 'npm i -g @openai/codex',
};

export const LOGIN_COMMAND: Record<Vendor, string> = {
  claude: 'claude auth login',
  codex: 'codex login',
};

function windowsBuild(): number | null {
  if (process.platform !== 'win32') return null;
  const build = Number(os.release().split('.')[2]);
  return Number.isFinite(build) ? build : null;
}

// How each CLI names itself in `--version`, so a chosen file is the program it is chosen for.
const PRODUCT: Record<Vendor, RegExp> = { claude: /claude code/i, codex: /codex/i };

/** A refused choice of executable; the message says why. */
export class CliChoiceError extends Told {}

/** Why a chosen file cannot run, in the words the user reads. */
const unusable = (file: string): Words => (existsSync(file) ? words('실행할 수 있는 프로그램이 아닙니다.', 'It is not a program that can run.') : words('파일이 없습니다.', 'There is no such file.'));

/** What is known of a CLI, before it is said in a language: why a chosen file cannot run is kept in both. */
type Probed = Omit<CliStatus, 'chosenError'> & { chosenError?: Words };
type Facts = Omit<EnvReport, 'messages' | 'clis'> & { clis: Record<Vendor, Probed> };

const spoken = ({ chosenError, ...status }: Probed, lang: Lang): CliStatus => ({ ...status, ...(chosenError ? { chosenError: chosenError[lang] } : {}) });

/**
 * The installs of a CLI: those on PATH, in PATH order (the first is the one the
 * user's shell runs), then the file the user chose if it is not one of them.
 * The chosen one is launched; one that cannot run launches nothing.
 * `searchPath` stands in for PATH where a check names its own folders.
 */
async function probeCli(vendor: Vendor, chosen: string | null, searchPath?: string): Promise<Probed> {
  const onPath = resolveCli(vendor, searchPath === undefined ? process.env : { ...process.env, PATH: searchPath });
  const found: Array<ResolvedCommand & { onPath: boolean }> = onPath.map((r) => ({ ...r, onPath: true }));
  let selected: number | null = found.length ? 0 : null;
  let chosenError: Words | undefined;
  if (chosen) {
    const resolved = resolveChosen(chosen);
    if (!resolved) {
      chosenError = unusable(chosen);
      selected = null;
    } else {
      const same = found.findIndex((r) => installKey(r) === installKey(resolved));
      if (same === -1) found.push({ ...resolved, onPath: false });
      selected = same === -1 ? found.length - 1 : same;
    }
  }
  const installs: CliInstall[] = await Promise.all(
    found.map(async (r) => ({ file: r.file, args: r.args, shim: r.shim, onPath: r.onPath, version: await detectVersion(r) })),
  );
  let loggedIn: boolean | null = null;
  const launched = selected === null ? undefined : installs[selected];
  if (launched) loggedIn = vendor === 'claude' ? await claudeLoggedIn(launched) : await codexLoggedIn(launched);
  return { vendor, installs, selected, loggedIn, chosen, ...(chosenError ? { chosenError } : {}) };
}

/** What a look at the machine found: the facts of a report, and what decides its words about hooks. */
interface Found {
  facts: Facts;
  hooks: HookReach;
}

/** What decides whether Claude's hooks (status, usage) can reach AgentHouse. */
interface HookReach {
  blocker: 'managed' | 'user' | null;
  /** Windows without Git Bash runs hooks in PowerShell; the relay command then needs node on PATH. */
  noShell: boolean;
}

function messagesFor(report: Facts, hooks: HookReach, lang: Lang): EnvMessage[] {
  const messages: EnvMessage[] = [];
  const say = (ko: string, en: string) => (lang === 'en' ? en : ko);
  const { claude, codex } = report.clis;

  if (!claude.installs.length && !codex.installs.length) {
    messages.push({ id: 'ENV_NO_CLI', level: 'error', text: say('Claude Code 또는 Codex CLI가 필요합니다.', 'Claude Code or the Codex CLI is needed.'), command: INSTALL_COMMAND.claude });
  }
  for (const status of [claude, codex]) {
    const name = VENDOR_NAMES[status.vendor];
    const id = status.vendor.toUpperCase();
    if (status.chosenError) {
      // The file itself shows in the CLI's row, next to 변경.
      messages.push({ id: `ENV_${id}_CHOSEN_UNUSABLE`, level: 'error', text: say(`지정한 ${name} 실행 파일을 쓸 수 없습니다. ${status.chosenError.ko}`, `The file chosen for ${name} cannot be used. ${status.chosenError.en}`) });
      continue;
    }
    if (!status.installs.length) {
      if (claude.installs.length || codex.installs.length) {
        messages.push({ id: `ENV_${id}_MISSING`, level: 'info', text: say(`${name}가 설치되어 있지 않습니다.`, `${name} is not installed.`), command: INSTALL_COMMAND[status.vendor] });
      }
      continue;
    }
    const selected = status.installs[status.selected ?? 0];
    // A file the user chose is the one they meant; the others are not worth a word.
    if (status.installs.length > 1 && selected && !status.chosen) {
      messages.push({
        id: `ENV_${status.vendor.toUpperCase()}_MULTIPLE_INSTALLS`,
        level: 'info',
        text: say(
          `${name}가 ${status.installs.length}곳에 설치되어 있습니다. 셸이 실행하는 버전(${selected.version ?? '미확인'})을 사용합니다.`,
          `${name} is installed in ${status.installs.length} places. The one your shell runs (${selected.version ?? 'version unknown'}) is used.`,
        ),
      });
    }
    if (status.loggedIn === false) {
      messages.push({ id: `ENV_${status.vendor.toUpperCase()}_NOT_LOGGED_IN`, level: 'warn', text: say(`${name}에 로그인되어 있지 않습니다.`, `${name} is not logged in.`), command: LOGIN_COMMAND[status.vendor] });
    }
  }
  if (claude.installs.length) {
    if (hooks.blocker === 'managed') {
      messages.push({ id: 'ENV_CLAUDE_HOOKS_BLOCKED', level: 'warn', text: say('관리 정책이 hook을 막고 있어 Claude 상태와 사용량을 볼 수 없습니다. 터미널은 그대로 쓸 수 있습니다.', "A managed policy blocks hooks, so Claude's status and usage cannot be shown. The terminal works as it is.") });
    } else if (hooks.blocker === 'user') {
      messages.push({ id: 'ENV_CLAUDE_HOOKS_DISABLED', level: 'warn', text: say('Claude 설정의 disableAllHooks 때문에 상태와 사용량을 볼 수 없습니다. 터미널은 그대로 쓸 수 있습니다.', "disableAllHooks in Claude's settings keeps its status and usage from being shown. The terminal works as it is.") });
    }
    if (hooks.noShell) {
      messages.push({ id: 'ENV_CLAUDE_NO_HOOK_SHELL', level: 'warn', text: say('Git Bash가 없고 PATH에서 node를 찾지 못해 Claude 상태를 받을 수 없습니다.', "Without Git Bash, and with no node on PATH, Claude's status cannot be received.") });
    }
  }
  if (report.node.eol) {
    messages.push({ id: 'ENV_NODE_EOL', level: 'info', text: say(`Node.js ${report.node.major}은 보안 지원이 끝난 버전입니다.`, `Node.js ${report.node.major} no longer gets security fixes.`) });
  }
  return messages;
}

/** What the doctor asks the session host about. */
export interface HostFacts {
  /** The code the host started with. */
  build: string;
  stateDir: string;
  /** How the user ends the host: `pnpm stop`, or `pnpm dev:stop` in development. */
  stopCommand: string;
}

/** Checks that must be current on every report and are quick: the session host. */
export async function hostMessages(host: HostFacts, lang: Lang = 'ko'): Promise<EnvMessage[]> {
  const messages: EnvMessage[] = [];
  const say = (ko: string, en: string) => (lang === 'en' ? en : ko);
  if (host.build !== hostBuildId()) {
    messages.push({
      id: 'ENV_HOST_OUTDATED',
      level: 'warn',
      text: say('세션 호스트가 이전 코드로 실행 중입니다. 다시 시작하면 새 코드가 적용되고 실행 중인 세션은 끝납니다.', 'The session host runs older code. Restarting it applies the new code and ends the running sessions.'),
      command: host.stopCommand,
    });
  }
  if (await olderHosts(host.stateDir)) {
    messages.push({
      id: 'ENV_HOST_OLDER_VERSION',
      level: 'warn',
      text: say('이전 버전의 세션 호스트가 실행 중입니다. 그 세션은 여기에 보이지 않습니다.', 'A session host of an older version is running. Its sessions do not show here.'),
      command: host.stopCommand,
    });
  }
  return messages;
}

/** Detects the Node runtime and installed CLIs once a minute at most; CLI probes take a second or two. */
export class EnvService {
  private cached: { at: number; found: Found } | null = null;
  private inflight: Promise<Found> | null = null;

  constructor(
    private readonly defaultCwd: string,
    private readonly host?: HostFacts,
    /** Where the user's choice of executables is kept; none, no choices. */
    private readonly stateDir: string | undefined = host?.stateDir,
    /** Where the CLIs are looked for, written as a PATH: this process's own, unless a check names its folders. */
    private readonly searchPath?: string,
  ) {}

  /** The report, in the language of whoever asks: a page says which it speaks, a terminal is told in Korean. */
  async report(refresh = false, lang: Lang = 'ko'): Promise<EnvReport> {
    const { facts, hooks } = await this.found(refresh);
    const clis = { claude: spoken(facts.clis.claude, lang), codex: spoken(facts.clis.codex, lang) };
    const messages = [...messagesFor(facts, hooks, lang), ...(this.host ? await hostMessages(this.host, lang) : [])];
    return { ...facts, clis, messages };
  }

  async cli(vendor: Vendor, refresh = false, lang: Lang = 'ko'): Promise<CliStatus> {
    return spoken((await this.found(refresh)).facts.clis[vendor], lang);
  }

  /**
   * Makes this file the one to run for the CLI (null: the one the user's shell
   * runs again), once it is known to be that program: a full path, a file that
   * runs, and a `--version` naming it. Quotes around a pasted path are dropped.
   */
  async choose(vendor: Vendor, file: string | null, lang: Lang = 'ko'): Promise<CliStatus> {
    if (!this.stateDir) throw new CliChoiceError(words('상태 폴더가 없습니다.', 'There is no state folder.'));
    const settings = readAppSettings(this.stateDir);
    if (file === null) delete settings.cli[vendor];
    else {
      const chosen = file.trim().replace(/^"(.*)"$/, '$1');
      if (!path.isAbsolute(chosen)) throw new CliChoiceError(words('전체 경로를 입력하세요.', 'Enter the full path.'));
      const resolved = resolveChosen(chosen);
      if (!resolved) throw new CliChoiceError(unusable(chosen));
      const { version, text } = await identify(resolved);
      if (!version) throw new CliChoiceError(words('버전을 확인하지 못했습니다.', 'Its version could not be read.'));
      if (!PRODUCT[vendor].test(text)) throw new CliChoiceError(words(`${VENDOR_NAMES[vendor]}가 아닙니다. (${text.split('\n')[0]})`, `It is not ${VENDOR_NAMES[vendor]}. (${text.split('\n')[0]})`));
      settings.cli[vendor] = chosen;
    }
    writeAppSettings(this.stateDir, settings);
    // A probe already under way still reads the old choice.
    await this.inflight?.catch(() => undefined);
    return this.cli(vendor, true, lang);
  }

  private found(refresh: boolean): Promise<Found> {
    if (!refresh && this.cached && Date.now() - this.cached.at < CACHE_MS) return Promise.resolve(this.cached.found);
    if (this.inflight) return this.inflight;
    this.inflight = this.build().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async build(): Promise<Found> {
    const major = Number(process.versions.node.split('.')[0]);
    const chosen = this.stateDir ? readAppSettings(this.stateDir).cli : {};
    const [claude, codex] = await Promise.all([probeCli('claude', chosen.claude ?? null, this.searchPath), probeCli('codex', chosen.codex ?? null, this.searchPath)]);
    const facts: Facts = {
      node: { version: process.versions.node, major, supported: major >= 18, eol: EOL_MAJORS.has(major) },
      platform: process.platform,
      windowsBuild: windowsBuild(),
      defaultCwd: this.defaultCwd,
      clis: { claude, codex },
    };
    const hooks: HookReach = {
      blocker: claudeHookBlocker(),
      noShell: process.platform === 'win32' && !findOnPath('node').length && !gitBashPath(),
    };
    const found = { facts, hooks };
    this.cached = { at: Date.now(), found };
    return found;
  }
}
