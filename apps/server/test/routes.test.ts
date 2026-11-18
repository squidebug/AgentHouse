import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { Readable } from 'node:stream';
import { describe, test } from 'node:test';
import { FileError } from '../src/claude/notes';
import { HostRequestError } from '../src/shared/host-protocol';
import { LaunchError } from '../src/web/cli/launch';
import { DelegationError } from '../src/web/delegations';
import { CliChoiceError } from '../src/web/doctor';
import { HostUnavailableError } from '../src/web/host-client';
import { answer, apiRoutes, HttpError, refusal, type ApiServices } from '../src/web/http/routes';
import { LinkError } from '../src/web/links';

// What the routes ask, standing in for the real services: each says what it was asked.
const asked: unknown[][] = [];
const note = (...call: unknown[]) => {
  asked.push(call);
  return call;
};
const sessions = new Map([['s1', { id: 's1', cwd: '/work/shop' }]]);
const services = {
  env: { report: async (refresh: boolean) => note('report', refresh), choose: async (vendor: string, path: string | null) => note('choose', vendor, path) },
  manager: {
    get: (id: string) => sessions.get(id),
    list: () => [...sessions.values()],
    create: async (options: unknown) => note('create', options),
    end: async (id: string) => note('end', id),
  },
  conversations: { detail: async (...call: unknown[]) => (note('detail', ...call), { truncated: false }) },
  delegations: {},
  setExternal: (on: boolean) => note('external', on),
} as unknown as ApiServices;
const routes = apiRoutes(services);

/** A request as a route sees it: its method, and its body as the bytes that came. */
const request = (method: string, body?: unknown) => Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]), { method }) as unknown as IncomingMessage;
const ask = (method: string, address: string, body?: unknown) => answer(routes, request(method, body), new URL(address, 'http://localhost'));
const refused = (status: number, code?: string) => (error: unknown) => error instanceof HttpError && error.status === status && error.code === code;

describe('the API as a table of routes', () => {
  test('a request is answered by the route of its method and path, with the status that route has', async () => {
    assert.deepEqual(await ask('GET', '/api/auth'), { status: 200, body: {} });
    assert.deepEqual(await ask('GET', '/api/env?refresh=1'), { status: 200, body: ['report', true] });
    assert.deepEqual(await ask('GET', '/api/sessions'), { status: 200, body: [{ id: 's1', cwd: '/work/shop' }] });
    assert.deepEqual(await ask('POST', '/api/sessions', { vendor: 'fake', title: 'new' }), { status: 201, body: ['create', { vendor: 'fake', title: 'new' }] });
    assert.deepEqual(await ask('POST', '/api/sessions/s1/end'), { status: 200, body: ['end', 's1'] });
  });

  test('anything the table has no line for is not found: another method, a longer or shorter address', async () => {
    for (const [method, address] of [['POST', '/api/auth'], ['GET', '/api/nothing'], ['GET', '/api/sessions/'], ['GET', '/api'], ['POST', '/api/sessions/s1/end/now'], ['GET', '/api//auth']] as const) {
      await assert.rejects(ask(method, address), refused(404), `${method} ${address}`);
    }
  });

  test('a part of an address that a path names is taken as it was before it was encoded; a session it names must be there', async () => {
    await ask('GET', '/api/sessions/s1/conversation/s0-a%2Fb%20c?agent=a1b2c3');
    assert.deepEqual(asked.at(-1), ['detail', 's1', 's0-a/b c', 'a1b2c3']);
    await assert.rejects(ask('GET', '/api/sessions/s1/conversation/%E0%A4%A'), refused(404), 'not encoded as an address is');
    await assert.rejects(ask('GET', '/api/sessions/s1/conversation/x?agent=../../etc'), refused(404), 'no sub-agent has such an id');
    await assert.rejects(ask('POST', '/api/sessions/nobody/end'), (error: unknown) => refused(404)(error) && (error as Error).message === '세션을 찾을 수 없습니다.');
    await assert.rejects(ask('PUT', '/api/cli/gemini', { path: null }), refused(404));
    assert.deepEqual((await ask('PUT', '/api/cli/claude', { path: null })).body, ['choose', 'claude', null]);
  });

  test('a body is held to the schema of its route, and to a size', async () => {
    await assert.rejects(ask('POST', '/api/sessions', { vendor: 'unknown' }), refused(400, 'INVALID_REQUEST'));
    await assert.rejects(ask('POST', '/api/sessions', '{not json'), refused(400));
    await assert.rejects(ask('PUT', '/api/external', { on: true, padding: 'x'.repeat(2000) }), refused(413), 'larger than this route takes');
    assert.deepEqual((await ask('PUT', '/api/external', { on: false })).body, { on: false });
    assert.deepEqual(asked.at(-1), ['external', false]);
  });

  test('every line is under /api/, where the door asks for a login first, and no two lines are for the same request', () => {
    const lines = routes.map((route) => `${route.method} ${route.parts.join('/')}`);
    assert.deepEqual(lines.filter((line) => !/^[A-Z]+ \/api\//.test(line)), []);
    // Two paths that differ only in what they call a part would take the same requests.
    const shapes = routes.map((route) => `${route.method} ${route.parts.map((part) => (part.startsWith(':') ? ':' : part)).join('/')}`);
    assert.deepEqual(shapes.filter((shape, i) => shapes.indexOf(shape) !== i), []);
  });
});

describe('what a refused request is told', () => {
  test('a refusal has its status and its code; anything else is a fault, and says nothing', () => {
    const told = (error: unknown) => {
      const reply = refusal(error);
      return reply && [reply.status, reply.body.code ?? null, reply.body.error];
    };
    assert.deepEqual(told(new HttpError(403, 'no')), [403, null, 'no']);
    assert.deepEqual(refusal(new LaunchError('missing', 'ENV_CLI_MISSING', 409, 'npm install'))?.body, { error: 'missing', code: 'ENV_CLI_MISSING', command: 'npm install' });
    assert.deepEqual(told(new CliChoiceError('not it')), [400, 'INVALID_CLI', 'not it']);
    assert.deepEqual([told(new LinkError('gone', 'NOT_FOUND'))?.[0], told(new LinkError('no', 'INVALID_REQUEST'))?.[0]], [404, 400]);
    assert.deepEqual(
      (['NOT_FOUND', 'CHANGED', 'TOO_LARGE', 'NOT_TEXT'] as const).map((code) => told(new FileError('file', code))?.[0]),
      [404, 409, 413, 415],
    );
    assert.deepEqual(
      (['NOT_FOUND', 'BUSY', 'INVALID_REQUEST'] as const).map((code) => told(new DelegationError('work', code))?.[0]),
      [404, 409, 400],
    );
    assert.deepEqual(told(new HostUnavailableError())?.slice(0, 2), [503, 'HOST_UNAVAILABLE']);
    assert.deepEqual([told(new HostRequestError('gone', 'NOT_FOUND'))?.[0], told(new HostRequestError('no', 'SPAWN_FAILED'))?.[0]], [404, 500]);
    assert.equal(refusal(new HostRequestError('something broke in the host')), null, 'no code: not a refusal');
    assert.equal(refusal(new Error("EPERM: operation not permitted, rename 'C:\\\\Users\\\\someone\\\\settings.json'")), null);
    assert.equal(refusal('text'), null);
  });
});
