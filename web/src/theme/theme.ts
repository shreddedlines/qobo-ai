/**
 * Theme choice and how it resolves.
 *
 * "system" is the default and follows prefers-color-scheme; light and dark are manual
 * overrides that stay put. The choice is remembered per browser, which is a per-viewer
 * convenience — nothing depends on it being there, and reading it can throw in a
 * private window, so every access is guarded.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'qobo-theme';
export const THEME_CHOICES: readonly ThemeChoice[] = ['system', 'light', 'dark'];

export function isThemeChoice(value: unknown): value is ThemeChoice {
  return typeof value === 'string' && (THEME_CHOICES as readonly string[]).includes(value);
}

export function resolveTheme(choice: ThemeChoice, prefersDark: boolean): ResolvedTheme {
  if (choice === 'system') return prefersDark ? 'dark' : 'light';
  return choice;
}

/** Cycles System → Light → Dark → System, so one control covers all three. */
export function nextThemeChoice(choice: ThemeChoice): ThemeChoice {
  const index = THEME_CHOICES.indexOf(choice);
  return THEME_CHOICES[(index + 1) % THEME_CHOICES.length] ?? 'system';
}

export interface ThemeStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

/** Reads the remembered choice, falling back to "system" for anything unusable. */
export function readThemeChoice(storage: ThemeStorage | undefined): ThemeChoice {
  try {
    const stored = storage?.getItem(THEME_STORAGE_KEY);
    return isThemeChoice(stored) ? stored : 'system';
  } catch {
    return 'system';
  }
}

export function writeThemeChoice(storage: ThemeStorage | undefined, choice: ThemeChoice): void {
  try {
    storage?.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    // A browser that refuses storage still gets the theme for this session.
  }
}

/** What the theme control says: its label, and what it will do next. */
export function themeControlLabel(choice: ThemeChoice, resolved: ResolvedTheme): { label: string; accessibleLabel: string } {
  const labels: Record<ThemeChoice, string> = { system: 'System', light: 'Light', dark: 'Dark' };
  // Naming the destination avoids "System (light). Switch to light.", which sounds
  // like nothing would happen even though the choice really does change.
  const destinations: Record<ThemeChoice, string> = {
    system: 'match your system',
    light: 'always light',
    dark: 'always dark',
  };
  const next = nextThemeChoice(choice);
  const shown = choice === 'system' ? `System (${resolved})` : labels[choice];
  return {
    label: labels[choice],
    accessibleLabel: `Theme: ${shown}. Change to ${destinations[next]}.`,
  };
}

/**
 * Applies the choice to the document. "system" removes the attribute so the CSS media
 * query decides; the explicit values pin it, which is what the token file expects.
 */
export function applyThemeAttribute(root: { setAttribute: (name: string, value: string) => void; removeAttribute: (name: string) => void }, choice: ThemeChoice): void {
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}
