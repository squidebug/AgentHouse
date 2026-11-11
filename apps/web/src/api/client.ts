import type { ApiError, ComposeRequest, ComposeResult, EnvReport, LaunchOptions, SessionInfo } from '@agenthouse/protocol';

export class RequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly command?: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = (data ?? {}) as Partial<ApiError>;
    throw new RequestError(err.error ?? res.statusText, res.status, err.code, err.command);
  }
  return data as T;
}

export const api = {
  env: (refresh = false) => call<EnvReport>('GET', refresh ? '/api/env?refresh=1' : '/api/env'),
  launch: (opts: LaunchOptions) => call<SessionInfo>('POST', '/api/sessions', opts),
  remove: (id: string) => call<unknown>('DELETE', `/api/sessions/${encodeURIComponent(id)}`),
  compose: (id: string, req: ComposeRequest) => call<ComposeResult>('POST', `/api/sessions/${encodeURIComponent(id)}/compose`, req),
};

export function socketUrl(path: string): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${location.host}${path}`;
}
