import '@fontsource/ibm-plex-sans-kr/400.css';
import '@fontsource/ibm-plex-sans-kr/500.css';
import '@fontsource/ibm-plex-sans-kr/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/nanum-gothic-coding/400.css';
import { CssBaseline, GlobalStyles } from '@mui/material';
import { ThemeProvider } from '@mui/material/styles';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { theme } from './theme/theme';
import { cssVars, TOKENS } from './theme/tokens';

const globalStyles = {
  ':root, :root.light': cssVars(TOKENS.light),
  ':root.dark': cssVars(TOKENS.dark),
  body: { margin: 0, background: 'var(--ah-bg)' },
  // Drag handles appear on hover only, to keep resting screens quiet.
  '.ah-grip': { opacity: 0, transition: 'opacity .12s', color: 'var(--ah-on-2)' },
  '.ah-row:hover .ah-grip, .ah-phead:hover .ah-grip': { opacity: 0.7 },
  '.xterm .xterm-viewport': { backgroundColor: 'transparent !important' },
  '@keyframes ah-pulse': { '0%, 100%': { opacity: 1 }, '50%': { opacity: 0.35 } },
  '.ah-working': { animation: 'ah-pulse 1.6s ease-in-out infinite' },
  '@media (prefers-reduced-motion: reduce)': { '.ah-working': { animation: 'none' } },
} as const;

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

createRoot(root).render(
  <StrictMode>
    <ThemeProvider theme={theme} defaultMode="system">
      <CssBaseline enableColorScheme />
      <GlobalStyles styles={globalStyles} />
      <App />
    </ThemeProvider>
  </StrictMode>,
);
