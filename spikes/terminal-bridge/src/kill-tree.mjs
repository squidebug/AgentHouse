import { execFile } from 'node:child_process';

export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Kills a process and everything it started. On Windows the tree must be walked
 * by taskkill before the pseudoconsole is closed: closing ConPTY first would leave
 * grandchildren (MCP servers, shells) running with no parent to find them by.
 */
export function killTree(pid) {
  return new Promise((resolve) => {
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
      return;
    }
    try {
      // node-pty makes the child a session leader, so the negative pid is its group.
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    resolve();
  });
}
