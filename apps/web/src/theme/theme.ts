import { createTheme, type Overlays, type Shadows } from '@mui/material/styles';
import { TOKENS, v, type Tokens } from './tokens';

export const FONT_UI = '"IBM Plex Sans KR", system-ui, sans-serif';
export const FONT_MONO = '"JetBrains Mono", "Nanum Gothic Coding", Consolas, monospace';

function palette(t: Tokens) {
  return {
    primary: { main: t.primary, contrastText: t.onPrimary },
    error: { main: t.error },
    warning: { main: t.warn },
    success: { main: t.done },
    // MUI's paper is what floats (dialogs, popovers, menus); the app's own cards are `surface`.
    background: { default: t.bg, paper: t.raised },
    text: { primary: t.on, secondary: t.on2 },
    divider: t.outline,
    // Icon buttons and menu rows answer the pointer with the same veil as the app's own rows.
    action: { active: t.on2, hover: t.hover, hoverOpacity: 0.08 },
  };
}

// MUI asks for one of 25 heights (a popover 8, a dialog 24, a notice 6); there are three.
const shadows = Array.from({ length: 25 }, (_, height) => (height === 0 ? 'none' : height < 3 ? v.shadow1 : height < 6 ? v.shadow2 : v.shadow3)) as Shadows;
// MUI lays a white veil over dark paper, stronger the higher it is; dark paper has the tone of its height (`raised`) already.
const overlays = Array.from({ length: 25 }, () => 'none') as Overlays;

// Type scale: 12 (secondary), 13 (body), 14 (titles), 18 (screen titles); weights 400/500/600.
export const theme = createTheme({
  cssVariables: { colorSchemeSelector: 'class' },
  colorSchemes: {
    light: { palette: palette(TOKENS.light) },
    dark: { palette: palette(TOKENS.dark), overlays },
  },
  shadows,
  // The keyboard's focus: a 2px ring in the primary color around what has it.
  focusVisible: true,
  motion: { reducedMotion: 'system' },
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
      styleOverrides: {
        root: {
          borderRadius: 999,
          minHeight: 36,
          paddingInline: 16,
          // A filled button lies flat and lifts a step under the pointer.
          variants: [
            {
              props: { variant: 'contained' },
              style: { boxShadow: 'none', '&:hover': { boxShadow: v.shadow1 }, '&:active, &.Mui-focusVisible': { boxShadow: 'none' } },
            },
          ],
        },
      },
    },
    MuiIconButton: { styleOverrides: { root: { borderRadius: 10 } } },
    MuiDialog: { styleOverrides: { paper: { borderRadius: 16 } } },
    MuiPopover: { styleOverrides: { paper: { borderRadius: 12 } } },
    MuiTooltip: { styleOverrides: { tooltip: { fontSize: 12, backgroundColor: v.inverse, color: v.onInverse }, arrow: { color: v.inverse } } },
    MuiSnackbarContent: { styleOverrides: { root: { backgroundColor: v.inverse, color: v.onInverse } } },
  },
});
