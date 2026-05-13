// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest';

let mqlListeners: Array<(e: { matches: boolean }) => void> = [];
let mqlMatches = false;

beforeEach(() => {
  document.documentElement.className = '';
  mqlListeners = [];
  mqlMatches = false;
  (window as any).matchMedia = vi.fn().mockImplementation((_q: string) => ({
    matches: mqlMatches,
    addEventListener: (_t: string, fn: (e: { matches: boolean }) => void) => mqlListeners.push(fn),
    removeEventListener: (_t: string, fn: (e: { matches: boolean }) => void) => {
      mqlListeners = mqlListeners.filter((l) => l !== fn);
    },
  }));
});

describe('theme', () => {
  it("adds .dark when mode is 'dark'", async () => {
    const { applyTheme } = await import('../../src/lib/theme.js');
    applyTheme('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });

  it("removes .dark when mode is 'light'", async () => {
    const { applyTheme } = await import('../../src/lib/theme.js');
    document.documentElement.classList.add('dark');
    applyTheme('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it("'system' follows prefers-color-scheme and reacts to changes", async () => {
    const { applyTheme } = await import('../../src/lib/theme.js');
    mqlMatches = true;
    applyTheme('system');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    // Simulate OS switching to light.
    mqlListeners.forEach((fn) => fn({ matches: false }));
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('detaches old system listener when switching mode', async () => {
    const { applyTheme } = await import('../../src/lib/theme.js');
    applyTheme('system');
    const before = mqlListeners.length;
    applyTheme('dark');
    expect(mqlListeners.length).toBe(before - 1);
  });
});
