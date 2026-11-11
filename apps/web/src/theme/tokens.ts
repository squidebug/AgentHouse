import { argbFromHex, hexFromArgb, Hct, MaterialDynamicColors as M, SchemeTonalSpot, type DynamicColor } from '@material/material-color-utilities';
import type { ThemeMode } from '@agenthouse/protocol';

/** One seed color; every other role comes from Material 3's tonal palettes. */
export const SEED = '#2b5ea7';

export interface Tokens {
  bg: string;
  surface: string;
  surface2: string;
  surface3: string;
  on: string;
  on2: string;
  outline: string;
  primary: string;
  onPrimary: string;
  primaryContainer: string;
  onPrimaryContainer: string;
  error: string;
  warn: string;
  warnContainer: string;
  onWarnContainer: string;
  done: string;
  dropBg: string;
  termBg: string;
  termOn: string;
  termDim: string;
}

function build(dark: boolean): Tokens {
  const scheme = new SchemeTonalSpot(Hct.fromInt(argbFromHex(SEED)), dark, 0);
  const hex = (color: DynamicColor) => hexFromArgb(color.getArgb(scheme));
  return {
    bg: hex(dark ? M.surface : M.surfaceContainerLow),
    surface: hex(dark ? M.surfaceContainerLow : M.surfaceContainerLowest),
    surface2: hex(M.surfaceContainer),
    surface3: hex(M.surfaceContainerHighest),
    on: hex(M.onSurface),
    on2: hex(M.onSurfaceVariant),
    outline: hex(M.outlineVariant),
    primary: hex(M.primary),
    onPrimary: hex(M.onPrimary),
    primaryContainer: hex(M.primaryContainer),
    onPrimaryContainer: hex(M.onPrimaryContainer),
    error: hex(M.error),
    // Material 3 has no warning role; these keep 4.5:1 against their containers.
    warn: dark ? '#ffb77c' : '#9a4f00',
    warnContainer: dark ? '#5a3000' : '#ffe0c7',
    onWarnContainer: dark ? '#ffdcc2' : '#4f2600',
    done: dark ? '#9ccfb4' : '#2f6a52',
    dropBg: dark ? 'rgba(169, 199, 255, 0.10)' : 'rgba(43, 94, 167, 0.07)',
    // Must match the server's THEME_COLORS, which answers the CLI's color queries.
    termBg: dark ? '#12151a' : '#fbfcfe',
    termOn: dark ? '#dfe2ea' : '#1f2328',
    termDim: dark ? '#9ba1ae' : '#5a5f6c',
  };
}

export const TOKENS: Record<ThemeMode, Tokens> = { light: build(false), dark: build(true) };

const VAR_NAMES: Record<keyof Tokens, string> = {
  bg: '--ah-bg',
  surface: '--ah-surface',
  surface2: '--ah-surface-2',
  surface3: '--ah-surface-3',
  on: '--ah-on',
  on2: '--ah-on-2',
  outline: '--ah-outline',
  primary: '--ah-primary',
  onPrimary: '--ah-on-primary',
  primaryContainer: '--ah-primary-container',
  onPrimaryContainer: '--ah-on-primary-container',
  error: '--ah-error',
  warn: '--ah-warn',
  warnContainer: '--ah-warn-container',
  onWarnContainer: '--ah-on-warn-container',
  done: '--ah-done',
  dropBg: '--ah-drop-bg',
  termBg: '--ah-term-bg',
  termOn: '--ah-term-on',
  termDim: '--ah-term-dim',
};

export function cssVars(tokens: Tokens): Record<string, string> {
  return Object.fromEntries(Object.entries(tokens).map(([key, value]) => [VAR_NAMES[key as keyof Tokens], value]));
}

/** `var(--ah-surface-2)` etc., for sx props. */
export const v = Object.fromEntries(Object.entries(VAR_NAMES).map(([key, name]) => [key, `var(${name})`])) as Record<keyof Tokens, string>;
