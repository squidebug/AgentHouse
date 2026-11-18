import { LOGIN_EXPIRED, type ApiError, type LoginRequest, type LoginResult } from '@agenthouse/protocol';

// The page's token. Browsers keep storage apart per port, so no other server on 127.0.0.1 can read it.
const KEY = 'ah-token';

function stored(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

let token = stored();

/** What the page shows instead of the workspace while it is not logged in. */
export interface LoginNeeded {
  /** The address it was opened with was used already or ran out. */
  expired: boolean;
  /** What gives a new login address, as the server says (e.g. `pnpm start`). */
  command: string | null;
}

let needed: LoginNeeded | null = null;
const listeners = new Set<() => void>();

export const authToken = () => token;
export const loginNeeded = () => needed;

export function onLoginChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Another tab of this address logged in (a new login address opens a new tab): this one goes on with its token.
window.addEventListener('storage', (event) => {
  if (event.key !== KEY) return;
  token = event.newValue;
  if (token) needed = null;
  for (const listener of listeners) listener();
});

function setToken(next: string | null): void {
  token = next;
  try {
    if (next) localStorage.setItem(KEY, next);
    else localStorage.removeItem(KEY);
  } catch {
    // kept for this page only
  }
}

/**
 * The server refused `refused`, the token a request went out with (or none): drop it and
 * show the login page. A token that came since (a login meanwhile) stays.
 */
export function requireLogin(command: string | null, refused: string | null): void {
  if (refused !== token) return;
  setToken(null);
  needed = { expired: needed?.expired ?? false, command: command ?? needed?.command ?? null };
  for (const listener of listeners) listener();
}

let redeeming: Promise<void> | null = null;

/**
 * Trades the one-time code in the address, if there is one, for a token, and
 * takes the code out of the address. A spent code with a token kept from before
 * changes nothing; without one the login page says the address ran out. Once per
 * page: a second call (React runs effects twice in development) waits for the first.
 */
export function redeemLoginCode(): Promise<void> {
  redeeming ??= redeem();
  return redeeming;
}

async function redeem(): Promise<void> {
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  if (!code) return;
  url.searchParams.delete('code');
  history.replaceState(history.state, '', url.pathname + url.search + url.hash);
  try {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code } satisfies LoginRequest) });
    const data = (await res.json().catch(() => null)) as (LoginResult & Partial<ApiError>) | null;
    if (res.ok && data?.token) {
      setToken(data.token);
      needed = null;
      return;
    }
    if (!token) needed = { expired: data?.code === LOGIN_EXPIRED, command: data?.command ?? null };
  } catch {
    // The server is not there; the workspace shows that, or the login page once it answers.
  }
}
