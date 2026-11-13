import { argbFromHex, hexFromArgb, Hct, MaterialDynamicColors as M, SchemeTonalSpot, type DynamicColor } from '@material/material-color-utilities';
import { TERMINAL_COLORS, type ThemeMode } from '@agenthouse/protocol';

/** One seed color; every other role comes from Material 3's tonal palettes. */
export const SEED = '#2b5ea7';

export interface Tokens {
  /** The page. The bar and the tree lie on it. */
  bg: string;
  /** A fill on the page: what an opened row of the tree shows, the folded composer's field, a grey button. */
  bg2: string;
  /** A card on the page: a pane, the open composer, the row of a session a pane shows. */
  surface: string;
  /** What floats over both: menus, popovers, dialogs. */
  raised: string;
  /** A fill on a card or on what floats, and a stronger one for any of the three. */
  surface2: string;
  surface3: string;
  /** The chosen side of a switch, standing out of its track. */
  thumb: string;
  /** Veils of the text color: under the pointer, and pressed. */
  hover: string;
  press: string;
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
  /** Tooltips and notices: the other mode's surface. */
  inverse: string;
  onInverse: string;
  /** Height, as box shadows: a card at rest, a card in use (the active pane, the open composer), what floats. */
  shadow1: string;
  shadow2: string;
  shadow3: string;
  /** The edge of an area set into a card (a pane's terminal or conversation), as an inset box shadow. */
  well: string;
  termBg: string;
  termOn: string;
  termDim: string;
}

/** `#rrggbb` at an opacity, with commas: MUI's palette reads this form too. */
function veil(hex: string, alpha: number): string {
  const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** How strong a level's near shadow is, and its wide one. */
type Strength = readonly [near: number, wide: number];

/**
 * Material 3's levels 1 to 3 (a near shadow and a wide one) at a fraction of their strength, over a
 * hairline that draws the edge. All of them lie outside the box, so one fades into another and
 * nothing changes size.
 */
function shadows(ink: string, edge: string, one: Strength, two: Strength, three: Strength) {
  return {
    shadow1: `0 0 0 1px ${edge}, 0 1px 2px ${veil(ink, one[0])}, 0 1px 3px 1px ${veil(ink, one[1])}`,
    shadow2: `0 0 0 1px ${edge}, 0 1px 2px ${veil(ink, two[0])}, 0 3px 8px 2px ${veil(ink, two[1])}`,
    shadow3: `0 0 0 1px ${edge}, 0 2px 4px ${veil(ink, three[0])}, 0 8px 20px 4px ${veil(ink, three[1])}`,
  };
}

function build(dark: boolean): Tokens {
  const scheme = new SchemeTonalSpot(Hct.fromInt(argbFromHex(SEED)), dark, 0);
  const hex = (color: DynamicColor) => hexFromArgb(color.getArgb(scheme));
  const on = hex(M.onSurface);
  return {
    bg: hex(dark ? M.surface : M.surfaceContainerLow),
    // The light page is two tones from `surface2`, too few to tell a fill from it.
    bg2: dark ? veil(on, 0.08) : hex(M.surfaceContainerHigh),
    // Dark shows height as lighter tones, light as shadow alone.
    surface: hex(dark ? M.surfaceContainer : M.surfaceContainerLowest),
    raised: hex(dark ? M.surfaceContainerHigh : M.surfaceContainerLowest),
    // Dark fills are veils, so each is a step lighter than whichever level it lies on.
    surface2: dark ? veil(on, 0.08) : hex(M.surfaceContainer),
    surface3: dark ? veil(on, 0.14) : hex(M.surfaceContainerHighest),
    thumb: dark ? veil(on, 0.12) : hex(M.surfaceContainerLowest),
    hover: veil(on, 0.08),
    press: veil(on, 0.12),
    on,
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
    inverse: hex(M.inverseSurface),
    onInverse: hex(M.inverseOnSurface),
    // A shadow hardly shows on a dark page: there the lighter tone and the edge carry the height.
    ...(dark ? shadows('#000000', veil(on, 0.07), [0.4, 0.2], [0.45, 0.3], [0.5, 0.4]) : shadows(on, veil(on, 0.05), [0.08, 0.05], [0.1, 0.08], [0.1, 0.12])),
    well: `inset 0 0 0 1px ${dark ? veil('#000000', 0.3) : veil(on, 0.08)}`,
    // What the session host also tells a CLI that asks for the terminal colors.
    termBg: TERMINAL_COLORS[dark ? 'dark' : 'light'].background,
    termOn: TERMINAL_COLORS[dark ? 'dark' : 'light'].foreground,
    termDim: dark ? '#9ba1ae' : '#5a5f6c',
  };
}

export const TOKENS: Record<ThemeMode, Tokens> = { light: build(false), dark: build(true) };

const VAR_NAMES: Record<keyof Tokens, string> = {
  bg: '--ah-bg',
  bg2: '--ah-bg-2',
  surface: '--ah-surface',
  raised: '--ah-raised',
  surface2: '--ah-surface-2',
  surface3: '--ah-surface-3',
  thumb: '--ah-thumb',
  hover: '--ah-hover',
  press: '--ah-press',
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
  inverse: '--ah-inverse',
  onInverse: '--ah-on-inverse',
  shadow1: '--ah-shadow-1',
  shadow2: '--ah-shadow-2',
  shadow3: '--ah-shadow-3',
  well: '--ah-well',
  termBg: '--ah-term-bg',
  termOn: '--ah-term-on',
  termDim: '--ah-term-dim',
};

export function cssVars(tokens: Tokens): Record<string, string> {
  return Object.fromEntries(Object.entries(tokens).map(([key, value]) => [VAR_NAMES[key as keyof Tokens], value]));
}

/** `var(--ah-surface-2)` etc., for sx props. */
export const v = Object.fromEntries(Object.entries(VAR_NAMES).map(([key, name]) => [key, `var(${name})`])) as Record<keyof Tokens, string>;

/**
 * How long a change takes: `fast` for what answers the pointer (hover, press), `base` for a change of
 * height or size. The durations are variables so that one rule stills every transition made of them
 * when the system asks for less motion.
 */
const BASE_MS = 200;
export const MOTION_VARS = { '--ah-fast': '120ms', '--ah-base': `${BASE_MS}ms` } as const;
export const STILL_VARS = { '--ah-fast': '0ms', '--ah-base': '0ms' } as const;
const EASING = 'cubic-bezier(0.2, 0, 0, 1)';
export const motion = { fast: `var(--ah-fast) ${EASING}`, base: `var(--ah-base) ${EASING}` } as const;
/** `base` for a component that times its own change (MUI's Collapse); such a one follows the system's setting by itself. */
export const BASE_TIMING = { timeout: BASE_MS, easing: EASING } as const;
