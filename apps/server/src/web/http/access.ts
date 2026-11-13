import { createHmac, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { TOKEN_PROTOCOL_PREFIX } from '@agenthouse/protocol';
import { sameSecret } from '../../shared/compare';

/** How long a login code in an opened or printed address stays good. */
export const CODE_TTL_MS = 5 * 60_000;
// Codes nobody used are dropped oldest first beyond this many.
const MAX_CODES = 20;

// The cookie the login used before one-time codes. Cookies do not tell ports apart, so it went to every
// other server on 127.0.0.1 too; a page that still sends it is told to drop it.
const OLD_COOKIE = 'ah_token';

const mac = (secret: string, text: string) => createHmac('sha256', secret).update(text).digest('base64url');

function bearer(req: IncomingMessage): string | null {
  return req.headers.authorization?.match(/^Bearer (.+)$/)?.[1] ?? null;
}

/** A page's token on a WebSocket upgrade: browsers cannot set headers there, so it comes as a subprotocol. */
function socketToken(req: IncomingMessage): string | null {
  const offered = String(req.headers['sec-websocket-protocol'] ?? '')
    .split(',')
    .map((name) => name.trim());
  const entry = offered.find((name) => name.startsWith(TOKEN_PROTOCOL_PREFIX));
  return entry ? entry.slice(TOKEN_PROTOCOL_PREFIX.length) : null;
}

/**
 * The server is effectively a remote shell, so every request is checked: a Host
 * allowlist against DNS rebinding, an Origin allowlist for WebSocket upgrades and
 * state-changing requests (browsers do not apply same-origin rules to WebSockets),
 * and a credential for the API and the sockets. The page itself holds no secret
 * and is served to anyone who passes the Host check.
 *
 * Credentials derive from the session host's login secret, which never leaves the
 * server processes: a page's token, traded for a one-time login code, and the key
 * local tools use (web.json, --json). Both are bound to this port, so neither works
 * at another one, and both stay good across web server restarts while the host runs.
 */
export class AccessControl {
  private hosts = new Set<string>();
  private origins = new Set<string>();
  private port = 0;
  private readonly codes = new Map<string, number>();

  constructor(
    private readonly secret: string,
    private readonly devOrigins: string[] = [],
  ) {}

  bind(port: number): void {
    this.port = port;
    this.hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    this.origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...this.devOrigins]);
  }

  hostAllowed(req: IncomingMessage): boolean {
    return this.hosts.has(req.headers.host ?? '');
  }

  originAllowed(req: IncomingMessage): boolean {
    return this.origins.has(req.headers.origin ?? '');
  }

  /** The key for local tools (this server's web.json, --json). Never part of an address. */
  get key(): string {
    return mac(this.secret, `agenthouse-key:${this.port}`);
  }

  /** A one-time login code for an address to open, good for CODE_TTL_MS. */
  issueCode(now = Date.now()): string {
    for (const [code, until] of this.codes) if (until <= now) this.codes.delete(code);
    while (this.codes.size >= MAX_CODES) this.codes.delete(this.codes.keys().next().value!);
    const code = randomBytes(24).toString('base64url');
    this.codes.set(code, now + CODE_TTL_MS);
    return code;
  }

  /** Trades a login code for a page token; the code is spent either way. Null if it is unknown or ran out. */
  redeem(code: string, now = Date.now()): string | null {
    const until = this.codes.get(code);
    this.codes.delete(code);
    if (until === undefined || until <= now) return null;
    const nonce = randomBytes(16).toString('base64url');
    return `${nonce}.${this.pageMac(nonce)}`;
  }

  private pageMac(nonce: string): string {
    return mac(this.secret, `agenthouse-page:${this.port}:${nonce}`);
  }

  /** The key, or a page token this server gave out (this port, this host). */
  valid(candidate: string | null | undefined): boolean {
    if (!candidate) return false;
    if (sameSecret(candidate, this.key)) return true;
    const [nonce, signature, ...rest] = candidate.split('.');
    return Boolean(nonce && signature) && !rest.length && sameSecret(signature!, this.pageMac(nonce!));
  }

  /** A request with a credential: `Authorization: Bearer`, or on a WebSocket upgrade a page's subprotocol. */
  authenticated(req: IncomingMessage): boolean {
    return this.valid(bearer(req)) || this.valid(socketToken(req));
  }

  /** A local tool asking for a login code: the key, and no Origin (a page always sends one). */
  isLocalTool(req: IncomingMessage): boolean {
    const presented = bearer(req);
    return req.headers.origin === undefined && presented !== null && sameSecret(presented, this.key);
  }

  sendsOldCookie(req: IncomingMessage): boolean {
    return (req.headers.cookie ?? '').split(';').some((part) => part.trim().startsWith(`${OLD_COOKIE}=`));
  }

  static readonly clearOldCookie = `${OLD_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`;
}
