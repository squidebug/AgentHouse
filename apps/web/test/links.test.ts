import assert from 'node:assert/strict';
import { test } from 'node:test';
import { linkTarget } from '../src/links';

test('a link in CLI output opens only as a web address', () => {
  assert.equal(linkTarget('https://example.com/a?b=c'), 'https://example.com/a?b=c');
  assert.equal(linkTarget('http://127.0.0.1:3000'), 'http://127.0.0.1:3000/');
  for (const uri of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', ' javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///C:/Windows/win.ini', 'vbscript:x', '/relative', 'not a url', '']) {
    assert.equal(linkTarget(uri), null, uri);
  }
});
