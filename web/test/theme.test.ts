import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  applyThemeAttribute,
  isThemeChoice,
  nextThemeChoice,
  readThemeChoice,
  resolveTheme,
  themeControlLabel,
  THEME_STORAGE_KEY,
  writeThemeChoice,
  type ThemeChoice,
} from '../src/theme/theme.ts';

function fakeStorage(initial: Record<string, string> = {}, options: { throwOnRead?: boolean; throwOnWrite?: boolean } = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key: string) {
      if (options.throwOnRead) throw new Error('storage blocked');
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      if (options.throwOnWrite) throw new Error('storage blocked');
      values.set(key, value);
    },
  };
}

describe('resolveTheme', () => {
  it('follows the operating system when the choice is system', () => {
    assert.equal(resolveTheme('system', true), 'dark');
    assert.equal(resolveTheme('system', false), 'light');
  });

  it('ignores the operating system once a theme is chosen', () => {
    assert.equal(resolveTheme('light', true), 'light');
    assert.equal(resolveTheme('dark', false), 'dark');
  });
});

describe('nextThemeChoice', () => {
  it('cycles system, light, dark and back', () => {
    assert.equal(nextThemeChoice('system'), 'light');
    assert.equal(nextThemeChoice('light'), 'dark');
    assert.equal(nextThemeChoice('dark'), 'system');
  });

  it('returns to every choice within three presses', () => {
    let choice: ThemeChoice = 'system';
    const seen = new Set<ThemeChoice>([choice]);
    for (let press = 0; press < 3; press += 1) {
      choice = nextThemeChoice(choice);
      seen.add(choice);
    }
    assert.deepEqual([...seen].sort(), ['dark', 'light', 'system']);
    assert.equal(choice, 'system', 'three presses come back to where it started');
  });
});

describe('remembering the choice', () => {
  it('reads a stored choice and writes a new one', () => {
    const storage = fakeStorage({ [THEME_STORAGE_KEY]: 'dark' });
    assert.equal(readThemeChoice(storage), 'dark');

    writeThemeChoice(storage, 'light');
    assert.equal(storage.values.get(THEME_STORAGE_KEY), 'light');
  });

  it('falls back to system for missing or nonsense values', () => {
    assert.equal(readThemeChoice(fakeStorage()), 'system');
    assert.equal(readThemeChoice(fakeStorage({ [THEME_STORAGE_KEY]: 'neon' })), 'system');
    assert.equal(readThemeChoice(undefined), 'system');
  });

  it('survives a browser that refuses storage, as in a private window', () => {
    assert.equal(readThemeChoice(fakeStorage({}, { throwOnRead: true })), 'system');
    assert.doesNotThrow(() => writeThemeChoice(fakeStorage({}, { throwOnWrite: true }), 'dark'));
  });

  it('recognizes only the three real choices', () => {
    for (const value of ['system', 'light', 'dark']) assert.equal(isThemeChoice(value), true, value);
    for (const value of ['Dark', '', null, undefined, 42, {}]) assert.equal(isThemeChoice(value), false, String(value));
  });
});

describe('applyThemeAttribute', () => {
  it('pins an explicit theme and hands control back to the system otherwise', () => {
    const calls: string[] = [];
    const root = {
      setAttribute: (name: string, value: string) => calls.push(`set ${name}=${value}`),
      removeAttribute: (name: string) => calls.push(`remove ${name}`),
    };

    applyThemeAttribute(root, 'dark');
    applyThemeAttribute(root, 'light');
    applyThemeAttribute(root, 'system');
    assert.deepEqual(calls, ['set data-theme=dark', 'set data-theme=light', 'remove data-theme']);
  });
});

describe('themeControlLabel', () => {
  it('says which theme is active and what pressing it does', () => {
    assert.deepEqual(themeControlLabel('system', 'dark'), {
      label: 'System',
      accessibleLabel: 'Theme: System (dark). Change to always light.',
    });
    assert.deepEqual(themeControlLabel('light', 'light'), { label: 'Light', accessibleLabel: 'Theme: Light. Change to always dark.' });
    assert.deepEqual(themeControlLabel('dark', 'dark'), { label: 'Dark', accessibleLabel: 'Theme: Dark. Change to match your system.' });
  });

  it('never describes a change as a no-op when the system already shows that theme', () => {
    const { accessibleLabel } = themeControlLabel('system', 'light');
    assert.equal(accessibleLabel, 'Theme: System (light). Change to always light.');
  });

  it('never leaves the state to the icon alone', () => {
    for (const choice of ['system', 'light', 'dark'] as const) {
      const { label, accessibleLabel } = themeControlLabel(choice, 'light');
      assert.ok(label.length > 0 && accessibleLabel.includes('Theme:'), choice);
    }
  });
});
