import { createTheme } from '@mui/material/styles';
import { TOKENS, type Tokens } from './tokens';

export const FONT_UI = '"IBM Plex Sans KR", system-ui, sans-serif';
export const FONT_MONO = '"JetBrains Mono", "Nanum Gothic Coding", Consolas, monospace';

function palette(t: Tokens) {
  return {
    primary: { main: t.primary, contrastText: t.onPrimary },
    error: { main: t.error },
    warning: { main: t.warn },
    success: { main: t.done },
    background: { default: t.bg, paper: t.surface },
    text: { primary: t.on, secondary: t.on2 },
    divider: t.outline,
  };
}

// Type scale: 12 (secondary), 13 (body), 14 (titles), 18 (screen titles); weights 400/500/600.
export const theme = createTheme({
  cssVariables: { colorSchemeSelector: 'class' },
  colorSchemes: {
    light: { palette: palette(TOKENS.light) },
    dark: { palette: palette(TOKENS.dark) },
  },
  typography: {
    fontFamily: FONT_UI,
    fontSize: 13,
    htmlFontSize: 16,
    fontWeightRegular: 400,
    fontWeightMedium: 500,
    fontWeightBold: 600,
    body1: { fontSize: 13, lineHeight: '20px' },
    body2: { fontSize: 12, lineHeight: '16px' },
    subtitle1: { fontSize: 14, lineHeight: '20px', fontWeight: 600 },
    h6: { fontSize: 18, lineHeight: '28px', fontWeight: 600 },
    button: { fontSize: 13, fontWeight: 500, textTransform: 'none' },
    caption: { fontSize: 12, lineHeight: '16px' },
  },
  shape: { borderRadius: 10 },
  components: {
    MuiButton: {
      defaultProps: { disableElevation: true },
      styleOverrides: { root: { borderRadius: 999, minHeight: 36, paddingInline: 16 } },
    },
    MuiIconButton: { styleOverrides: { root: { borderRadius: 10 } } },
    MuiDialog: { styleOverrides: { paper: { borderRadius: 16, backgroundImage: 'none' } } },
    MuiPopover: { styleOverrides: { paper: { borderRadius: 12, backgroundImage: 'none' } } },
    MuiTooltip: { styleOverrides: { tooltip: { fontSize: 12 } } },
  },
});
