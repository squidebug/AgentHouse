import {
  AUTH_REQUIRED,
  SOCKET_PROTOCOL,
  TOKEN_PROTOCOL_PREFIX,
  type ApiError,
  type ChooseCliRequest,
  type CliStatus,
  type ComposeRequest,
  type ComposeResult,
  type DelegationInfo,
  type EntryDetail,
  type EnvReport,
  type ExternalRequest,
  type LatestWords,
  type LaunchOptions,
  type LinkKind,
  type MemoryFile,
  type SessionInfo,
  type SessionLink,
  type SkillInfo,
  type TextFile,
  type ThemeMode,
  type UsageHistory,
  type Vendor,
} from '@agenthouse/protocol';
import { lang } from '../strings';
import { authToken, requireLogin } from './auth';

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
  const token = authToken();
  // What the server says back to the user (a refusal, the environment check) is in the language the page speaks.
  const headers: Record<string, string> = { 'accept-language': lang, ...(token ? { authorization: `Bearer ${token}` } : {}) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(path, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    // not JSON: an error page from something else on this port
  }
  if (!res.ok) {
    const err = (data ?? {}) as Partial<ApiError>;
    if (res.status === 401 && err.code === AUTH_REQUIRED) requireLogin(err.command ?? null, token);
    throw new RequestError(err.error ?? res.statusText, res.status, err.code, err.command);
  }
  return data as T;
}

export const api = {
  /** Whether the page's token is still good; a refusal shows the login page. */
  auth: () => call<unknown>('GET', '/api/auth'),
  env: (refresh = false) => call<EnvReport>('GET', refresh ? '/api/env?refresh=1' : '/api/env'),
  /** Runs this file for the CLI from now on (null: the one the user's shell runs); refused with the reason if it is not that program. */
  chooseCli: (vendor: Vendor, path: string | null) => call<CliStatus>('PUT', `/api/cli/${vendor}`, { path } satisfies ChooseCliRequest),
  launch: (opts: LaunchOptions) => call<SessionInfo>('POST', '/api/sessions', opts),
  /** Ends the CLI; the session stays listed, ended. */
  end: (id: string) => call<unknown>('POST', `/api/sessions/${encodeURIComponent(id)}/end`),
  /** Starts an ended session again where its conversation stopped: the same session, running, in the app's theme now. */
  resume: (id: string, theme: ThemeMode) => call<SessionInfo>('POST', `/api/sessions/${encodeURIComponent(id)}/resume`, { theme }),
  remove: (id: string) => call<unknown>('DELETE', `/api/sessions/${encodeURIComponent(id)}`),
  compose: (id: string, req: ComposeRequest) => call<ComposeResult>('POST', `/api/sessions/${encodeURIComponent(id)}/compose`, req),
  /** Places a session under another one (grouping), or back at the top with null. */
  link: (id: string, parentId: string | null, kind: LinkKind = 'group') =>
    call<{ links: SessionLink[] }>('PUT', `/api/sessions/${encodeURIComponent(id)}/link`, parentId === null ? { parentId } : { parentId, kind }),
  /** Hands text from a session to the session delegated under it. */
  delegate: (parentId: string, childId: string, text: string) =>
    call<DelegationInfo>('POST', `/api/sessions/${encodeURIComponent(parentId)}/delegations`, { childId, text }),
  /** Hands a delegate's answer back to its parent, now or once the parent is idle. */
  deliver: (id: string, header: string) => call<DelegationInfo>('POST', `/api/delegations/${encodeURIComponent(id)}/deliver`, { header }),
  /** Watches the sessions started outside AgentHouse from now on, or stops: the same for every page. */
  watchExternal: (on: boolean) => call<{ on: boolean }>('PUT', '/api/external', { on } satisfies ExternalRequest),
  /** Plan usage as it went since a time (epoch ms), the oldest reading first: what the usage log has of it. */
  usage: (since: number) => call<UsageHistory>('GET', `/api/usage?since=${since}`),
  /** What a session was last asked and what it last said, as a few plain words. */
  latest: (id: string) => call<LatestWords>('GET', `/api/sessions/${encodeURIComponent(id)}/latest`),
  /** The skills a session's conversation was given, with the ones it ran marked. */
  skills: (id: string) => call<{ skills: SkillInfo[] }>('GET', `/api/sessions/${encodeURIComponent(id)}/skills`),
  /** One of the project's or the user's own skills, as text to edit; saved over the version it was loaded as. */
  skillFile: (id: string, name: string) => call<TextFile>('GET', `/api/sessions/${encodeURIComponent(id)}/skills/${encodeURIComponent(name)}`),
  saveSkill: (id: string, name: string, text: string, version: string) =>
    call<TextFile>('PUT', `/api/sessions/${encodeURIComponent(id)}/skills/${encodeURIComponent(name)}`, { text, version }),
  /** What Claude reads into the session by itself: the user's instructions and the project's memory notes. */
  memory: (id: string) => call<{ files: MemoryFile[] }>('GET', `/api/sessions/${encodeURIComponent(id)}/memory`),
  memoryFile: (id: string, fileId: string) => call<TextFile>('GET', `/api/sessions/${encodeURIComponent(id)}/memory/${encodeURIComponent(fileId)}`),
  saveMemory: (id: string, fileId: string, text: string, version: string) =>
    call<TextFile>('PUT', `/api/sessions/${encodeURIComponent(id)}/memory/${encodeURIComponent(fileId)}`, { text, version }),
  /** An entry of a session's conversation, or of one of its sub-agents'. */
  entry: (id: string, entryId: string, agentId: string | null = null) =>
    call<EntryDetail>('GET', `/api/sessions/${encodeURIComponent(id)}/conversation/${encodeURIComponent(entryId)}${agentId ? `?agent=${encodeURIComponent(agentId)}` : ''}`),
};

/** A WebSocket to the server, with the page's token as a subprotocol (no headers on WebSockets, and no secret in the address). */
export function openSocket(path: string): WebSocket {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const token = authToken();
  return new WebSocket(`${scheme}://${location.host}${path}`, token ? [SOCKET_PROTOCOL, `${TOKEN_PROTOCOL_PREFIX}${token}`] : [SOCKET_PROTOCOL]);
}
