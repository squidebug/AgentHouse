import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { SessionInfo, SessionLink } from '@agenthouse/protocol';
import { createSessionHost } from '../src/host/server';
import { HostClient } from '../src/web/host-client';
import { createAgentHouseServer } from '../src/web/http/server';
import { LinkError, LinkStore, linksFile } from '../src/web/links';
import { fakeAgentPath, login, openSocket, request, tempStateDir, waitFor } from './helpers';

const known = (...ids: string[]) => (id: string) => ids.includes(id);
const pairs = (links: SessionLink[]) => links.map((l) => `${l.childId}<${l.parentId}`).sort();

describe('session links', () => {
  test('one level: a parent is at the top, and a session with sessions under it stays at the top', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agenthouse-links-'));
    try {
      const file = linksFile(dir);
      const store = new LinkStore(file);
      const all = known('a', 'b', 'c', 'd');
      assert.equal(store.set('b', 'a', 'group', all), true);
      assert.equal(store.set('b', 'a', 'group', all), false, 'the same link twice changes nothing');
      assert.equal(store.set('c', 'a', 'group', all), true);
      const refused = (child: string, parent: string | null, kind: 'group' | 'delegate' = 'group') =>
        assert.throws(
          () => store.set(child, parent, kind, all),
          (error: unknown) => error instanceof LinkError,
        );
      refused('d', 'b'); // b is under a
      refused('a', 'd'); // a has sessions under it
      refused('d', 'd');
      refused('d', 'gone');
      refused('d', 'a', 'delegate'); // not yet
      assert.throws(() => store.set('gone', null, 'group', all), (error: unknown) => error instanceof LinkError && error.code === 'NOT_FOUND');
      assert.deepEqual(pairs(store.list()), ['b<a', 'c<a']);

      assert.deepEqual(pairs(new LinkStore(file).list()), ['b<a', 'c<a'], 'kept in state.json');
      assert.equal(store.set('c', null, 'group', all), true, 'back at the top');
      assert.equal(store.prune(known('b', 'c', 'd')), true, 'a is gone: b goes back to the top');
      assert.deepEqual(store.list(), []);
      assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 1, links: [] });

      writeFileSync(file, JSON.stringify({ version: 1, links: [{ childId: 'x', parentId: 'y', kind: 'group' }, { childId: 'y', parentId: 'z', kind: 'group' }, { childId: 'q', parentId: 'q', kind: 'group' }, { nope: 1 }] }));
      assert.deepEqual(pairs(new LinkStore(file).list()), ['y<z'], 'a file nesting deeper than one level, or naming itself, is cut back');
      writeFileSync(file, '{not json');
      assert.deepEqual(new LinkStore(file).list(), [], 'an unreadable file starts over');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('the web server keeps them across restarts, tells every browser, and forgets removed sessions', async () => {
    const stateDir = await tempStateDir();
    const host = await createSessionHost({ stateDir, idleExitMs: null });
    const client = await HostClient.connect({ stateDir, spawn: false });
    let app = await createAgentHouseServer({ port: 0, fakeAgentPath, host: client });
    try {
      let headers = { cookie: await login(app.port, app.token), origin: `http://127.0.0.1:${app.port}` };
      const start = async (title: string) => ((await request(app.port, 'POST', '/api/sessions', { headers, body: { vendor: 'fake', title } })).json as SessionInfo).id;
      const [a, b, c] = [await start('a'), await start('b'), await start('c')];
      const events = await openSocket(app.port, '/ws/events', headers);
      assert.ok(await waitFor(() => events.messages.some((m) => m.type === 'links'), 3000), 'the links come with the first messages');

      const link = (child: string, parentId: string | null) => request(app.port, 'PUT', `/api/sessions/${child}/link`, { headers, body: { parentId } });
      const linked = await link(b, a);
      assert.equal(linked.status, 200);
      assert.deepEqual((linked.json as { links: SessionLink[] }).links, [{ childId: b, parentId: a, kind: 'group' }]);
      assert.ok(await waitFor(() => events.messages.some((m) => m.type === 'links' && (m.links as SessionLink[]).length === 1), 3000), 'every browser hears of it');
      assert.equal((await link(c, b)).status, 400, 'not under a session that is under another');
      assert.equal((await link('missing', a)).status, 404);
      assert.equal((await request(app.port, 'PUT', `/api/sessions/${c}/link`, { headers, body: { parentId: a, kind: 'delegate' } })).status, 400);
      assert.equal((await request(app.port, 'PUT', `/api/sessions/${c}/link`, { headers: { ...headers, origin: 'http://evil.example' }, body: { parentId: a } })).status, 403);

      // A new web server reads them back.
      events.ws?.close();
      await app.close();
      app = await createAgentHouseServer({ port: 0, fakeAgentPath, host: client });
      headers = { cookie: await login(app.port, app.token), origin: `http://127.0.0.1:${app.port}` };
      const again = await openSocket(app.port, '/ws/events', headers);
      assert.ok(await waitFor(() => again.messages.some((m) => m.type === 'links' && (m.links as SessionLink[]).length === 1), 3000), 'still there after a restart');

      // Removing the parent sends the session under it back to the top.
      assert.equal((await request(app.port, 'DELETE', `/api/sessions/${a}`, { headers })).status, 200);
      assert.ok(await waitFor(() => again.messages.some((m) => m.type === 'links' && (m.links as SessionLink[]).length === 0), 3000));
      again.ws?.close();
      for (const id of [b, c]) await request(app.port, 'DELETE', `/api/sessions/${id}`, { headers });
    } finally {
      await app.close();
      client.close();
      await host.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  });
});
