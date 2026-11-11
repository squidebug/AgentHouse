import { isAsking, type ComposeResult } from '@agenthouse/protocol';

export interface SendOutcome {
  sent: number;
  /** Not sent because the session shows a permission or question dialog. */
  held: number;
  failed: number;
  /** Sessions that got the message; a resend must leave them out. */
  delivered: string[];
}

/** Tallies one composer send, recipient by recipient (results in the same order as ids). */
export function summarizeSend(ids: string[], results: PromiseSettledResult<ComposeResult>[]): SendOutcome {
  const outcome: SendOutcome = { sent: 0, held: 0, failed: 0, delivered: [] };
  results.forEach((result, i) => {
    const id = ids[i];
    if (result.status === 'fulfilled' && result.value.submitted) {
      outcome.sent += 1;
      if (id) outcome.delivered.push(id);
    } else if (result.status === 'fulfilled' && isAsking(result.value.reason)) {
      outcome.held += 1;
    } else {
      outcome.failed += 1;
    }
  });
  return outcome;
}
