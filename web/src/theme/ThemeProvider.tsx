import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

import {
  applyThemeAttribute,
  nextThemeChoice,
  readThemeChoice,
  resolveTheme,
  writeThemeChoice,
  type ResolvedTheme,
  type ThemeChoice,
} from './theme.ts';

export interface ThemeContextValue {
  choice: ThemeChoice;
  resolved: ResolvedTheme;
  setChoice: (choice: ThemeChoice) => void;
  cycle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const DARK_QUERY = '(prefers-color-scheme: dark)';

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(DARK_QUERY).matches;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoiceState] = useState<ThemeChoice>(() => readThemeChoice(globalThis.localStorage));
  const [prefersDark, setPrefersDark] = useState<boolean>(() => systemPrefersDark());

  // The operating system is an external system: subscribe, do not poll.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(DARK_QUERY);
    const update = (event: MediaQueryListEvent) => setPrefersDark(event.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    applyThemeAttribute(document.documentElement, choice);
  }, [choice]);

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next);
    writeThemeChoice(globalThis.localStorage, next);
  }, []);

  const cycle = useCallback(() => setChoice(nextThemeChoice(choice)), [choice, setChoice]);

  return (
    <ThemeContext.Provider value={{ choice, resolved: resolveTheme(choice, prefersDark), setChoice, cycle }}>{children}</ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (!value) throw new Error('useTheme must be used inside ThemeProvider');
  return value;
}
