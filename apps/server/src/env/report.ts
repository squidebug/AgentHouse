import os from 'node:os';
import type { CliInstall, CliStatus, EnvMessage, EnvReport, Vendor } from '@agenthouse/protocol';
import { claudeLoggedIn, codexLoggedIn, detectVersion } from '../cli/probe';
import { resolveCli } from '../cli/resolve';

const CACHE_MS = 60_000;
// Node lines whose security support has ended (as of 2026-11).
const EOL_MAJORS = new Set([18, 19, 20, 21, 23, 25]);

export const INSTALL_COMMAND: Record<Vendor, string> = {
  claude: 'npm i -g @anthropic-ai/claude-code',
  codex: 'npm i -g @openai/codex',
};

const LOGIN_COMMAND: Record<Vendor, string> = {
  claude: 'claude auth login',
  codex: 'codex login',
};

const NAME: Record<Vendor, string> = { claude: 'Claude Code', codex: 'Codex CLI' };

function windowsBuild(): number | null {
  if (process.platform !== 'win32') return null;
  const build = Number(os.release().split('.')[2]);
  return Number.isFinite(build) ? build : null;
}

async function probeCli(vendor: Vendor): Promise<CliStatus> {
  const resolved = resolveCli(vendor);
  const installs: CliInstall[] = await Promise.all(
    resolved.map(async (r) => ({ file: r.file, args: r.args, shim: r.shim, version: await detectVersion(r) })),
  );
  const selected = installs.length ? 0 : null;
  let loggedIn: boolean | null = null;
  const first = installs[0];
  if (first) loggedIn = vendor === 'claude' ? await claudeLoggedIn(first) : await codexLoggedIn(first);
  return { vendor, installs, selected, loggedIn };
}

function messagesFor(report: Omit<EnvReport, 'messages'>): EnvMessage[] {
  const messages: EnvMessage[] = [];
  const { claude, codex } = report.clis;

  if (!claude.installs.length && !codex.installs.length) {
    messages.push({ id: 'ENV_NO_CLI', level: 'error', text: 'Claude Code 또는 Codex CLI가 필요합니다.', command: INSTALL_COMMAND.claude });
  }
  for (const status of [claude, codex]) {
    const name = NAME[status.vendor];
    if (!status.installs.length) {
      if (claude.installs.length || codex.installs.length) {
        messages.push({ id: `ENV_${status.vendor.toUpperCase()}_MISSING`, level: 'info', text: `${name}가 설치되어 있지 않습니다.`, command: INSTALL_COMMAND[status.vendor] });
      }
      continue;
    }
    const selected = status.installs[status.selected ?? 0];
    if (status.installs.length > 1 && selected) {
      messages.push({
        id: `ENV_${status.vendor.toUpperCase()}_MULTIPLE_INSTALLS`,
        level: 'info',
        text: `${name}가 ${status.installs.length}곳에 설치되어 있습니다. 셸이 실행하는 버전(${selected.version ?? '미확인'})을 사용합니다.`,
      });
    }
    if (status.loggedIn === false) {
      messages.push({ id: `ENV_${status.vendor.toUpperCase()}_NOT_LOGGED_IN`, level: 'warn', text: `${name}에 로그인되어 있지 않습니다.`, command: LOGIN_COMMAND[status.vendor] });
    }
  }
  if (report.node.eol) {
    messages.push({ id: 'ENV_NODE_EOL', level: 'info', text: `Node.js ${report.node.major}은 보안 지원이 끝난 버전입니다.` });
  }
  return messages;
}

/** Detects the Node runtime and installed CLIs once a minute at most; CLI probes take a second or two. */
export class EnvService {
  private cached: { at: number; report: EnvReport } | null = null;
  private inflight: Promise<EnvReport> | null = null;

  constructor(private readonly defaultCwd: string) {}

  async report(refresh = false): Promise<EnvReport> {
    if (!refresh && this.cached && Date.now() - this.cached.at < CACHE_MS) return this.cached.report;
    if (this.inflight) return this.inflight;
    this.inflight = this.build().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  async cli(vendor: Vendor): Promise<CliStatus> {
    return (await this.report()).clis[vendor];
  }

  private async build(): Promise<EnvReport> {
    const major = Number(process.versions.node.split('.')[0]);
    const [claude, codex] = await Promise.all([probeCli('claude'), probeCli('codex')]);
    const base = {
      node: { version: process.versions.node, major, supported: major >= 18, eol: EOL_MAJORS.has(major) },
      platform: process.platform,
      windowsBuild: windowsBuild(),
      defaultCwd: this.defaultCwd,
      clis: { claude, codex },
    };
    const report: EnvReport = { ...base, messages: messagesFor(base) };
    this.cached = { at: Date.now(), report };
    return report;
  }
}
