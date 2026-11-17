import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { readTail, tailLines } from '../src/shared/tail';

const scratch = mkdtempSync(path.join(os.tmpdir(), 'agenthouse-tail-'));
after(() => rmSync(scratch, { recursive: true, force: true }));

const file = path.join(scratch, 'lines.jsonl');
// Four lines of ten bytes each, the newline included, and one still being written.
const LINES = ['aaaaaaaaa', 'bbbbbbbbb', 'ccccccccc', 'ddddddddd'];
writeFileSync(file, `${LINES.join('\n')}\nhalf`);
const texts = async (bytes: number, from = 0) => {
  const tail = await readTail(file, bytes, from);
  return tail ? [...tailLines(tail, from)].map((line) => line.text) : null;
};

test('the end of a file is its last bytes, or what follows where the reader left off', async () => {
  assert.deepEqual(await readTail(path.join(scratch, 'none.jsonl'), 100), null, 'no such file');
  const whole = await readTail(file, 1000);
  assert.deepEqual([whole?.start, whole?.data.length], [0, 44]);
  const last = await readTail(file, 14);
  assert.deepEqual([last?.start, last?.data.toString()], [30, 'ddddddddd\nhalf']);
  // What came before `from` was read already, however much is asked for.
  assert.equal((await readTail(file, 1000, 20))?.start, 20);
  assert.equal((await readTail(file, 14, 20))?.start, 30, 'never more than asked for');
  assert.deepEqual([(await readTail(file, 100, 44))?.data.length, (await readTail(file, 100, 500))?.data.length], [0, 0], 'nothing new, or a file that got shorter');
});

test('its lines come with their place in the file; a piece that starts mid-line is no line', async () => {
  assert.deepEqual(await texts(1000), [...LINES, 'half']);
  const tail = await readTail(file, 1000);
  assert.deepEqual([...tailLines(tail!)].map((line) => [line.start, line.end]), [[0, 9], [10, 19], [20, 29], [30, 39], [40, 44]]);
  // The last 25 bytes begin inside the second line.
  assert.deepEqual(await texts(25), ['ccccccccc', 'ddddddddd', 'half']);
  // From where a line is known to begin, the first one is whole.
  assert.deepEqual(await texts(1000, 20), ['ccccccccc', 'ddddddddd', 'half']);
  assert.deepEqual(await texts(15, 20), ['ddddddddd', 'half'], 'but not when less than that is read');
  assert.deepEqual(await texts(3), [], 'a piece without a line break');
});

test('empty lines are left out', async () => {
  const gaps = path.join(scratch, 'gaps.jsonl');
  writeFileSync(gaps, 'one\n\n\ntwo\n');
  const tail = await readTail(gaps, 1000);
  assert.deepEqual([...tailLines(tail!)].map((line) => line.text), ['one', 'two']);
});
