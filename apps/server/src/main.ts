import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findOnPath } from './web/cli/resolve';
import { doctor } from './web/doctor-command';
import { HostClient, stopHosts } from './web/host-client';
import { defaultStateDir, webLogger } from './shared/state';
import { createAgentHouseServer } from './web/http/server';
import { forgetWebServer, recordWebServer, runningWebServer, stopWebServer } from './web/instance';
import { stateDirProblem } from './web/state-dir';
import { systemTool } from './shared/system';

const DEFAULT_PORT = 7357;
// When the default port is taken. 7358 is left to `pnpm dev`.
const FALLBACK_PORTS = [7359, 7360, 7361, 7362, 7363, 7364, 7365, 7366, 0];

interface Args {
  port: number | null;
  open: boolean;
  json: boolean;
  devOrigins: string[];
  allowFake: boolean;
  cwd: string | null;
  stop: boolean;
  /** `doctor`: check the environment and exit. */
  doctor: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { port: null, open: false, json: false, devOrigins: [], allowFake: false, cwd: null, stop: false, doctor: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--port') args.port = Number(argv[++i]);
    else if (flag === '--open') args.open = true;
    else if (flag === '--json') args.json = true;
    else if (flag === '--dev-origin') args.devOrigins.push(String(argv[++i]));
    else if (flag === '--allow-fake') args.allowFake = true;
    else if (flag === '--cwd') args.cwd = String(argv[++i]);
    else if (flag === '--stop') args.stop = true;
    else if (flag === 'doctor') args.doctor = true;
  }
  return args;
}

// By absolute path: a bare name could run a same-named file from the current folder.
function openBrowser(url: string): void {
  const opener =
    process.platform === 'win32' ? systemTool('explorer.exe') : process.platform === 'darwin' ? '/usr/bin/open' : findOnPath('xdg-open')[0];
  if (opener) execFile(opener, [url], { windowsHide: true }, () => {});
}

/** `--stop`: ends the web server, every session and the session host, and hosts of older protocol versions too. */
async function stopHost(): Promise<void> {
  const stateDir = defaultStateDir();
  if (await stopWebServer(stateDir)) process.stdout.write('웹 서버를 끝냈습니다.\n');
  const { hosts, sessions } = await stopHosts(stateDir);
  if (!hosts) {
    process.stdout.write('실행 중인 세션 호스트가 없습니다.\n');
    return;
  }
  process.stdout.write(sessions ? `세션 ${sessions}개를 끝냈습니다.\n` : '세션 호스트를 끝냈습니다.\n');
}

const running = (host: HostClient) => host.sessions().filter((s) => s.state === 'running').length;

async function main(): Promise<void> {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 18) {
    console.error(`Node.js 18 이상이 필요합니다. (현재 ${process.version})`);
    process.exit(1);
  }
  const args = parseArgs(process.argv.slice(2));
  if (args.stop) {
    await stopHost();
    return;
  }
  if (args.doctor) {
    process.exitCode = await doctor({ stateDir: defaultStateDir(), port: DEFAULT_PORT, stopCommand: 'pnpm stop', installCommand: 'pnpm install', json: args.json });
    return;
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDist = path.resolve(here, '../../web/dist');
  const fakeAgentPath = path.resolve(here, '../test/fixtures/fake-agent.mjs');
  // Only the dev runner passes --dev-origin; its sessions run in the dev host.
  const dev = args.devOrigins.length > 0;
  const stateDir = defaultStateDir();
  // The host's token and the web server's key go there.
  const problem = await stateDirProblem(stateDir);
  if (problem) {
    console.error(`상태 폴더 ${stateDir}: ${problem}\n토큰을 두는 폴더라 시작하지 않습니다. AGENTHOUSE_HOME을 나만 쓰는 폴더로 바꾸세요.`);
    process.exit(1);
  }

  // One web server per state folder: a second start opens the first one. The dev runner restarts its own server.
  const already = dev ? null : await runningWebServer(stateDir);
  if (already) {
    if (args.json) process.stdout.write(`${JSON.stringify({ url: already.loginUrl, port: already.port, key: already.key })}\n`);
    else process.stdout.write(`AgentHouse  ${already.loginUrl}\n이미 실행 중입니다.\n`);
    if (args.open) openBrowser(already.loginUrl);
    return;
  }

  // A failed request or socket must not take every tab down; the sessions live on in the host either way.
  // Also in logs/web.log: the console this was started from may be gone, or far up.
  const log = webLogger(stateDir);
  const report = (kind: string) => (error: unknown) => {
    const text = `${kind}: ${(error as Error)?.stack ?? error}`;
    console.error(text);
    log(text);
  };
  process.on('uncaughtException', report('uncaught'));
  process.on('unhandledRejection', report('unhandled'));

  const host = await HostClient.connect({ stateDir, spawn: true });
  const app = await createAgentHouseServer({
    // The default port keeps bookmarks and logins working; the next ones if it is taken.
    port: args.port ?? DEFAULT_PORT,
    ...(args.port === null ? { fallbackPorts: FALLBACK_PORTS } : {}),
    host,
    devOrigins: args.devOrigins,
    stopCommand: dev ? 'pnpm dev:stop' : 'pnpm stop',
    startCommand: dev ? 'pnpm dev' : 'pnpm start',
    defaultCwd: args.cwd ?? process.cwd(),
    ...(existsSync(path.join(webDist, 'index.html')) && !dev ? { webDist } : {}),
    ...(args.allowFake ? { fakeAgentPath } : {}),
  });
  if (!dev) recordWebServer(stateDir, { port: app.port, url: app.url, key: app.key });

  // A one-time code: the address is spent once a browser has opened it.
  const loginUrl = app.loginUrl();
  if (args.json) process.stdout.write(`${JSON.stringify({ url: loginUrl, port: app.port, key: app.key })}\n`);
  else {
    process.stdout.write(`AgentHouse  ${loginUrl}\n`);
    // Another port is another origin: bookmarks and logins of the usual one do not carry over.
    if (args.port === null && app.port !== DEFAULT_PORT) process.stdout.write(`기본 포트 ${DEFAULT_PORT}을 다른 프로그램이 쓰고 있어 ${app.port}에서 열었습니다.\n`);
    if (running(host)) process.stdout.write(`실행 중인 세션 ${running(host)}개에 다시 연결했습니다.\n`);
  }
  if (args.open) openBrowser(loginUrl);

  let closing = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    const left = running(host);
    forgetWebServer(stateDir);
    await app.close();
    host.close();
    if (signal === 'SIGINT' && left && !args.json) process.stdout.write(`세션 ${left}개는 계속 실행됩니다. 모두 끝내려면: pnpm stop\n`);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
