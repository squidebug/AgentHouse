import type { TerminalColors, ThemeMode } from '@agenthouse/protocol';

/** What a CLI is told when it asks for the terminal's colors; matches the web app's terminal palettes. */
export const THEME_COLORS: Record<ThemeMode, TerminalColors> = {
  light: { foreground: '#1f2328', background: '#fbfcfe' },
  dark: { foreground: '#dfe2ea', background: '#12151a' },
};
