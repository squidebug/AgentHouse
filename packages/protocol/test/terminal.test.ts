import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ColorQueryResponder, isAutoResponse } from '../src/terminal';

test('terminal replies are recognised', () => {
  for (const reply of ['\x1b[12;40R', '\x1b[?1;2c', '\x1b[>0;276;0c', '\x1b]11;rgb:1a1a/1c1c/1e1e\x1b\\', '\x1bP>|xterm.js(6.0.0)\x1b\\']) {
    assert.equal(isAutoResponse(reply), true, JSON.stringify(reply));
  }
});

test('keys and text are not mistaken for replies', () => {
  for (const input of ['a', '안녕', '\r', '\x03', '\x1b[A', '\x1b[1;5C', '\x1b[200~pasted\x1b[201~', '\x1b[I']) {
    assert.equal(isAutoResponse(input), false, JSON.stringify(input));
  }
});

test('background color queries are answered with the given colors', () => {
  const responder = new ColorQueryResponder({ foreground: '#e3e3ea', background: '#12151a' });
  assert.deepEqual(responder.scan('before\x1b]11;?\x1b\\after'), ['\x1b]11;rgb:1212/1515/1a1a\x1b\\']);
  assert.deepEqual(responder.scan('\x1b]10;?\x07'), ['\x1b]10;rgb:e3e3/e3e3/eaea\x07']);
});

test('a query split across two chunks is still answered once', () => {
  const responder = new ColorQueryResponder({ foreground: '#000000', background: '#ffffff' });
  assert.deepEqual(responder.scan('text \x1b]11'), []);
  assert.deepEqual(responder.scan(';?\x07 more'), ['\x1b]11;rgb:ffff/ffff/ffff\x07']);
  assert.deepEqual(responder.scan('nothing here'), []);
});
