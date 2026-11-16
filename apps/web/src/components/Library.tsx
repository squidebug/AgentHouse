import { Box, Button, ButtonBase, Dialog, DialogActions, DialogContent, DialogTitle, Tooltip } from '@mui/material';
import { useId, useState } from 'react';
import type { SessionInfo } from '@agenthouse/protocol';
import { t } from '../strings';
import { v } from '../theme/tokens';
import { libraryFolders, startFolder, type LibraryFolder } from '../workspace/library';
import { keySx } from './key';
import { MemoryList } from './Memory';
import { SkillsList } from './Skills';
import { switchSide, switchTrack } from './switch';

type Kind = 'skills' | 'memory';
const TITLE: Record<Kind, string> = { skills: t.skills, memory: t.memory };

// A key of the tree's foot: half of it, edge to edge. The one under the pointer or with the focus lies
// over the other, so its shadow and its ring show whole.
const footKey = { flex: 1, minWidth: 0, minHeight: 40, fontWeight: 500, ...keySx, '&:hover, &.Mui-focusVisible': { zIndex: 1 } } as const;
// Together the two are one block: only its outer corners are round, a little, and where they meet
// they are square.
const first = { ...footKey, borderRadius: '8px 0 0 8px' } as const;
// The line between them is the second one's own left edge, drawn inside it.
const line = `inset 1px 0 0 ${v.outline}`;
const second = { ...footKey, borderRadius: '0 8px 8px 0', boxShadow: `${line}, ${v.shadow1}`, '&:hover': { bgcolor: v.thumb, boxShadow: `${line}, ${v.shadow2}` } } as const;

/** Which folder's: shown when sessions run in more than one. The user's own part is the same in each. */
function FolderSwitch({ folders, cwd, onChange }: { folders: LibraryFolder[]; cwd: string; onChange: (cwd: string) => void }) {
  return (
    <Box role="group" aria-label={t.folder} sx={{ ...switchTrack, flexWrap: 'wrap', alignSelf: 'flex-start', maxWidth: '100%' }}>
      {folders.map((folder) => (
        <Tooltip key={folder.cwd} title={folder.cwd}>
          <ButtonBase aria-pressed={folder.cwd === cwd} onClick={() => onChange(folder.cwd)} sx={{ minHeight: 28, px: '12px', fontSize: 12, fontWeight: 500, ...switchSide(folder.cwd === cwd) }}>
            {folder.label}
          </ButtonBase>
        </Tooltip>
      ))}
    </Box>
  );
}

function LibraryWindow({ kind, folders, startCwd, onClose }: { kind: Kind; folders: LibraryFolder[]; startCwd: string | undefined; onClose: () => void }) {
  const [cwd, setCwd] = useState(() => startFolder(folders, startCwd)?.cwd);
  // The folder chosen, while it still has a session.
  const folder = folders.find((candidate) => candidate.cwd === cwd) ?? folders[0];
  const titleId = useId();
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth aria-labelledby={titleId}>
      <DialogTitle id={titleId} sx={{ pb: 1, fontSize: 18, fontWeight: 600 }}>
        {TITLE[kind]}
      </DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 2, minHeight: 200 }}>
        {folders.length > 1 && folder && <FolderSwitch folders={folders} cwd={folder.cwd} onChange={setCwd} />}
        {folder && (kind === 'skills' ? <SkillsList key={folder.sessionId} sessionId={folder.sessionId} used={folder.used} /> : <MemoryList key={folder.sessionId} sessionId={folder.sessionId} />)}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button color="inherit" onClick={onClose}>
          {t.close}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/**
 * Skills and memory, at the foot of the session tree: they are the user's and
 * a folder's, shared by every session and sub-agent there, so they have a
 * place of their own instead of a line in each session. Each opens a window
 * for the folder of the session the user is at.
 */
export function LibraryButtons({ sessions, activeCwd }: { sessions: SessionInfo[]; activeCwd: string | undefined }) {
  const [shown, setShown] = useState<Kind | null>(null);
  const folders = libraryFolders(sessions);
  return (
    <>
      {/* The foot is its two keys and nothing else: each fills its half to the edges. The rows of the
          tree scroll away under it. */}
      <Box role="group" aria-label={t.library} sx={{ flex: 'none', display: 'flex', mt: { xs: '6px', md: 0 } }}>
        {(['skills', 'memory'] as const).map((kind, index) => (
          <Button key={kind} color="inherit" disabled={!folders.length} onClick={() => setShown(kind)} sx={index ? second : first}>
            {TITLE[kind]}
          </Button>
        ))}
      </Box>
      {shown && folders.length > 0 && <LibraryWindow kind={shown} folders={folders} startCwd={activeCwd} onClose={() => setShown(null)} />}
    </>
  );
}
