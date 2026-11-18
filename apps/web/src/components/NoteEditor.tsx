import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, InputBase, Typography } from '@mui/material';
import { useEffect, useId, useRef, useState } from 'react';
import type { TextFile } from '@agenthouse/protocol';
import { RequestError } from '../api/client';
import { t } from '../strings';
import { FONT_MONO } from '../theme/theme';
import { motion, v } from '../theme/tokens';
import { PathText } from './PathText';

interface Props {
  /** What is edited, as the user knows it: a skill's name, a note's title. */
  title: string;
  load: () => Promise<TextFile>;
  /** Saves over the version that was loaded; refused when the file has changed on disk since. */
  save: (text: string, version: string) => Promise<TextFile>;
  /** `saved`: the file was written. */
  onClose: (saved: boolean) => void;
}

/**
 * One of the user's notes for Claude (a skill, CLAUDE.md, a memory note), to
 * read and to edit as the text it is. Claude and the user's own editor write
 * these files too: a save goes over the version this loaded, never over a
 * newer one, and then offers to load that one.
 */
export function NoteEditor({ title, load, save, onClose }: Props) {
  const [file, setFile] = useState<TextFile | null>(null);
  const [text, setText] = useState('');
  // What it waits for: the file, or the save.
  const [waiting, setWaiting] = useState<'load' | 'save' | null>('load');
  const titleId = useId();
  const [problem, setProblem] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  // The newest of them: a dialog is opened with functions made for that one drawing.
  const actions = useRef({ load, save });
  actions.current = { load, save };

  const why = (label: string, error: unknown) => (error instanceof RequestError ? `${label} · ${error.message}` : label);
  const read = () => {
    setWaiting('load');
    setProblem(null);
    setStale(false);
    actions.current
      .load()
      .then((loaded) => {
        setFile(loaded);
        setText(loaded.text);
      })
      .catch((error: unknown) => setProblem(why(t.failure.load, error)))
      .finally(() => setWaiting(null));
  };
  useEffect(read, []);

  const edited = file !== null && text !== file.text;
  const store = () => {
    if (!file || !edited || waiting) return;
    setWaiting('save');
    setProblem(null);
    actions.current
      .save(text, file.version)
      .then(() => onClose(true))
      .catch((error: unknown) => {
        setStale(error instanceof RequestError && error.code === 'CHANGED');
        setProblem(error instanceof RequestError && error.code === 'CHANGED' ? t.changedOnDisk : why(t.failure.save, error));
        setWaiting(null);
      });
  };

  return (
    <Dialog
      open
      // What was typed is not thrown away by a click beside the dialog or by Esc: only 취소 does that.
      onClose={() => !edited && onClose(false)}
      maxWidth="md"
      fullWidth
      aria-labelledby={titleId}
    >
      <DialogTitle sx={{ pb: 1, fontSize: 18, fontWeight: 600 }}>
        <span id={titleId}>{t.edit(title)}</span>
        {file && (
          <Box sx={{ mt: '2px', fontSize: 12, lineHeight: '16px', fontWeight: 400, color: v.on2 }}>
            <PathText path={file.path} />
          </Box>
        )}
      </DialogTitle>
      <DialogContent sx={{ pb: 1 }}>
        <InputBase
          multiline
          fullWidth
          minRows={16}
          maxRows={26}
          value={text}
          disabled={!file}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
              event.preventDefault();
              store();
            }
          }}
          inputProps={{ 'aria-label': title, spellCheck: false }}
          sx={{
            alignItems: 'flex-start',
            p: '10px 12px',
            borderRadius: '10px',
            bgcolor: v.surface2,
            fontFamily: FONT_MONO,
            fontSize: 13,
            lineHeight: '20px',
            transition: `box-shadow ${motion.fast}`,
            '&.Mui-focused': { boxShadow: `inset 0 0 0 2px ${v.primary}` },
          }}
        />
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2, gap: 1 }}>
        <Box role="status" sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 1 }}>
          {waiting === 'load' && <Typography sx={{ fontSize: 12, color: v.on2 }}>{t.loading}</Typography>}
          {problem && <Typography sx={{ fontSize: 12, color: v.error }}>{problem}</Typography>}
          {stale && (
            <Button size="small" color="inherit" onClick={read} sx={{ minHeight: 28, px: 1.5, fontSize: 12 }}>
              {t.loadAgain}
            </Button>
          )}
        </Box>
        <Button color="inherit" onClick={() => onClose(false)}>
          {t.cancel}
        </Button>
        <Button variant="contained" disabled={!edited || waiting !== null} onClick={store}>
          {t.save}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
