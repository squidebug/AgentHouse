import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { MemoryFile, SessionInfo, SkillInfo, TextFile } from '@agenthouse/protocol';
import { memoryFiles } from '../src/claude/memory';
import { FileError, MAX_FILE_BYTES, noteHeader, noteInside, readText, writeText } from '../src/claude/notes';
import { skillFile } from '../src/claude/skills';
import { eventually, login, request, startServer, type TestServer } from './helpers';

// The fake agent writes its transcript only under a CLAUDE_CONFIG_DIR, never into ~/.claude.
const config = mkdtempSync(path.join(os.tmpdir(), 'agenthouse-claude-config-'));
process.env.CLAUDE_CONFIG_DIR = config;
const work = mkdtempSync(path.join(os.tmpdir(), 'agenthouse-notes-work-'));
const put = (file: string, text: string | Buffer) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
  return file;
};
const code = async (run: () => Promise<unknown>) => run().then(
  () => 'saved',
  (error: unknown) => (error instanceof FileError ? error.code : String(error)),
);

after(() => {
  rmSync(config, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe('a note of the user is saved whole, and only over what the page loaded', () => {
  test('the text goes over the file unless the file changed meanwhile', async () => {
    const file = put(path.join(work, 'plain.md'), 'one\ntwo\n');
    const loaded = await readText(file);
    assert.deepEqual([loaded.text, loaded.path], ['one\ntwo\n', file]);
    const saved = await writeText(file, 'one\ntwo\nthree\n', loaded.version);
    assert.equal(readFileSync(file, 'utf8'), 'one\ntwo\nthree\n');
    assert.notEqual(saved.version, loaded.version);
    // Claude, or the user's own editor, wrote it since: the page's copy is not put over that.
    assert.equal(await code(() => writeText(file, 'mine', loaded.version)), 'CHANGED');
    assert.equal(readFileSync(file, 'utf8'), 'one\ntwo\nthree\n');
    assert.equal((await readText(file)).version, saved.version, 'the version stands for the content');
    assert.equal(await code(() => writeText(path.join(work, 'gone.md'), 'x', saved.version)), 'NOT_FOUND');
    assert.equal(await code(() => readText(path.join(work, 'gone.md'))), 'NOT_FOUND');
  });

  test('it is written beside itself under a name nobody can know beforehand', async () => {
    const file = put(path.join(work, 'guessed.md'), 'before\n');
    // The name the temporary file used to have. A project's folder is its repository's to fill, and a
    // link waiting under a name that can be worked out would be written through.
    const guessed = put(`${file}.${process.pid}.agenthouse.tmp`, 'not a temporary file');
    await writeText(file, 'after\n', (await readText(file)).version);
    assert.equal(readFileSync(file, 'utf8'), 'after\n');
    assert.equal(readFileSync(guessed, 'utf8'), 'not a temporary file');
    const beside = readdirSync(work).filter((name) => name.startsWith('guessed.md'));
    assert.deepEqual(beside.sort(), ['guessed.md', path.basename(guessed)], 'and nothing of its own is left');
  });

  test('its line ends and its byte order mark stay as they were', async () => {
    const file = put(path.join(work, 'windows.md'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('하나\r\n둘\r\n')]));
    const loaded = await readText(file);
    assert.equal(loaded.text, '하나\n둘\n', 'the page gets it as it keeps text itself');
    await writeText(file, '하나\n둘\n셋\n', loaded.version);
    assert.deepEqual([...readFileSync(file).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.equal(readFileSync(file, 'utf8').slice(1), '하나\r\n둘\r\n셋\r\n');
  });

  test('what is no note is refused: too large, not text, out of its folder, of another kind', async () => {
    const big = put(path.join(work, 'big.md'), 'x'.repeat(MAX_FILE_BYTES + 1));
    assert.equal(await code(() => readText(big)), 'TOO_LARGE');
    const small = put(path.join(work, 'small.md'), 'x');
    assert.equal(await code(async () => writeText(small, 'x'.repeat(MAX_FILE_BYTES + 1), (await readText(small)).version)), 'TOO_LARGE');
    assert.equal(await code(() => readText(put(path.join(work, 'binary.md'), Buffer.from([1, 0, 2])))), 'NOT_TEXT');

    const inside = path.join(work, 'folder');
    put(path.join(inside, 'note.md'), 'x');
    put(path.join(inside, 'secrets.json'), '{}');
    put(path.join(work, 'outside.md'), 'x');
    assert.ok(await noteInside(inside, path.join(inside, 'note.md')));
    assert.equal(await noteInside(inside, path.join(inside, '..', 'outside.md')), null, 'not of the folder');
    assert.equal(await noteInside(inside, path.join(inside, 'secrets.json')), null, 'not a note');
    assert.equal(await noteInside(inside, path.join(inside, 'missing.md')), null);
    assert.equal(await noteInside(inside, big), null);
    let linked = true;
    try {
      // A note that is a link to a file elsewhere (needs a right Windows gives few users).
      symlinkSync(path.join(inside, 'secrets.json'), path.join(inside, 'link.md'));
    } catch {
      linked = false;
    }
    if (linked) assert.equal(await noteInside(inside, path.join(inside, 'link.md')), null, 'a link is what it leads to');
  });
});

describe("where a session's skills and memory are", () => {
  const cwd = path.join(work, 'project');
  const projects = path.join(config, 'projects', 'a-project');
  const session = { cwd, transcripts: [{ vendorSessionId: 'x', path: path.join(projects, 'x.jsonl'), since: 0 }] };

  before(() => {
    put(path.join(cwd, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\n---\nproject');
    put(path.join(config, 'skills', 'deploy', 'SKILL.md'), 'user');
    put(path.join(config, 'skills', 'review', 'SKILL.md'), 'user review');
    put(path.join(cwd, '.claude', 'commands', 'ship.md'), 'a command');
    put(path.join(config, 'CLAUDE.md'), 'for every project');
    put(path.join(config, '.credentials.json'), '{"never":"read"}');
    put(path.join(cwd, 'CLAUDE.md'), '@AGENTS.md\n@../outside.md and @missing.md\n');
    put(path.join(cwd, 'AGENTS.md'), '# rules\nsee @docs/more.md');
    put(path.join(cwd, 'docs', 'more.md'), 'more');
    put(path.join(cwd, '.claude', 'rules', 'style.md'), 'style');
    put(path.join(cwd, 'CLAUDE.local.md'), 'mine');
    put(path.join(projects, 'memory', 'MEMORY.md'), '- [Role](user-role.md) — who');
    put(path.join(projects, 'memory', 'user-role.md'), '---\nname: user-role\ndescription: "who the user is"\nmetadata:\n  type: user\n---\n\nA developer.');
    put(path.join(projects, 'memory', 'notes.txt'), 'not a note');
  });

  test("a skill's file: the project's before the user's, a command's file, and none for any other", async () => {
    assert.deepEqual(await skillFile(cwd, config, 'deploy').then((f) => [f?.source, readFileSync(f!.path, 'utf8').includes('project')]), ['project', true]);
    assert.equal((await skillFile(cwd, config, 'review'))?.source, 'user');
    assert.equal(path.basename((await skillFile(cwd, config, 'ship'))!.path), 'ship.md');
    for (const name of ['unknown', 'anthropic-skills:docx', '../deploy', 'deploy/SKILL', '']) assert.equal(await skillFile(cwd, config, name), null, name);
  });

  test("the files Claude reads by itself: the user's, the project's with what they import, this machine's, then the memory notes", async () => {
    const files = await memoryFiles(session, config);
    assert.deepEqual(
      files.map((f) => [f.id, f.kind, f.scope, f.name]),
      [
        ['user', 'instructions', 'user', 'CLAUDE.md'],
        ['project', 'instructions', 'project', 'CLAUDE.md'],
        ['import:AGENTS.md', 'instructions', 'project', 'AGENTS.md'],
        ['import:docs/more.md', 'instructions', 'project', 'docs/more.md'],
        ['rule:style.md', 'instructions', 'project', '.claude/rules/style.md'],
        ['local', 'instructions', 'local', 'CLAUDE.local.md'],
        ['memory:MEMORY.md', 'memory', 'project', 'MEMORY.md'],
        ['memory:user-role.md', 'memory', 'project', 'user-role.md'],
      ],
      'only notes that exist, and nothing from outside the project',
    );
    const role = files.at(-1);
    assert.deepEqual([role?.title, role?.about, role?.type], ['user-role', 'who the user is', 'user']);
    assert.deepEqual(noteHeader('no header'), { title: null, about: null, type: null });
    // Before any transcript, the project's folder is worked out from the session's own.
    const fresh = await memoryFiles({ cwd: path.join(work, 'nowhere'), transcripts: [] }, config);
    assert.deepEqual(fresh.map((f) => f.id), ['user']);
  });
});

describe('notes through the page', () => {
  let app: TestServer;
  let headers: Record<string, string>;
  const cwd = path.join(work, 'served');

  before(async () => {
    put(path.join(cwd, '.claude', 'skills', 'ping-pong', 'SKILL.md'), 'Reply with pong');
    put(path.join(cwd, 'CLAUDE.md'), 'Be brief.');
    // Written after the conversation's listing was made: in the folder, in no listing.
    put(path.join(cwd, '.claude', 'skills', 'deploy', 'SKILL.md'), ['---', 'name: deploy', 'description: Ships the build.', '---', 'Ship it.'].join('\n'));
    app = await startServer();
    headers = { authorization: await login(app), origin: `http://127.0.0.1:${app.port}` };
  });

  after(() => app.close());

  test("a skill and a memory note are read, saved over the version loaded, and refused over a newer one", async () => {
    const created = await request(app.port, 'POST', '/api/sessions', { headers, body: { vendor: 'fake', title: 'notes', cwd } });
    const session = created.json as SessionInfo;
    const now = async () => ((await request(app.port, 'GET', '/api/sessions', { headers })).json as SessionInfo[]).find((s) => s.id === session.id);
    await eventually(now, (s) => s?.status.value === 'idle' && s.transcripts.length === 1, 8000);
    await request(app.port, 'POST', `/api/sessions/${session.id}/compose`, { headers, body: { text: 'hello', enterDelayMs: 50, quietMs: 50 } });
    const at = (route: string) => `/api/sessions/${session.id}/${route}`;
    const skills = await eventually(
      async () => ((await request(app.port, 'GET', at('skills'), { headers })).json as { skills: SkillInfo[] }).skills,
      // Before the first prompt only what lies in the folders is listed; then the conversation's own listing leads.
      (list) => list.some((skill) => skill.name === 'loop'),
      8000,
    );
    assert.deepEqual(
      skills.map((s) => [s.name, s.source, s.editable]),
      [
        ['ping-pong', 'project', true],
        ['loop', 'builtin', false],
        ['fake-plugin:review', 'plugin', false],
        ['deploy', 'project', true],
        ['review', 'user', true],
      ],
      "what the conversation was given, then what lies in the project's and the user's folders besides",
    );
    assert.equal(skills.find((skill) => skill.name === 'deploy')?.about, 'Ships the build.', 'a skill no listing names says what it is for in its own header');

    const loaded = (await request(app.port, 'GET', at('skills/ping-pong'), { headers })).json as TextFile;
    assert.equal(loaded.text, 'Reply with pong');
    const saved = await request(app.port, 'PUT', at('skills/ping-pong'), { headers, body: { text: 'Reply with pong, twice', version: loaded.version } });
    assert.equal(saved.status, 200);
    assert.equal(readFileSync(path.join(cwd, '.claude', 'skills', 'ping-pong', 'SKILL.md'), 'utf8'), 'Reply with pong, twice');
    const stale = await request(app.port, 'PUT', at('skills/ping-pong'), { headers, body: { text: 'older', version: loaded.version } });
    assert.deepEqual([stale.status, (stale.json as { code?: string }).code], [409, 'CHANGED']);
    assert.equal((await request(app.port, 'GET', at('skills/loop'), { headers })).status, 404, "the CLI's own skill has no file to edit");
    assert.equal((await request(app.port, 'PUT', at('skills/ping-pong'), { headers: { ...headers, origin: 'http://evil.example' }, body: { text: 'x', version: loaded.version } })).status, 403, 'another page may not save');

    // The project's memory is next to its transcripts.
    const transcript = (await now())!.transcripts[0]!.path;
    put(path.join(path.dirname(transcript), 'memory', 'MEMORY.md'), '- nothing yet');
    const files = ((await request(app.port, 'GET', at('memory'), { headers })).json as { files: MemoryFile[] }).files;
    assert.deepEqual(files.map((f) => f.id), ['user', 'project', 'memory:MEMORY.md']);
    const index = (await request(app.port, 'GET', at(`memory/${encodeURIComponent('memory:MEMORY.md')}`), { headers })).json as TextFile;
    assert.equal(index.text, '- nothing yet');
    const kept = await request(app.port, 'PUT', at(`memory/${encodeURIComponent('memory:MEMORY.md')}`), { headers, body: { text: '- [Role](user-role.md)', version: index.version } });
    assert.equal(kept.status, 200);
    assert.equal(readFileSync(path.join(path.dirname(transcript), 'memory', 'MEMORY.md'), 'utf8'), '- [Role](user-role.md)');
    // A request names a file of the list: a path is no id.
    for (const id of ['memory:..%2F..%2Fsettings.json', encodeURIComponent(path.join(cwd, 'CLAUDE.md')), 'nope']) {
      assert.equal((await request(app.port, 'GET', at(`memory/${id}`), { headers })).status, 404, id);
    }
    await request(app.port, 'DELETE', `/api/sessions/${session.id}`, { headers });
  });
});
