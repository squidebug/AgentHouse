import '@fontsource/ibm-plex-sans-kr/400.css';
import '@fontsource/ibm-plex-sans-kr/500.css';
import '@fontsource/ibm-plex-sans-kr/600.css';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/500.css';
import '@fontsource/nanum-gothic-coding/400.css';
import { Box, Button, CssBaseline, GlobalStyles, Typography } from '@mui/material';
import { ThemeProvider } from '@mui/material/styles';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { Boundary } from './components/Boundary';
import { LoginGate } from './components/LoginGate';
import { StartupCheck } from './components/StartupCheck';
import { lang, t } from './strings';
import { theme } from './theme/theme';
import { cssVars, motion, MOTION_VARS, STILL_VARS, TOKENS } from './theme/tokens';

const globalStyles = {
  ':root, :root.light': cssVars(TOKENS.light),
  ':root.dark': cssVars(TOKENS.dark),
  html: MOTION_VARS,
  body: { margin: 0, background: 'var(--ah-bg)' },
  // Drag handles appear on hover only, to keep resting screens quiet.
  '.ah-grip': { opacity: 0, transition: `opacity ${motion.fast}`, color: 'var(--ah-on-2)' },
  '.ah-row:hover .ah-grip, .ah-phead:hover .ah-grip': { opacity: 0.7 },
  '.xterm .xterm-viewport': { backgroundColor: 'transparent !important' },
  '@keyframes ah-pulse': { '0%, 100%': { opacity: 1 }, '50%': { opacity: 0.35 } },
  '.ah-working': { animation: 'ah-pulse 1.6s ease-in-out infinite' },
  // Composer parts that slide open sideways when they first appear.
  '@keyframes ah-reveal': { from: { maxWidth: 0, opacity: 0, marginLeft: 0, marginRight: 0 } },
  '@media (prefers-reduced-motion: reduce)': {
    // Every transition is timed by these.
    html: STILL_VARS,
    '.ah-working': { animation: 'none' },
  },
} as const;

// The page says which language it is in: a screen reader reads it so, and the browser offers no translation of it.
document.documentElement.lang = lang;

const root = document.getElementById('root');
if (!root) throw new Error('missing #root');

// The last resort, if a failure escaped every boundary nearer to it: the sessions run on in the host.
const failed = (
  <Box sx={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 2 }}>
    <Typography>{t.cannotShow}</Typography>
    <Button variant="outlined" onClick={() => window.location.reload()}>
      {t.reload}
    </Button>
  </Box>
);

createRoot(root, {
  // Caught and shown as plain text or a notice in its place: worth a warning, not an error.
  onCaughtError: (error) => console.warn('render failed:', error),
}).render(
  <StrictMode>
    <ThemeProvider theme={theme} defaultMode="system">
      <CssBaseline enableColorScheme />
      <GlobalStyles styles={globalStyles} />
      <Boundary fallback={failed}>
        <LoginGate>
          <StartupCheck>
            <App />
          </StartupCheck>
        </LoginGate>
      </Boundary>
    </ThemeProvider>
  </StrictMode>,
);
