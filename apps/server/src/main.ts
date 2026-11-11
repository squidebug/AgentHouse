import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostClient } from './host/client';
import { defaultStateDir } from './host/state';
import { createAgentHouseServer, type AgentHouseServer } from './http/server';

const DEFAULT_PORT = 7357;

interface Args {
  port: number | null;
  open: boolean;
  json: boolean;
  devOrigins: string[];
  allowFake: boolean;
  cwd: string | null;
  stop: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { port: null, open: false, json: false, devOrigins: [], allowFake: false, cwd: null, stop: false };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--port') args.port = Number(argv[++i]);
    else if (flag === '--open') args.open = true;
    else if (flag === '--json') args.json = true;
    else if (flag === '--dev-origin') args.devOrigins.push(String(argv[++i]));
    else if (flag === '--allow-fake') args.allowFake = true;
    else if (flag === '--cwd') args.cwd = String(argv[++i]);
    else if (flag === '--stop') args.stop = true;
  }
  return args;
}

function openBrowser(url: string): void {
  const [cmd, cmdArgs] =
    process.platform === 'win32' ? ['explorer.exe', [url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  execFile(cmd, cmdArgs, { windowsHide: true }, () => {});
}

async function listen(args: Args, options: Omit<Parameters<typeof createAgentHouseServer>[0], 'port'>): Promise<AgentHouseServer> {
  if (args.port !== null) return createAgentHouseServer({ ...options, port: args.port });
  // The default port keeps bookmarks working; fall back to the next ones if it is taken.
  for (let port = DEFAULT_PORT; port < DEFAULT_PORT + 10; port += 1) {
    try {
      return await createAgentHouseServer({ ...options, port });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
  return createAgentHouseServer({ ...options, port: 0 });
}

/** `--stop`: ends every session and the session host. */
async function stopHost(): Promise<void> {
  const host = await HostClient.connect({ stateDir: defaultStateDir(), spawn: false }).catch(() => null);
  if (!host) {
    process.stdout.write('실행 중인 세션 호스트가 없습니다.\n');
    return;
  }
  const { closed } = await host.shutdown();
  host.close();
  process.stdout.write(closed ? `세션 ${closed}개를 끝냈습니다.\n` : '세션 호스트를 끝냈습니다.\n');
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
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDist = path.resolve(here, '../../web/dist');
  const fakeAgentPath = path.resolve(here, '../test/fixtures/fake-agent.mjs');
  // The dev runner passes one token for the whole session so `tsx watch` restarts keep the browser logged in.
  const devToken = process.env.AGENTHOUSE_TOKEN;

  const host = await HostClient.connect({ stateDir: defaultStateDir(), spawn: true, ...(devToken ? { webToken: devToken } : {}) });
  const app = await listen(args, {
    host,
    ...(devToken ? { token: devToken } : {}),
    devOrigins: args.devOrigins,
    defaultCwd: args.cwd ?? process.cwd(),
    ...(existsSync(path.join(webDist, 'index.html')) && !args.devOrigins.length ? { webDist } : {}),
    ...(args.allowFake ? { fakeAgentPath } : {}),
  });

  if (args.json) process.stdout.write(`${JSON.stringify({ url: app.url, port: app.port, token: app.token })}\n`);
  else {
    process.stdout.write(`AgentHouse  ${app.url}\n`);
    if (running(host)) process.stdout.write(`실행 중인 세션 ${running(host)}개에 다시 연결했습니다.\n`);
  }
  if (args.open) openBrowser(app.url);

  let closing = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    const left = running(host);
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
