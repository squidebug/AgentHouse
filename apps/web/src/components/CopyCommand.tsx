import { Box, IconButton, Tooltip } from '@mui/material';
import { useState } from 'react';
import { t } from '../strings';
import { FONT_MONO } from '../theme/theme';
import { v } from '../theme/tokens';
import { CopyIcon } from './icons';

/** A command the user can copy to fix their environment; `plain` drops the chip, for a line that has its own frame. */
export function CopyCommand({ command, plain = false }: { command: string; plain?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, pl: plain ? 0 : 1.25, borderRadius: '8px', bgcolor: plain ? 'transparent' : v.surface2, maxWidth: '100%', color: plain ? v.on2 : undefined }}>
      <Box component="code" sx={{ flex: 1, minWidth: 0, fontFamily: FONT_MONO, fontSize: 12, overflowWrap: 'anywhere', py: '6px' }}>
        {command}
      </Box>
      <Tooltip title={copied ? t.copied : t.copy}>
        <IconButton
          aria-label={t.copy}
          size="small"
          onClick={() => {
            navigator.clipboard
              .writeText(command)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
              .catch(() => {});
          }}
          sx={{ width: 32, height: 32, color: v.on2 }}
        >
          <CopyIcon size={15} />
        </IconButton>
      </Tooltip>
    </Box>
  );
}
