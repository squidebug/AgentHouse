import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAlive } from '../util/kill-tree';
import { probeHost } from './client';
import { createSessionHost } from './server';
import { defaultStateDir, hostLogger, readState } from './state';

// Long enough to ride out a web server restart, short enough not to linger.
const DEFAULT_IDLE_EXIT_MS = 30_000;

interface Args {
  detach: boolean;
  stateDir: string;
  idleExitMs: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { detach: false, stateDir: defaultStateDir(), idleExitMs: DEFAULT_IDLE_EXIT_MS };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--detach') args.detach = true;
    else if (flag === '--state-dir') args.stateDir = String(argv[++i]);
    else if (flag === '--idle-exit-ms') {
      const ms = Number(argv[++i]);
      if (Number.isFinite(ms) && ms >= 0) args.idleExitMs = ms;
    }
  }
  return args;
}

const argv = process.argv.slice(2);
const args = parseArgs(argv);

async function main(): Promise<void> {
  if (args.detach) {
    // Started by a web server: start the real host as a separate windowless
    // process and leave at once. The host then belongs to no process tree, so
    // stopping the web server with a tree kill (taskkill /T) cannot reach it.
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url), ...argv.filter((a) => a !== '--detach')], {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    return;
  }

  const log = hostLogger(args.stateDir);
  process.on('uncaughtException', (error) => log(`uncaught: ${error.stack ?? error}`));
  process.on('unhandledRejection', (error) => log(`unhandled: ${(error as Error)?.stack ?? error}`));

  const existing = readState(args.stateDir);
  if (existing && existing.pid !== process.pid && isAlive(existing.pid) && (await probeHost(existing))) {
    log(`host ${existing.pid} is already running`);
    return;
  }

  const host = await createSessionHost({
    stateDir: args.stateDir,
    idleExitMs: args.idleExitMs,
    ...(process.env.AGENTHOUSE_WEB_TOKEN ? { webToken: process.env.AGENTHOUSE_WEB_TOKEN } : {}),
    log,
  });
  log(`listening on 127.0.0.1:${host.port}`);

  let stopping = false;
  const stop = async (reason: string) => {
    if (stopping) return;
    stopping = true;
    log(`stopping: ${reason}`);
    await host.close();
    process.exit(0);
  };
  host.done.then((reason) => stop(reason));
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));
}

main().catch((error) => {
  hostLogger(args.stateDir)(`failed to start: ${(error as Error).stack ?? error}`);
  process.exit(1);
});
