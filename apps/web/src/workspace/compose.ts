import { isAsking, type ComposeResult } from '@agenthouse/protocol';

export interface SendOutcome {
  sent: number;
  /** Not sent because the session shows a permission or question dialog. */
  held: number;
  failed: number;
  /** Sessions that got the message; a resend must leave them out. */
  delivered: string[];
}

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
