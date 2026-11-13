import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AccessControl, CODE_TTL_MS } from '../src/web/http/access';

const bound = (secret: string, port: number) => {
  const access = new AccessControl(secret);
  access.bind(port);
  return access;
};

test('a login code is good once and for a while only', () => {
  const access = bound('host secret', 7357);
  const code = access.issueCode(1000);
  assert.equal(access.redeem(code, 1000 + CODE_TTL_MS), null, 'ran out');
  assert.equal(access.redeem(code, 1000), null, 'spent by the try that came too late');
  const fresh = access.issueCode(1000);
  assert.ok(access.redeem(fresh, 1000 + CODE_TTL_MS - 1));
  assert.equal(access.redeem(fresh, 1000), null, 'spent');
  assert.equal(access.redeem('made-up', 1000), null);
});

test('codes nobody used are dropped oldest first beyond twenty', () => {
  const access = bound('host secret', 7357);
  const codes = Array.from({ length: 21 }, () => access.issueCode(1000));
  assert.equal(access.redeem(codes[0]!, 1000), null, 'the oldest went');
  assert.ok(access.redeem(codes[1]!, 1000));
  assert.ok(access.redeem(codes[20]!, 1000));
});

test('tokens and the key hold at their own port, with their own host, across web server restarts', () => {
  const access = bound('host secret', 7357);
  const token = access.redeem(access.issueCode())!;
  assert.ok(access.valid(token));
  assert.ok(access.valid(access.key));

  const restarted = bound('host secret', 7357);
  assert.ok(restarted.valid(token), 'a new web server of the same host, at the same port');
  assert.equal(restarted.key, access.key);

  const otherPort = bound('host secret', 7359);
  assert.equal(otherPort.valid(token), false, 'another port is another origin');
  assert.equal(otherPort.valid(access.key), false);

  const newHost = bound('another secret', 7357);
  assert.equal(newHost.valid(token), false, 'a new host');
  assert.equal(newHost.valid(access.key), false);

  const [nonce, signature] = token.split('.');
  for (const forged of [`${nonce}.`, `.${signature}`, `${nonce}.${signature}.x`, nonce!, 'host secret', '']) {
    assert.equal(access.valid(forged), false, forged);
  }
});
