import { Box } from '@mui/material';
import Markdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { FONT_MONO } from '../theme/theme';
import { v } from '../theme/tokens';

// HTML in the text stays text, and link targets are sanitised (react-markdown's
// defaults). Links open outside the app, without a referrer.
const components: Components = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

const plugins = [remarkGfm];

/** An agent's reply. Headings stay at body sizes: the type scale is 12, 13, 14 and 18 only. */
export function MarkdownText({ text }: { text: string }) {
  return (
    <Box
      sx={{
        fontSize: 13,
        lineHeight: '20px',
        overflowWrap: 'anywhere',
        '& > :first-of-type': { mt: 0 },
        '& > :last-child': { mb: 0 },
        '& p, & ul, & ol, & pre, & table, & blockquote': { my: '6px' },
        '& h1, & h2, & h3, & h4, & h5, & h6': { fontSize: 14, lineHeight: '20px', fontWeight: 600, mt: '12px', mb: '4px' },
        '& ul, & ol': { pl: '22px' },
        '& li + li': { mt: '2px' },
        '& a': { color: v.primary },
        '& code': { fontFamily: FONT_MONO, fontSize: 12, px: '4px', py: '1px', borderRadius: '4px', bgcolor: v.surface2 },
        '& pre': { fontFamily: FONT_MONO, fontSize: 12, lineHeight: '18px', p: '8px 10px', borderRadius: '8px', bgcolor: v.surface2, overflowX: 'auto' },
        '& pre code': { p: 0, bgcolor: 'transparent' },
        '& blockquote': { pl: '10px', ml: 0, borderLeft: `3px solid ${v.outline}`, color: v.on2 },
        '& table': { borderCollapse: 'collapse', display: 'block', overflowX: 'auto', fontSize: 12 },
        '& th, & td': { border: `1px solid ${v.outline}`, px: '8px', py: '3px', textAlign: 'left' },
        '& th': { fontWeight: 600, bgcolor: v.surface2 },
        '& hr': { border: 0, borderTop: `1px solid ${v.outline}`, my: '10px' },
      }}
    >
      <Markdown remarkPlugins={plugins} components={components}>
        {text}
      </Markdown>
    </Box>
  );
}
