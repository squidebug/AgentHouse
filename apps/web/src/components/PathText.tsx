import { Box } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';

/**
 * A path on one line that keeps its end: when it does not fit, the folders at
 * its start go behind the ellipsis, not the name it ends with. The whole path
 * is still the text: hovering shows it, selecting copies it.
 */
export function PathText({ path, sx }: { path: string; sx?: SxProps<Theme> }) {
  return (
    <Box
      component="span"
      title={path}
      // Right to left only decides which end is cut off; the path inside is laid out as it reads (bdi).
      sx={[{ display: 'block', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', direction: 'rtl', textAlign: 'left' }, ...(Array.isArray(sx) ? sx : [sx])]}
    >
      <bdi>{path}</bdi>
    </Box>
  );
}
