// The API of the web server as a table: a line per route, with its method, its
// path and what answers it. A route returns the body of its answer and throws
// what it refuses. Who may ask at all (Host, login, Origin) is decided before a
// request gets here, in server.ts.
import type { IncomingMessage } from 'node:http';
import type { ApiError, ComposeResult, SessionInfo, TextFile } from '@agenthouse/protocol';
import { memoryFiles } from '../../claude/memory';
import { FileError, MAX_FILE_BYTES, readText, writeText } from '../../claude/notes';
import { claudeConfigDir } from '../../claude/settings';
import { skillFile, skillsOf } from '../../claude/skills';
import { HostRequestError } from '../../shared/host-protocol';
import { LaunchError } from '../cli/launch';
import type { Conversations } from '../conversations';
import { DelegationError, type Delegations } from '../delegations';
import { CliChoiceError, type EnvService } from '../doctor';
import { HostUnavailableError } from '../host-client';
import { LinkError } from '../links';
import type { SessionManager } from '../manager';
import { agentParam, ChooseCliBody, ComposeBody, DelegateBody, DeliverBody, ExternalBody, LaunchBody, LinkBody, NoteBody, ResumeBody } from './schemas';

/** A request refused for what it asks, with the status that says so. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly command?: string,
  ) {
    super(message);
  }
}

// A body is this large at most, unless its route says otherwise.
const BODY_BYTES = 256 * 1024;
// A message or delegated work is 200,000 characters at most (schemas.ts): up to four bytes each in
// UTF-8, more where JSON escapes them. The default limit refused Korean text from about 85,000 on.
const TEXT_BODY_BYTES = 1024 * 1024;
// A note is MAX_FILE_BYTES at most on disk; as JSON every byte of it can take six.
const NOTE_BODY_BYTES = MAX_FILE_BYTES * 6 + 1024;

/** What holds a body to its shape: one of the schemas of schemas.ts. */
interface Schema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

/**
 * A request's body as JSON, as its schema lets it through; no body is an empty object. Refused when
 * larger than `limit` bytes, once all of it has come: what is over the limit is read and dropped, since
 * a body left unread keeps its connection from taking the next request.
 */
export async function readBody<T>(req: IncomingMessage, schema: Schema<T>, limit = BODY_BYTES): Promise<T> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size <= limit) chunks.push(chunk as Buffer);
  }
  if (size > limit) throw new HttpError(413, '요청이 너무 큽니다.');
  let value: unknown = {};
  if (chunks.length) {
    try {
      value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw new HttpError(400, 'JSON 형식이 올바르지 않습니다.');
    }
  }
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, '요청 값이 올바르지 않습니다.', 'INVALID_REQUEST');
  return result.data;
}

/** The names a path gives to parts of an address: `/api/cli/:vendor` names `vendor`. */
type Named<Path extends string> = Path extends `${string}:${infer Name}/${infer Rest}` ? Name | Named<Rest> : Path extends `${string}:${infer Name}` ? Name : never;

/** What a route gets of the request it answers. */
interface Call<Names extends string = string> {
  url: URL;
  /** The parts of the address its path names, as they were before they were encoded for an address. */
  params: Record<Names, string>;
  /** The body, held to a schema; `limit` in bytes for one that may be larger than most. */
  body<T>(schema: Schema<T>, limit?: number): Promise<T>;
}

export interface Route {
  method: string;
  /** Its path in parts; `:name` takes any one part of an address and gives it that name. */
  parts: string[];
  /** The status its answer goes out with. */
  status: number;
  run(call: Call): unknown;
}

/** A line of the table. A route sees the parts of the address its own path names, and no others. */
function route<Path extends string>(method: string, path: Path, run: (call: Call<Named<Path>>) => unknown, status = 200): Route {
  // `named` gives a route every part its path names, which is what the names in its type say.
  return { method, parts: path.split('/'), status, run: run as Route['run'] };
}

/** The parts of an address a route's path names, decoded; null when the address is not of that path. */
function named(route: Route, parts: string[]): Record<string, string> | null {
  if (route.parts.length !== parts.length) return null;
  const params: Record<string, string> = {};
  for (const [i, want] of route.parts.entries()) {
    const part = parts[i]!;
    if (!want.startsWith(':')) {
      if (want !== part) return null;
      continue;
    }
    let value = '';
    try {
      value = decodeURIComponent(part);
    } catch {
      // not encoded as an address is: it names nothing
    }
    if (!value) return null;
    params[want.slice(1)] = value;
  }
  return params;
}

/** The answer of the route that takes this request: its status and its body. 404 when the table has none for it. */
export async function answer(routes: Route[], req: IncomingMessage, url: URL): Promise<{ status: number; body: unknown }> {
  const parts = url.pathname.split('/');
  for (const candidate of routes) {
    const params = candidate.method === req.method ? named(candidate, parts) : null;
    if (!params) continue;
    const body = await candidate.run({ url, params, body: (schema, limit) => readBody(req, schema, limit) });
    return { status: candidate.status, body };
  }
  throw new HttpError(404, '찾을 수 없습니다.');
}

/**
 * What a request is told when it was refused: by a route, or by what the route
 * asked (the launcher, the links, a note's file, a delegation, the host). Null
 * for anything else, which is a fault of the server's and not the caller's to read.
 */
export function refusal(error: unknown): { status: number; body: ApiError } | null {
  const told = (status: number, code?: string, command?: string) => ({ status, body: { error: (error as Error).message, ...(code ? { code } : {}), ...(command ? { command } : {}) } });
  if (error instanceof HttpError || error instanceof LaunchError) return told(error.status, error.code, error.command);
  if (error instanceof CliChoiceError) return told(400, 'INVALID_CLI');
  if (error instanceof LinkError) return told(error.code === 'NOT_FOUND' ? 404 : 400, error.code);
  if (error instanceof FileError) return told({ NOT_FOUND: 404, CHANGED: 409, TOO_LARGE: 413, NOT_TEXT: 415 }[error.code], error.code);
  if (error instanceof DelegationError) return told(error.code === 'NOT_FOUND' ? 404 : error.code === 'BUSY' ? 409 : 400, error.code);
  if (error instanceof HostUnavailableError) return told(503, 'HOST_UNAVAILABLE');
  // What the host refused, in its own words. One of its errors without a code is a fault of the host's.
  if (error instanceof HostRequestError && error.code) return told(error.code === 'NOT_FOUND' ? 404 : 500, error.code);
  return null;
}

export interface ApiServices {
  env: EnvService;
  manager: SessionManager;
  conversations: Conversations;
  delegations: Delegations;
  /** Watches the sessions started outside AgentHouse from now on, or stops: kept, and told to every page. */
  setExternal(on: boolean): void;
}

/** The table. Every route is for a caller that is logged in; one that changes anything, for the page's own origin. */
export function apiRoutes({ env, manager, conversations, delegations, setExternal }: ApiServices): Route[] {
  /** The session an address names; refused when there is none. */
  const sessionOf = (params: { session: string }): SessionInfo => {
    const session = manager.get(params.session);
    if (!session) throw new HttpError(404, '세션을 찾을 수 없습니다.');
    return session;
  };
  // One of the project's or the user's own skills, and one of the files Claude reads into a session by
  // itself: looked up in the list as it is now. A request names a file of that list, never a path.
  const skillPath = async (params: { session: string; name: string }): Promise<string> => {
    const file = await skillFile(sessionOf(params).cwd, claudeConfigDir(), params.name);
    if (!file) throw new HttpError(404, '편집할 수 있는 스킬이 아닙니다.');
    return file.path;
  };
  const memoryPath = async (params: { session: string; id: string }): Promise<string> => {
    const file = (await memoryFiles(sessionOf(params), claudeConfigDir())).find((entry) => entry.id === params.id);
    if (!file) throw new HttpError(404, '찾을 수 없습니다.');
    return file.path;
  };
  /** A note saved over the version the page loaded. */
  const save = async (file: string, body: Call['body']): Promise<TextFile> => {
    const { text, version } = await body(NoteBody, NOTE_BODY_BYTES);
    return writeText(file, text, version);
  };

  return [
    // The page's token is good: a page that lost its sockets tells a server restart from a lost login.
    route('GET', '/api/auth', () => ({})),
    route('GET', '/api/env', ({ url }) => env.report(url.searchParams.has('refresh'))),
    // Which executable runs a CLI: one picked or typed in the environment check, or null for the shell's.
    route('PUT', '/api/cli/:vendor', async ({ params: { vendor }, body }) => {
      if (vendor !== 'claude' && vendor !== 'codex') throw new HttpError(404, '찾을 수 없습니다.');
      return env.choose(vendor, (await body(ChooseCliBody, 8192)).path);
    }),
    // Watching the sessions started outside AgentHouse, on or off: the same for every page.
    route('PUT', '/api/external', async ({ body }) => {
      const { on } = await body(ExternalBody, 1024);
      setExternal(on);
      return { on };
    }),

    route('GET', '/api/sessions', () => manager.list()),
    route('POST', '/api/sessions', async ({ body }) => manager.create(await body(LaunchBody)), 201),
    // Ends the session (if still running) and takes it off the list.
    route('DELETE', '/api/sessions/:session', ({ params }) => manager.remove(sessionOf(params).id)),
    // Ends the CLI; the session stays listed, ended.
    route('POST', '/api/sessions/:session/end', ({ params }) => manager.end(sessionOf(params).id)),
    // Starts an ended session again where its conversation stopped.
    route('POST', '/api/sessions/:session/resume', async ({ params, body }) => manager.resume(sessionOf(params).id, (await body(ResumeBody)).theme), 201),
    route('POST', '/api/sessions/:session/compose', async ({ params, body }): Promise<ComposeResult> => {
      const { id } = sessionOf(params);
      return { sessionId: id, ...(await manager.compose(id, await body(ComposeBody, TEXT_BODY_BYTES))) };
    }),
    // Places the session under another one (grouping), or back at the top.
    route('PUT', '/api/sessions/:session/link', async ({ params, body }) => {
      const { id } = sessionOf(params);
      const { parentId, kind } = await body(LinkBody);
      return { links: manager.link(id, parentId, kind ?? 'group') };
    }),

    // Sends work from this session to the session delegated under it.
    route('POST', '/api/sessions/:session/delegations', async ({ params, body }) => {
      const { id } = sessionOf(params);
      const { childId, text } = await body(DelegateBody, TEXT_BODY_BYTES);
      return delegations.delegate(id, childId, text);
    }, 201),
    // Hands a delegate's answer back to the session that delegated the work.
    route('POST', '/api/delegations/:id/deliver', async ({ params, body }) => delegations.deliver(params.id, (await body(DeliverBody)).header)),

    // The full content of one entry of a conversation being viewed: the session's, or with agent=<id> one of its sub-agents'.
    route('GET', '/api/sessions/:session/conversation/:entry', async ({ params, url }) => {
      const { id } = sessionOf(params);
      const agent = agentParam(url);
      const detail = agent === undefined ? null : await conversations.detail(id, params.entry, agent);
      if (!detail) throw new HttpError(404, '찾을 수 없습니다.');
      return detail;
    }),
    // What it was last asked and what it last said, for a glance: read from the end of its transcript when asked for.
    route('GET', '/api/sessions/:session/latest', ({ params }) => conversations.latest(sessionOf(params).id)),

    // The skills its conversation was given, read from its transcript when asked for; one of them, to read and to save.
    route('GET', '/api/sessions/:session/skills', async ({ params }) => ({ skills: await skillsOf(sessionOf(params), claudeConfigDir()) })),
    route('GET', '/api/sessions/:session/skills/:name', async ({ params }) => readText(await skillPath(params))),
    route('PUT', '/api/sessions/:session/skills/:name', async ({ params, body }) => save(await skillPath(params), body)),
    // What Claude reads into the session by itself: the user's instructions and the project's memory notes.
    route('GET', '/api/sessions/:session/memory', async ({ params }) => ({ files: await memoryFiles(sessionOf(params), claudeConfigDir()) })),
    route('GET', '/api/sessions/:session/memory/:id', async ({ params }) => readText(await memoryPath(params))),
    route('PUT', '/api/sessions/:session/memory/:id', async ({ params, body }) => save(await memoryPath(params), body)),
  ];
}
