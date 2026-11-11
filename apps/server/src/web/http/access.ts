import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export const COOKIE = 'ah_token';

function readCookie(req: IncomingMessage, name: string): string | null {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return rest.join('=');
  }
  return null;
}

/**
 * The server is effectively a remote shell, so every request is checked:
 * a per-launch token (cookie or bearer), a Host allowlist against DNS rebinding,
 * and an Origin allowlist for WebSocket upgrades and state-changing requests
 * (browsers do not apply same-origin rules to WebSockets).
 */
export class AccessControl {
  private hosts = new Set<string>();
  private origins = new Set<string>();

  constructor(
    readonly token: string,
    private readonly devOrigins: string[] = [],
  ) {}

  bind(port: number): void {
    this.hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
    this.origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, ...this.devOrigins]);
  }

  hostAllowed(req: IncomingMessage): boolean {
    return this.hosts.has(req.headers.host ?? '');
  }

  originAllowed(req: IncomingMessage): boolean {
    return this.origins.has(req.headers.origin ?? '');
  }

  tokenMatches(candidate: string | null | undefined): boolean {
    if (!candidate) return false;
    const a = Buffer.from(candidate);
    const b = Buffer.from(this.token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  authenticated(req: IncomingMessage): boolean {
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
    return this.tokenMatches(readCookie(req, COOKIE)) || this.tokenMatches(bearer);
  }

  loginCookie(): string {
    return `${COOKIE}=${this.token}; HttpOnly; SameSite=Strict; Path=/`;
  }
}
