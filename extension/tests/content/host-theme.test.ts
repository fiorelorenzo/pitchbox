// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  backgroundLuminance,
  detectHostTheme,
  observeHostTheme,
} from '../../src/content/shared/host-theme.js';

/**
 * Which ground the in-page panel decides it is standing on (LOR-211).
 *
 * The rule this defends is that the answer comes from a rendered colour and
 * never from a LinkedIn class name, so every case here paints a background
 * and asserts on that: a page could rename its theme marker tomorrow and
 * none of this would change.
 */

function paint(el: HTMLElement | null, color: string): void {
  el?.setAttribute('style', `background-color: ${color}`);
}

const cleanups: Array<() => void> = [];

beforeEach(() => {
  paint(document.body, 'transparent');
  paint(document.documentElement, 'transparent');
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()?.();
  vi.unstubAllGlobals();
});

describe('backgroundLuminance', () => {
  it('reads both the legacy and the space-separated rgb syntaxes', () => {
    // LinkedIn's light feed, #f4f2ee.
    expect(backgroundLuminance('rgb(244, 242, 238)')).toBeCloseTo(0.888, 2);
    expect(backgroundLuminance('rgb(244 242 238)')).toBeCloseTo(0.888, 2);
    // Its dark one, #1b1f23.
    expect(backgroundLuminance('rgba(27, 31, 35, 1)')).toBeCloseTo(0.015, 2);
  });

  it('treats a fully transparent background as saying nothing', () => {
    // The trap this exists for: every unpainted element computes to
    // `rgba(0, 0, 0, 0)`, and reading that as black is how a light page ends
    // up wearing a dark panel.
    expect(backgroundLuminance('rgba(0, 0, 0, 0)')).toBeNull();
    expect(backgroundLuminance('rgb(0 0 0 / 0)')).toBeNull();
  });

  it('returns null for a syntax it does not parse rather than guessing', () => {
    expect(backgroundLuminance('oklch(0.145 0 0)')).toBeNull();
    expect(backgroundLuminance('')).toBeNull();
  });
});

describe('detectHostTheme', () => {
  it('takes the theme from the ground the page paints', () => {
    paint(document.body, 'rgb(27, 31, 35)');
    expect(detectHostTheme()).toBe('dark');

    paint(document.body, 'rgb(244, 242, 238)');
    expect(detectHostTheme()).toBe('light');
  });

  it('walks past a transparent body to the element that does paint', () => {
    paint(document.documentElement, 'rgb(18, 18, 18)');
    expect(detectHostTheme()).toBe('dark');
  });

  it('falls back to the OS preference only when nothing paints at all', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    expect(detectHostTheme()).toBe('dark');
  });
});

describe('observeHostTheme', () => {
  it('reports a theme flip that happens with the panel already open', async () => {
    paint(document.body, 'rgb(244, 242, 238)');
    const seen: string[] = [];
    cleanups.push(observeHostTheme((theme) => seen.push(theme)));
    expect(seen).toEqual([]);

    paint(document.body, 'rgb(27, 31, 35)');
    await vi.waitFor(() => expect(seen).toEqual(['dark']));

    paint(document.body, 'rgb(244, 242, 238)');
    await vi.waitFor(() => expect(seen).toEqual(['dark', 'light']));
  });

  it('stays quiet when an attribute changes without changing the ground', async () => {
    paint(document.body, 'rgb(244, 242, 238)');
    const seen: string[] = [];
    cleanups.push(observeHostTheme((theme) => seen.push(theme)));

    document.body.className = 'theme--light feed-page';
    document.documentElement.setAttribute('data-theme', 'light');
    // Nothing to wait for: assert after the microtask an observer would use.
    await Promise.resolve();
    expect(seen).toEqual([]);
  });

  it('stops reporting once unsubscribed', async () => {
    paint(document.body, 'rgb(244, 242, 238)');
    const seen: string[] = [];
    observeHostTheme((theme) => seen.push(theme))();

    paint(document.body, 'rgb(27, 31, 35)');
    await Promise.resolve();
    expect(seen).toEqual([]);
  });
});
