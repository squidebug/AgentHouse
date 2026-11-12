import { Box, IconButton, InputBase, Typography } from '@mui/material';
import { useState } from 'react';
import type { SessionInfo } from '@agenthouse/protocol';
import { api } from '../api/client';
import { t } from '../strings';
import { v } from '../theme/tokens';
import type { Dnd } from '../workspace/dnd';
import { composerOpen, summarizeSend } from '../workspace/compose';
import { paneModes, shownMode, type Action, type WorkspaceState } from '../workspace/state';
import { CloseIcon, SendIcon } from './icons';
import { StatusIcon } from './StatusIcon';

// Folding and opening: short, with Material's standard easing.
const EASE = '.22s cubic-bezier(.2, 0, 0, 1)';

/**
 * A part that slides open sideways (its width and the space next to it) and
 * fades in, when it changes and when it first appears. Only the composer's own
 * row moves: the panes above never do, so the terminals keep their size.
 */
const reveal = (shown: boolean, space: 'mr' | 'ml') => ({
  display: 'inline-flex',
  flex: '0 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  maxWidth: shown ? 360 : 0,
  opacity: shown ? 1 : 0,
  [space]: shown ? '8px' : 0,
  transition: `max-width ${EASE}, margin ${EASE}, opacity ${EASE}`,
  animation: `ah-reveal ${EASE}`,
});

interface Props {
  state: WorkspaceState;
  dispatch: (action: Action) => void;
  dnd: Dnd;
  sessionById: (id: string) => SessionInfo | undefined;
  /** Receives the message when nothing was dropped on the composer. */
  activeSession: SessionInfo | undefined;
}

export function Composer({ state, dispatch, dnd, sessionById, activeSession }: Props) {
  const [draft, setDraft] = useState('');
  // Sessions that have this text already (sent, or left in their input): a resend skips them, the active one too.
  const [got, setGot] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const [sending, setSending] = useState(false);
  const [focused, setFocused] = useState(false);

  const explicit = state.targets.map(sessionById).filter((s): s is SessionInfo => Boolean(s) && !got.includes(s!.id));
  const implicit = !state.targets.length && activeSession?.state === 'running' && !got.includes(activeSession.id) ? activeSession : undefined;
  const recipients = implicit ? [implicit] : explicit;
  const target = { type: 'composer' as const };
  const acceptsDrop = dnd.dragging?.kind === 'session' && dnd.canDrop(target);
  const activePane = state.panes.find((p) => p.id === state.active);
  const terminal = !activePane || !activeSession || shownMode(state.paneMode[activePane.id], paneModes(activePane, activeSession)) === 'terminal';
  const open = composerOpen({ focused, draft, recipients: explicit.length, dropping: acceptsDrop, terminal, canSend: Boolean(implicit) });

  const send = async () => {
    const text = draft.trim();
    if (!text || !recipients.length || sending) return;
    setSending(true);
    const results = await Promise.allSettled(recipients.map((s) => api.compose(s.id, { text: draft })));
    const { sent, pasted, held, failed, delivered } = summarizeSend(
      recipients.map((s) => s.id),
      results,
    );
    setNotice([sent ? t.sentTo(sent) : '', pasted ? t.pastedFor(pasted) : '', held ? t.heldFor(held) : '', failed ? t.failedFor(failed) : ''].filter(Boolean).join(' · '));
    if (!held && !failed) {
      setDraft('');
      setGot([]);
    } else {
      // The text stays for the rest; those that have it leave the list, so a resend skips them.
      setGot((current) => [...current, ...delivered]);
      for (const id of delivered) dispatch({ type: 'removeTarget', id });
    }
    setSending(false);
  };

  return (
    <Box>
      <Box
        component="section"
        aria-label="입력"
        onDragOver={dnd.over(target)}
        onDrop={dnd.drop(target)}
        onFocus={() => setFocused(true)}
        onBlur={(event) => {
          // From the message to the send button, the keyboard is still here.
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
        }}
        className="ah-fold"
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          rowGap: 1,
          p: open ? 1 : 0,
          borderRadius: '16px',
          bgcolor: open ? v.surface : 'transparent',
          boxShadow: dnd.isOver(target) ? `0 0 0 2px ${v.primary}` : 'none',
          transition: `padding ${EASE}, background-color ${EASE}, box-shadow ${EASE}`,
        }}
      >
        {recipients.map((session) => (
          <Box key={session.id} component="span" className="ah-fold" aria-hidden={open ? undefined : true} sx={reveal(open, 'mr')}>
            <Box
              component="span"
              sx={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                minWidth: 0,
                height: 32,
                pl: '10px',
                pr: implicit ? '10px' : '2px',
                borderRadius: '8px',
                bgcolor: implicit ? 'transparent' : v.surface2,
                border: implicit ? `1px dashed ${v.outline}` : 'none',
                fontSize: 12,
                fontWeight: 500,
                whiteSpace: 'nowrap',
              }}
            >
              <StatusIcon status={session.status} size={12} />
              <Box component="span" sx={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                {session.title}
              </Box>
              {!implicit && (
                <IconButton
                  aria-label={`${session.title} 빼기`}
                  onClick={() => dispatch({ type: 'removeTarget', id: session.id })}
                  sx={{ width: 28, height: 28, borderRadius: '6px', color: v.on2 }}
                >
                  <CloseIcon size={12} />
                </IconButton>
              )}
            </Box>
          </Box>
        ))}
        <Box component="span" className="ah-fold" aria-hidden={acceptsDrop ? undefined : true} sx={reveal(acceptsDrop, 'mr')}>
          <Box
            component="span"
            sx={{ display: 'inline-flex', alignItems: 'center', height: 32, px: '10px', borderRadius: '8px', border: `1.5px dashed ${v.primary}`, color: v.primary, fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap' }}
          >
            {t.addRecipient}
          </Box>
        </Box>
        <InputBase
          multiline
          maxRows={8}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            // Edited, it is a new message: everyone gets it again.
            if (got.length) setGot([]);
          }}
          onKeyDown={(event) => {
            // Enter while an IME (Korean, Japanese, …) is composing belongs to the IME.
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
              event.preventDefault();
              send().catch(() => {});
            }
          }}
          placeholder={t.message}
          inputProps={{ 'aria-label': t.message }}
          className="ah-fold"
          sx={{
            flex: '1 1 240px',
            minWidth: 0,
            minHeight: open ? 40 : 32,
            px: '12px',
            py: open ? '6px' : '3px',
            borderRadius: '10px',
            bgcolor: v.surface2,
            fontSize: 13,
            transition: `min-height ${EASE}, padding ${EASE}`,
          }}
        />
        <Box component="span" className="ah-fold" aria-hidden={open ? undefined : true} sx={reveal(open, 'ml')}>
          <IconButton
            aria-label={t.send}
            tabIndex={open ? 0 : -1}
            disabled={!draft.trim() || !recipients.length || sending}
            onClick={() => send().catch(() => {})}
            sx={{ width: 40, height: 40, bgcolor: v.primary, color: v.onPrimary, '&:hover': { bgcolor: v.primary, opacity: 0.9 }, '&.Mui-disabled': { bgcolor: v.surface2, color: v.on2 } }}
          >
            <SendIcon />
          </IconButton>
        </Box>
      </Box>
      {notice && <Typography sx={{ mt: 0.5, px: 1, fontSize: 12, lineHeight: '16px', color: v.on2 }}>{notice}</Typography>}
    </Box>
  );
}
