import { isHeld, type ComposeResult, type DelegationInfo } from '@agenthouse/protocol';

export interface SendOutcome {
  sent: number;
  /** Handed over as work to a session delegated under another, which follows it until its answer. */
  handed: number;
  /** In the session's input, but Enter was held back: a dialog opened meanwhile. */
  pasted: number;
  /** Not sent: a dialog is open, the session has not started, or it is in a turn and the text was work for it. */
  held: number;
  failed: number;
  /** Sessions that have the text now (sent or in their input); a resend must leave them out. */
  delivered: string[];
}

/** What sending to one recipient gave: a message's result, or the work a delegate was handed. */
export type SendResult = ComposeResult | DelegationInfo;

/** Work is refused with this code while its session cannot take it (web/delegations.ts): it can go again later. */
const refusedForNow = (error: unknown) => (error as { code?: unknown } | null)?.code === 'BUSY';

export interface ComposerSituation {
  /** The composer, or something in it, has the keyboard. */
  focused: boolean;
  draft: string;
  /** Sessions dropped on it. */
  recipients: number;
  /** A session that can be dropped on it is being dragged. */
  dropping: boolean;
  /** The active pane shows a terminal (or there is none): the user types there. */
  terminal: boolean;
  /** The active pane's session takes messages. */
  canSend: boolean;
}

/**
 * The composer folds to one line while the user types into a terminal. It
 * opens for the conversation and the flow (when their session takes
 * messages), for sessions dropped or being dragged onto it, for a draft, and
 * while it has the keyboard.
 */
export function composerOpen(s: ComposerSituation): boolean {
  return s.focused || s.draft !== '' || s.recipients > 0 || s.dropping || (!s.terminal && s.canSend);
}

/** Tallies one composer send, recipient by recipient (results in the same order as ids). */
export function summarizeSend(ids: string[], results: PromiseSettledResult<SendResult>[]): SendOutcome {
  const outcome: SendOutcome = { sent: 0, handed: 0, pasted: 0, held: 0, failed: 0, delivered: [] };
  results.forEach((result, i) => {
    const id = ids[i];
    if (result.status === 'rejected') {
      if (refusedForNow(result.reason)) outcome.held += 1;
      else outcome.failed += 1;
      return;
    }
    const value = result.value;
    if ('childId' in value) {
      // The server follows the work from here, a held-back Enter included: it has the text.
      outcome.handed += 1;
      if (id) outcome.delivered.push(id);
    } else if (value.sent) {
      // Submitted, or waiting in its input for Enter: either way it has the text, and sending again would double it.
      if (value.submitted) outcome.sent += 1;
      else outcome.pasted += 1;
      if (id) outcome.delivered.push(id);
    } else if (isHeld(value.reason)) {
      outcome.held += 1;
    } else {
      outcome.failed += 1;
    }
  });
  return outcome;
}
