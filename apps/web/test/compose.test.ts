import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ComposeResult } from '@agenthouse/protocol';
import { summarizeSend } from '../src/workspace/compose';

const ok = (sessionId: string): PromiseSettledResult<ComposeResult> => ({ status: 'fulfilled', value: { sessionId, sent: true, submitted: true } });
const held = (sessionId: string): PromiseSettledResult<ComposeResult> => ({
  status: 'fulfilled',
  value: { sessionId, sent: false, submitted: false, reason: 'awaiting_permission' },
});

test('a partial send names who got it, so a resend can leave them out', () => {
  const outcome = summarizeSend(['a', 'b', 'c'], [ok('a'), held('b'), { status: 'rejected', reason: new Error('down') }]);
  assert.deepEqual(outcome, { sent: 1, held: 1, failed: 1, delivered: ['a'] });
});

test('text pasted but not submitted because a dialog opened counts as held, not sent', () => {
  const late: PromiseSettledResult<ComposeResult> = {
    status: 'fulfilled',
    value: { sessionId: 'a', sent: true, submitted: false, reason: 'awaiting_input' },
  };
  assert.deepEqual(summarizeSend(['a'], [late]), { sent: 0, held: 1, failed: 0, delivered: [] });
});
