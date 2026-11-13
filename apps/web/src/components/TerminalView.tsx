import '@xterm/xterm/css/xterm.css';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';
import { useEffect, useRef } from 'react';
import { isAutoResponse, type TerminalClientMessage, type TerminalServerMessage, type ThemeMode } from '@agenthouse/protocol';
import { openSocket } from '../api/client';
import { linkTarget } from '../links';
import { t } from '../strings';
import { FONT_MONO } from '../theme/theme';
import { MIN_CONTRAST, XTERM_THEMES } from '../theme/terminal';

// xterm measures the font once when it opens; measuring a fallback font would
// leave every cell the wrong width.
const fontsReady: Promise<unknown> =
  typeof document === 'undefined'
    ? Promise.resolve()
    : Promise.all([document.fonts.load('13px "JetBrains Mono"'), document.fonts.load('13px "Nanum Gothic Coding"', '가')]).catch(() => undefined);

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
const RESIZE_SETTLE_MS = 100;

/**
 * A link a CLI wrote into its output (OSC 8), clicked: its text may differ from
 * where it goes, so the real address is shown first. xterm makes links of web
 * addresses only; its own handler asks in English and opens on any mouse button.
 */
function openLink(event: MouseEvent, uri: string): void {
  if (event.button !== 0) return;
  const target = linkTarget(uri);
  if (target && window.confirm(`${t.openLink}\n\n${target}`)) window.open(target, '_blank', 'noopener,noreferrer');
}

interface Props {
  sessionId: string;
  mode: ThemeMode;
  windowsBuild: number | null;
  onFocus?: () => void;
  /** In the pane the user works in: takes the keyboard when it opens, unless something else has it. */
  autoFocus?: boolean;
}

export function TerminalView({ sessionId, mode, windowsBuild, onFocus, autoFocus = false }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const sendRef = useRef<(message: TerminalClientMessage) => void>(() => {});
  const modeRef = useRef(mode);
  const focusRef = useRef(onFocus);
  const autoFocusRef = useRef(autoFocus);
  modeRef.current = mode;
  focusRef.current = onFocus;
  autoFocusRef.current = autoFocus;

  useEffect(() => {
    let disposed = false;
    let teardown = () => {};

    fontsReady.then(() => {
      const element = host.current;
      if (disposed || !element) return;
      const term = new Terminal({
        allowProposedApi: true,
        cursorBlink: true,
        fontFamily: FONT_MONO,
        fontSize: 13,
        lineHeight: 1.15,
        scrollback: 5000,
        theme: XTERM_THEMES[modeRef.current],
        minimumContrastRatio: MIN_CONTRAST[modeRef.current],
        ...(windowsBuild ? { windowsPty: { backend: 'conpty' as const, buildNumber: windowsBuild } } : {}),
        linkHandler: { activate: openLink },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.loadAddon(new Unicode11Addon());
      term.unicode.activeVersion = '11';
      term.open(element);
      try {
        const webgl = new WebglAddon();
        // The GPU can take the context away (the PC slept, a driver restarted) and the canvas then
        // stays blank. Without the addon xterm draws with its DOM renderer, from the same buffer.
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        // DOM renderer fallback (no WebGL)
      }
      termRef.current = term;

      let ws: WebSocket | null = null;
      let owner = false;
      let retry: ReturnType<typeof setTimeout> | undefined;
      let delay = 500;

      const send = (message: TerminalClientMessage) => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
      };
      sendRef.current = send;
      const reportSize = () => {
        if (!owner) return;
        fit.fit();
        const dims = fit.proposeDimensions();
        if (dims && dims.cols > 0 && dims.rows > 0) send({ type: 'resize', cols: dims.cols, rows: dims.rows });
      };

      const connect = () => {
        ws = openSocket(`/ws/session?id=${encodeURIComponent(sessionId)}`);
        ws.onopen = () => {
          delay = 500;
          send({ type: 'theme', mode: modeRef.current });
          send({ type: 'claim' });
        };
        ws.onmessage = (event) => {
          const message = JSON.parse(String(event.data)) as TerminalServerMessage;
          if (message.type === 'snapshot') {
            if (!owner) term.resize(message.cols, message.rows);
            // Reset through the write queue (RIS): output still queued from before cannot land on top of the snapshot.
            term.write(`\x1bc${message.data}`);
          } else if (message.type === 'output') {
            term.write(message.data);
          } else if (message.type === 'size') {
            if (!owner) term.resize(message.cols, message.rows);
          } else if (message.type === 'owner') {
            owner = message.you;
            reportSize();
          }
        };
        ws.onclose = () => {
          owner = false;
          if (disposed) return;
          retry = setTimeout(connect, delay);
          delay = Math.min(delay * 2, 8000);
        };
      };
      connect();

      // xterm answers terminal queries through onData too; the server's mirror
      // already did, so a second reply must not reach the CLI.
      const dataSub = term.onData((data) => {
        if (!isAutoResponse(data)) send({ type: 'input', data });
      });
      // Windows Terminal's keys: Ctrl+C copies a selection (without one it interrupts, as always) and
      // Ctrl+V pastes; Ctrl+Shift+C/V too. On a Mac, Cmd+C/V do that already and Ctrl keeps its terminal meaning.
      term.attachCustomKeyEventHandler((event) => {
        if (MAC || event.type !== 'keydown' || !event.ctrlKey || event.altKey || event.metaKey) return true;
        if (event.code === 'KeyC' && (event.shiftKey || term.hasSelection())) {
          const selected = term.getSelection();
          if (selected) navigator.clipboard?.writeText(selected).catch(() => {});
          term.clearSelection();
          event.preventDefault();
          return false;
        }
        // Left to the browser: its paste reaches xterm as a paste (bracketed, when the CLI asked for that).
        return event.code !== 'KeyV';
      });
      const binarySub = term.onBinary((data) => send({ type: 'input', data, binary: true }));
      const onFocusIn = () => {
        send({ type: 'claim' });
        focusRef.current?.();
      };
      term.textarea?.addEventListener('focus', onFocusIn);
      // A window being dragged changes size on every frame; the PTY (and the CLI, which redraws) is told once it settles.
      let settling: ReturnType<typeof setTimeout> | undefined;
      const observer = new ResizeObserver(() => {
        clearTimeout(settling);
        settling = setTimeout(reportSize, RESIZE_SETTLE_MS);
      });
      observer.observe(element);
      // Back from the conversation (Ctrl+`) or after a reload: ready to type, unless the composer or another field has the keyboard.
      const idle = document.activeElement === null || document.activeElement === document.body;
      if (autoFocusRef.current && idle) term.focus();

      teardown = () => {
        clearTimeout(retry);
        clearTimeout(settling);
        observer.disconnect();
        term.textarea?.removeEventListener('focus', onFocusIn);
        dataSub.dispose();
        binarySub.dispose();
        ws?.close();
        term.dispose();
        termRef.current = null;
        sendRef.current = () => {};
      };
    });

    return () => {
      disposed = true;
      teardown();
    };
  }, [sessionId, windowsBuild]);

  useEffect(() => {
    const term = termRef.current;
    if (term) {
      term.options.theme = XTERM_THEMES[mode];
      term.options.minimumContrastRatio = MIN_CONTRAST[mode];
    }
    sendRef.current({ type: 'theme', mode });
  }, [mode]);

  return <div ref={host} style={{ width: '100%', height: '100%' }} />;
}
