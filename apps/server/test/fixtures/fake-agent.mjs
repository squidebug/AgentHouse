#!/usr/bin/env node
// Stand-in for an agent CLI so the bridge can be tested without a login or network.
// At startup it asks the terminal for the cursor position and the background
// color (as real TUIs do), starts a grandchild process (like an MCP server), and
// then echoes every input chunk in escaped form.
import { spawn } from 'node:child_process';

const out = (text) => process.stdout.write(text);

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');

const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });

out('fake-agent ready\r\n');
out(`REPORT child=${grandchild.pid}\r\n`);
out('\x1b[?2004h'); // ask for bracketed paste, like Claude Code and Codex do

const waiting = { cpr: true, osc11: true };
out('\x1b[6n');
out('\x1b]11;?\x1b\\');
setTimeout(() => {
  if (waiting.cpr) out('REPORT cpr=timeout\r\n');
  if (waiting.osc11) out('REPORT osc11=timeout\r\n');
  waiting.cpr = false;
  waiting.osc11 = false;
}, 1500);

process.stdin.on('data', (chunk) => {
  let rest = chunk;
  // Only the first reply to each startup query counts; any later one is echoed
  // as input, which is how a leaked duplicate reply would show up.
  rest = rest.replace(/\x1b\[(\d+);(\d+)R/, (whole, row, col) => {
    if (!waiting.cpr) return whole;
    waiting.cpr = false;
    out(`REPORT cpr=${row};${col}\r\n`);
    return '';
  });
  rest = rest.replace(/\x1b\]11;(rgb:[0-9a-fA-F/]+)(?:\x07|\x1b\\)/, (whole, rgb) => {
    if (!waiting.osc11) return whole;
    waiting.osc11 = false;
    out(`REPORT osc11=${rgb}\r\n`);
    return '';
  });
  if (!rest) return;
  out(`IN ${JSON.stringify(rest)}\r\n`);
  // A burst far larger than any viewer may fall behind by.
  if (rest.includes('flood')) {
    const line = `${'x'.repeat(150)}\r\n`;
    for (let i = 0; i < 40_000; i += 1) out(line);
    out('flood done\r\n');
  }
  // Stands in for a turn in progress: output keeps coming for two seconds.
  if (rest.includes('stream')) {
    let tick = 0;
    const timer = setInterval(() => {
      tick += 1;
      out(`tick ${tick}\r\n`);
      if (tick === 40) {
        clearInterval(timer);
        out('stream done\r\n');
      }
    }, 50);
  }
  if (rest.includes('exit') || rest.includes('\x03')) {
    grandchild.kill();
    out('bye\r\n');
    process.exit(0);
  }
});
