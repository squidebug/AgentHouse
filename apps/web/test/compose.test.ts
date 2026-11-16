import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ComposeResult, DelegationInfo } from '@agenthouse/protocol';
import { composerOpen, summarizeSend } from '../src/workspace/compose';

test('the composer folds while the user types into a terminal, and opens when it is needed', () => {
  const base = { focused: false, draft: '', recipients: 0, dropping: false, terminal: true, canSend: true };
  assert.equal(composerOpen(base), false, 'a terminal: folded');
  assert.equal(composerOpen({ ...base, terminal: false }), true, 'the conversation or the flow: open');
  assert.equal(composerOpen({ ...base, terminal: false, canSend: false }), false, 'an ended session: nothing to send to');
  for (const opens of [{ focused: true }, { draft: '안녕' }, { recipients: 2 }, { dropping: true }]) {
    assert.equal(composerOpen({ ...base, ...opens }), true, JSON.stringify(opens));
  }
});

const ok = (sessionId: string): PromiseSettledResult<ComposeResult> => ({ status: 'fulfilled', value: { sessionId, sent: true, submitted: true } });
const held = (sessionId: string): PromiseSettledResult<ComposeResult> => ({
  status: 'fulfilled',
  value: { sessionId, sent: false, submitted: false, reason: 'awaiting_permission' },
});

test('a partial send names who got it, so a resend can leave them out', () => {
  const starting: PromiseSettledResult<ComposeResult> = { status: 'fulfilled', value: { sessionId: 'd', sent: false, submitted: false, reason: 'starting' } };
  const outcome = summarizeSend(['a', 'b', 'c', 'd'], [ok('a'), held('b'), { status: 'rejected', reason: new Error('down') }, starting]);
  assert.deepEqual(outcome, { sent: 1, handed: 0, pasted: 0, held: 2, failed: 1, delivered: ['a'] }, 'a session still starting is held, like one with a dialog');
});

const work = (childId: string): PromiseSettledResult<DelegationInfo> => ({
  status: 'fulfilled',
  value: { id: `task-${childId}`, parentId: 'lead', childId, sentAt: 1, status: 'running', endedAt: null, summary: null, delivery: 'none', deliveredAt: null },
});
// What the page makes of a refusal: the server's sentence, with its code.
const refused = (code: string): PromiseSettledResult<never> => ({ status: 'rejected', reason: Object.assign(new Error('refused'), { status: code === 'BUSY' ? 409 : 400, code }) });

test('work handed to a delegate is with it: counted apart from a message, and never sent again', () => {
  const outcome = summarizeSend(['helper', 'other'], [work('helper'), ok('other')]);
  assert.deepEqual(outcome, { sent: 1, handed: 1, pasted: 0, held: 0, failed: 0, delivered: ['helper', 'other'] });
});

test('work a delegate cannot take now (a turn under way, a dialog) is held: the text stays for it', () => {
  const outcome = summarizeSend(['busy', 'ended', 'gone'], [refused('BUSY'), refused('INVALID_REQUEST'), { status: 'rejected', reason: new Error('down') }]);
  assert.deepEqual(outcome, { sent: 0, handed: 0, pasted: 0, held: 1, failed: 2, delivered: [] }, 'any other refusal is a failure');
});

test('text pasted but not submitted (a dialog opened) is in that session already: never sent again', () => {
  const late: PromiseSettledResult<ComposeResult> = {
    status: 'fulfilled',
    value: { sessionId: 'a', sent: true, submitted: false, reason: 'awaiting_input' },
  };
  assert.deepEqual(summarizeSend(['a'], [late]), { sent: 0, handed: 0, pasted: 1, held: 0, failed: 0, delivered: ['a'] });
});
