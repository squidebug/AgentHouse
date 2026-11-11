import { Box, IconButton, InputBase, Typography } from '@mui/material';
import { useState } from 'react';
import type { SessionInfo } from '@agenthouse/protocol';
import { api } from '../api/client';
import { t } from '../strings';
import { v } from '../theme/tokens';
import type { Dnd } from '../workspace/dnd';
import type { Action, WorkspaceState } from '../workspace/state';
import { CloseIcon, SendIcon } from './icons';

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
  const [notice, setNotice] = useState('');
  const [sending, setSending] = useState(false);

  const explicit = state.targets.map(sessionById).filter((s): s is SessionInfo => Boolean(s));
  const implicit = !explicit.length && activeSession?.state === 'running' ? activeSession : undefined;
  const recipients = implicit ? [implicit] : explicit;
  const target = { type: 'composer' as const };
  const acceptsDrop = dnd.dragging?.kind === 'session' && dnd.canDrop(target);

  const send = async () => {
    const text = draft.trim();
    if (!text || !recipients.length || sending) return;
    setSending(true);
    const results = await Promise.allSettled(recipients.map((s) => api.compose(s.id, { text: draft })));
    const ok = results.filter((r) => r.status === 'fulfilled' && r.value.sent).length;
    const failed = results.length - ok;
    setNotice([ok ? t.sentTo(ok) : '', failed ? t.failedFor(failed) : ''].filter(Boolean).join(' · '));
    if (ok) setDraft('');
    setSending(false);
  };

  return (
    <Box>
      <Box
        component="section"
        aria-label="입력"
        onDragOver={dnd.over(target)}
        onDrop={dnd.drop(target)}
        sx={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          gap: 1,
          p: 1,
          borderRadius: '16px',
          bgcolor: v.surface,
          boxShadow: dnd.isOver(target) ? `0 0 0 2px ${v.primary}` : 'none',
        }}
      >
        {recipients.map((session) => (
          <Box
            key={session.id}
            component="span"
            sx={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
              height: 32,
              pl: '10px',
              pr: implicit ? '10px' : '2px',
              borderRadius: '8px',
              bgcolor: implicit ? 'transparent' : v.surface2,
              border: implicit ? `1px dashed ${v.outline}` : 'none',
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            {session.title}
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
        ))}
        {acceptsDrop && (
          <Box
            component="span"
            sx={{ display: 'inline-flex', alignItems: 'center', height: 32, px: '10px', borderRadius: '8px', border: `1.5px dashed ${v.primary}`, color: v.primary, fontSize: 12, fontWeight: 500 }}
          >
            {t.addRecipient}
          </Box>
        )}
        <InputBase
          multiline
          maxRows={8}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
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
          sx={{ flex: '1 1 240px', minWidth: 0, minHeight: 40, px: '12px', py: '6px', borderRadius: '10px', bgcolor: v.surface2, fontSize: 13 }}
        />
        <IconButton
          aria-label={t.send}
          disabled={!draft.trim() || !recipients.length || sending}
          onClick={() => send().catch(() => {})}
          sx={{ width: 40, height: 40, bgcolor: v.primary, color: v.onPrimary, '&:hover': { bgcolor: v.primary, opacity: 0.9 }, '&.Mui-disabled': { bgcolor: v.surface2, color: v.on2 } }}
        >
          <SendIcon />
        </IconButton>
      </Box>
      {notice && <Typography sx={{ mt: 0.5, px: 1, fontSize: 12, lineHeight: '16px', color: v.on2 }}>{notice}</Typography>}
    </Box>
  );
}
