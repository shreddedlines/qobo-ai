/**
 * Whether the conversation sidebar is collapsed, remembered per browser.
 *
 * The same shape as the theme preference: a per-viewer convenience that must never
 * stop the app working. Reading it can throw in a private window, so every access is
 * guarded and an unreadable value simply means "expanded".
 *
 * It applies from desktop width up. Below that the history lives in a drawer, which
 * has its own open/closed state and no room to collapse into.
 */
export const SIDEBAR_STORAGE_KEY = 'qobo-sidebar';

const COLLAPSED = 'collapsed';
const EXPANDED = 'expanded';

export interface PreferenceStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export function readSidebarCollapsed(storage: PreferenceStorage | undefined): boolean {
  try {
    return storage?.getItem(SIDEBAR_STORAGE_KEY) === COLLAPSED;
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(storage: PreferenceStorage | undefined, collapsed: boolean): void {
  try {
    storage?.setItem(SIDEBAR_STORAGE_KEY, collapsed ? COLLAPSED : EXPANDED);
  } catch {
    // A browser that refuses storage still gets the choice for this session.
  }
}

/** What the toggle says, so its state never rests on an icon alone. */
export function sidebarToggleLabel(collapsed: boolean): string {
  return collapsed ? 'Show conversation sidebar' : 'Hide conversation sidebar';
}
