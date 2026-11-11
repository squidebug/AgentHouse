// Terminals answer some escape-sequence queries on their own: cursor position,
// device attributes, colors. Only the server-side mirror may answer them.
// Otherwise a session nobody is watching stalls on its startup queries, and a
// session with two viewers gets every reply typed into the CLI twice.
// This module has no Node imports so the browser can load the same file.

const AUTO_RESPONSES = [
  /^\x1b\[\d+;\d+R$/, // cursor position report (DSR 6); note: identical to Shift+F3 (CSI 1;2R)
  /^\x1b\[\?\d+(;\d+)*R$/, // extended cursor position report
  /^\x1b\[[?>=][\d;]*c$/, // device attributes (primary, secondary, tertiary)
  /^\x1b\[\??\d+;\d+\$y$/, // mode report (DECRQM)
  /^\x1b\[\d+(;\d+)+t$/, // window size reports
  /^\x1b\[[03]n$/, // device status report
  /^\x1b\](?:4;\d+|1[0-2]);rgb:[0-9a-f]+\/[0-9a-f]+\/[0-9a-f]+(?:\x07|\x1b\\)$/i, // color reports
  /^\x1bP[\s\S]*\x1b\\$/, // DCS replies (XTVERSION, DECRQSS)
];

export function isAutoResponse(data) {
  return AUTO_RESPONSES.some((pattern) => pattern.test(data));
}

const COLOR_REPORT = /^\x1b\](?:1[01]);rgb:/;
const COLOR_QUERY = /\x1b\](1[01]);\?(\x07|\x1b\\)/g;

function toXtermRgb(hex) {
  const value = hex.replace('#', '');
  const channel = (i) => value.slice(i, i + 2).repeat(2);
  return `rgb:${channel(0)}/${channel(2)}/${channel(4)}`;
}

/**
 * Answers OSC 10/11 (foreground/background color) queries with the colors the
 * browser terminal is actually using, so CLIs that pick a light or dark theme
 * from the background (Claude Code `theme: auto`) see the app's current theme.
 */
export class ColorQueryResponder {
  constructor(colors) {
    this.colors = colors;
    this.carry = '';
  }

  setColors(colors) {
    this.colors = colors;
  }

  /** True for a color reply produced elsewhere (e.g. by the headless mirror). */
  isColorReport(data) {
    return COLOR_REPORT.test(data);
  }

  /** Returns the replies owed for any color queries in this chunk of output. */
  scan(output) {
    const text = this.carry + output;
    const replies = [];
    let consumed = 0;
    for (const match of text.matchAll(COLOR_QUERY)) {
      const which = match[1] === '10' ? this.colors.foreground : this.colors.background;
      replies.push(`\x1b]${match[1]};${toXtermRgb(which)}${match[2]}`);
      consumed = match.index + match[0].length;
    }
    // Keep a possible split query (ESC ] 1 1 ; ...) for the next chunk.
    const tail = text.slice(consumed);
    const start = tail.lastIndexOf('\x1b]');
    this.carry = start !== -1 && tail.length - start < 8 ? tail.slice(start) : '';
    return replies;
  }
}
