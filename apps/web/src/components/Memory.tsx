import { Box, MenuItem, MenuList, Typography } from '@mui/material';
import { useCallback, useEffect, useState } from 'react';
import type { MemoryFile } from '@agenthouse/protocol';
import { api } from '../api/client';
import { t } from '../strings';
import { v } from '../theme/tokens';
import { NoteEditor } from './NoteEditor';

const KINDS = ['instructions', 'memory'] as const;

/** A memory note by the title it gives itself; an instruction file by its name. */
const fileTitle = (file: MemoryFile) => file.title ?? file.name;

/** The line under it: what a note says of itself (else its file, when its title is not that), and whose an instruction file is. */
const fileNote = (file: MemoryFile) => (file.kind === 'memory' ? (file.about ?? (file.title ? file.name : null)) : t.memoryScope[file.scope]);

/**
 * What Claude reads into the sessions of a folder by itself: the user's
 * instructions (CLAUDE.md and what goes with it), then the notes Claude keeps
 * for the project. Read through one of the folder's sessions whenever the
 * list is shown, since Claude writes these files; each opens as text to edit.
 */
export function MemoryList({ sessionId }: { sessionId: string }) {
  const [files, setFiles] = useState<MemoryFile[] | null | undefined>(undefined);
  const [editing, setEditing] = useState<MemoryFile | null>(null);
  const read = useCallback(() => {
    api
      .memory(sessionId)
      .then((result) => setFiles(result.files))
      .catch(() => setFiles((current) => current ?? null));
  }, [sessionId]);
  useEffect(read, [read]);

  if (files === undefined) return <Typography sx={{ color: v.on2 }}>{t.loading}</Typography>;
  if (files === null) return <Typography sx={{ color: v.on2 }}>{t.cannotShow}</Typography>;
  if (!files.length) return <Typography sx={{ color: v.on2 }}>{t.none}</Typography>;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {KINDS.map((kind) => {
        const group = files.filter((file) => file.kind === kind);
        if (!group.length) return null;
        return (
          <Box key={kind} sx={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            <Typography sx={{ fontSize: 12, lineHeight: '16px', fontWeight: 500, color: v.on2 }}>
              {t.memoryKind[kind]} {group.length}
            </Typography>
            <MenuList aria-label={t.memoryKind[kind]} sx={{ p: 0, mx: -1 }}>
              {group.map((file) => (
                <MenuItem key={file.id} aria-label={t.edit(fileTitle(file))} onClick={() => setEditing(file)} sx={{ display: 'flex', alignItems: 'flex-start', gap: '8px', px: 1, py: '6px', borderRadius: '8px', whiteSpace: 'normal' }}>
                  <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                    <Typography noWrap sx={{ fontWeight: 500 }}>
                      {fileTitle(file)}
                    </Typography>
                    {fileNote(file) && <Typography sx={{ fontSize: 12, lineHeight: '16px', color: v.on2, overflowWrap: 'anywhere' }}>{fileNote(file)}</Typography>}
                  </Box>
                  {file.type && (
                    <Box component="span" sx={{ flex: 'none', mt: '2px', px: '8px', borderRadius: '8px', bgcolor: v.surface2, fontSize: 12, lineHeight: '20px' }}>
                      {file.type}
                    </Box>
                  )}
                </MenuItem>
              ))}
            </MenuList>
          </Box>
        );
      })}
      {editing && (
        <NoteEditor
          title={fileTitle(editing)}
          load={() => api.memoryFile(sessionId, editing.id)}
          save={(text, version) => api.saveMemory(sessionId, editing.id, text, version)}
          onClose={(saved) => {
            setEditing(null);
            // A note's title and its line come from its text.
            if (saved) read();
          }}
        />
      )}
    </Box>
  );
}
