// What a page keeps open to the web server: the events of everything it lists
// (/ws/events), a conversation as it is read and grows (/ws/conversation), and a
// session's terminal, relayed to the session host (/ws/session). A socket is let
// in like a request that changes something: by its Host, its Origin and its login.
import http, { type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { SOCKET_PROTOCOL, type EventServerMessage } from '@agenthouse/protocol';
import type { Conversations } from '../conversations';
import type { Delegations } from '../delegations';
import type { SessionManager } from '../manager';
import type { AccessControl } from './access';
import { agentParam, TerminalClient } from './schemas';

// A browser that falls behind stops being read for; the host's backlog for it
// then grows and the host resyncs it from a snapshot. The PTY never waits.
const RELAY_HIGH_WATER = 1024 * 1024;
const RELAY_LOW_WATER = 256 * 1024;
// A page's first list waits this long at most for Claude's own list of sessions (one call is about half a second).
const FIRST_LOOK_MS = 2500;

/** Relays one browser terminal socket to the session's terminal on the host. */
function relayTerminal(browser: WebSocket, upstream: WebSocket): void {
  const early: string[] = [];
  let draining: NodeJS.Timeout | undefined;
  const stopDraining = () => clearInterval(draining);

  upstream.on('open', () => {
    for (const text of early) upstream.send(text);
    early.length = 0;
  });
  upstream.on('message', (data, isBinary) => {
    if (browser.readyState !== browser.OPEN) return;
    browser.send(data, { binary: isBinary });
    if (browser.bufferedAmount > RELAY_HIGH_WATER && !upstream.isPaused) {
      upstream.pause();
      draining = setInterval(() => {
        if (browser.readyState === browser.OPEN && browser.bufferedAmount > RELAY_LOW_WATER) return;
        stopDraining();
        upstream.resume();
      }, 50);
    }
  });
  // The session was removed or the host went away; the browser reconnects by itself.
  const end = () => {
    stopDraining();
    browser.close();
  };
  upstream.on('close', end);
  upstream.on('error', end);

  browser.on('message', (raw) => {
    let message;
    try {
      message = TerminalClient.parse(JSON.parse(raw.toString()));
    } catch {
      return;
    }
    const text = JSON.stringify(message);
    if (upstream.readyState === upstream.OPEN) upstream.send(text);
    else if (upstream.readyState === upstream.CONNECTING) early.push(text);
  });
  browser.on('close', () => {
    stopDraining();
    upstream.terminate();
  });
}

export interface SocketServices {
  access: AccessControl;
  manager: SessionManager;
  conversations: Conversations;
  delegations: Delegations;
  /** A socket to one session's terminal on the session host. */
  openTerminal(sessionId: string): WebSocket;
  /** Whether the sessions started outside AgentHouse are watched (the user's choice): a page is told with its first lists. */
  external(): boolean;
  /** A page came or went. */
  onPages(): void;
}

export interface Sockets {
  /** How many pages are open. */
  pages(): number;
  /** Tells every page that has had its first lists. */
  broadcast(message: EventServerMessage): void;
  /** Ends every socket and stops telling the pages of changes. */
  close(): void;
}

/** Takes the WebSockets of this server from now on. */
export function attachSockets(server: http.Server, { access, manager, conversations, delegations, openTerminal, external, onPages }: SocketServices): Sockets {
  // The pages that are open, and those of them that have their first lists and get every change.
  const pages = new Set<WebSocket>();
  const listed = new Set<WebSocket>();
  const terminals = new Set<WebSocket>();
  const viewers = new Set<WebSocket>();

  const broadcast = (message: EventServerMessage) => {
    const text = JSON.stringify(message);
    for (const ws of listed) if (ws.readyState === ws.OPEN) ws.send(text);
  };
  const tellSessions = () => broadcast({ type: 'sessions', sessions: manager.list() });
  const tellLimits = () => broadcast({ type: 'limits', limits: manager.limits() });
  const tellLinks = () => broadcast({ type: 'links', links: manager.links() });
  const tellDelegations = () => broadcast({ type: 'delegations', delegations: delegations.list() });
  delegations.on('change', tellDelegations);
  manager.on('change', tellSessions);
  manager.on('limits', tellLimits);
  manager.on('links', tellLinks);

  /** The events of a page: its first lists, then every change. */
  const events = (ws: WebSocket) => {
    pages.add(ws);
    ws.on('close', () => {
      pages.delete(ws);
      listed.delete(ws);
      onPages();
    });
    onPages();
    // The first list a page gets has the sessions started elsewhere in it: a pane restored to one
    // of them would close on a list without it. Until Claude has been asked once, the page gets
    // no list at all.
    const looked = manager.externalReady(FIRST_LOOK_MS).catch(() => {});
    void looked.then(() => {
      if (ws.readyState !== ws.OPEN) return;
      listed.add(ws);
      const first: EventServerMessage[] = [
        { type: 'sessions', sessions: manager.list() },
        { type: 'limits', limits: manager.limits() },
        { type: 'links', links: manager.links() },
        { type: 'delegations', delegations: delegations.list() },
        { type: 'external', on: external() },
      ];
      for (const message of first) ws.send(JSON.stringify(message));
    });
  };

  /** A session's conversation, or one of its sub-agents'. `turnsOnly`: the turns without the entries, for a view that only shows when the session worked. */
  const conversation = (ws: WebSocket, id: string, agent: string | null, turnsOnly: boolean) => {
    const unsubscribe = conversations.subscribe(
      id,
      (message) => {
        if (ws.readyState !== ws.OPEN) return;
        if (!turnsOnly) return ws.send(JSON.stringify(message));
        if (message.type === 'update' && !message.turns.length) return;
        ws.send(JSON.stringify({ ...message, entries: [] }));
      },
      agent,
    );
    if (!unsubscribe) return ws.close();
    viewers.add(ws);
    ws.on('close', () => {
      viewers.delete(ws);
      unsubscribe();
    });
  };

  const terminal = (ws: WebSocket, sessionId: string) => {
    terminals.add(ws);
    ws.on('close', () => terminals.delete(ws));
    relayTerminal(ws, openTerminal(sessionId));
  };

  // A page offers `agenthouse` and its token as subprotocols; the server answers with `agenthouse`, never the token.
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 2 * 1024 * 1024,
    handleProtocols: (protocols) => (protocols.has(SOCKET_PROTOCOL) ? SOCKET_PROTOCOL : false),
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    const reject = (status: number) => {
      socket.write(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    const open = (attach: (ws: WebSocket) => void) =>
      wss.handleUpgrade(req, socket, head, (ws) => {
        // A socket's error (a frame over maxPayload, a peer gone mid-frame) closes that socket only: ws
        // closes it by itself (1009 for a frame too big). Without a listener it would be thrown, and the
        // web server with every tab would go.
        ws.on('error', () => {});
        attach(ws);
      });
    if (!access.hostAllowed(req) || !access.originAllowed(req)) return reject(403);
    if (!access.authenticated(req)) return reject(401);
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/ws/events') return open(events);
    if (url.pathname === '/ws/conversation') {
      const id = url.searchParams.get('id') ?? '';
      const agent = agentParam(url);
      if (agent === undefined || !conversations.available(id, agent)) return reject(404);
      const turnsOnly = url.searchParams.get('turns') === 'only';
      return open((ws) => conversation(ws, id, agent, turnsOnly));
    }
    const sessionId = url.pathname === '/ws/session' ? (url.searchParams.get('id') ?? '') : '';
    // Only the session host has terminals; an ended session from an earlier host has none.
    if (!sessionId || !manager.get(sessionId)?.screen) return reject(404);
    open((ws) => terminal(ws, sessionId));
  });

  return {
    pages: () => pages.size,
    broadcast,
    close() {
      delegations.off('change', tellDelegations);
      manager.off('change', tellSessions);
      manager.off('limits', tellLimits);
      manager.off('links', tellLinks);
      for (const ws of viewers) ws.terminate();
      for (const ws of pages) ws.close();
      for (const ws of terminals) ws.terminate();
      wss.close();
    },
  };
}
