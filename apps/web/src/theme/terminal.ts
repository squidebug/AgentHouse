import type { ITheme } from '@xterm/xterm';
import type { ThemeMode } from '@agenthouse/protocol';
import { TOKENS } from './tokens';

// ANSI palettes tuned for each background; light mode additionally raises
// contrast (minimumContrastRatio) for CLIs that assume a dark terminal.
export const XTERM_THEMES: Record<ThemeMode, ITheme> = {
  dark: {
    background: TOKENS.dark.termBg,
    foreground: TOKENS.dark.termOn,
    cursor: TOKENS.dark.primary,
    selectionBackground: '#3a4859',
    black: '#1a1c1e',
    red: '#ffb4ab',
    green: '#9ad49a',
    yellow: '#e6c46a',
    blue: '#aac7ff',
    magenta: '#d8bafa',
    cyan: '#80d4dc',
    white: '#c3c6cf',
    brightBlack: '#8d9199',
    brightRed: '#ffdad6',
    brightGreen: '#b6f0b4',
    brightYellow: '#ffe08a',
    brightBlue: '#d6e3ff',
    brightMagenta: '#eedcff',
    brightCyan: '#a6f0f8',
    brightWhite: '#ffffff',
  },
  light: {
    background: TOKENS.light.termBg,
    foreground: TOKENS.light.termOn,
    cursor: TOKENS.light.primary,
    selectionBackground: '#d3e3fd',
    black: '#1a1c1e',
    red: '#ba1a1a',
    green: '#1d6b2e',
    yellow: '#7a5900',
    blue: '#3b5f90',
    magenta: '#6e4b9e',
    cyan: '#00696f',
    white: '#5a5f67',
    brightBlack: '#73777f',
    brightRed: '#d23b2f',
    brightGreen: '#2e8540',
    brightYellow: '#946c00',
    brightBlue: '#4f78b0',
    brightMagenta: '#8661b8',
    brightCyan: '#00838a',
    brightWhite: '#2e3036',
  },
};

export const MIN_CONTRAST: Record<ThemeMode, number> = { light: 4.5, dark: 1 };
