// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  installTrustedTypesFallback,
  type PolicyFactoryLike,
} from '../../src/content/shared/trusted-types-shim.js';

/**
 * #379: linkedin.com ships a `trusted-types` CSP allowlist. A content script
 * is exempt from the page's CSP for DOM sinks, but Chrome still applies the
 * policy-name allowlist to `createPolicy` in the isolated world, so Svelte's
 * own `createPolicy('svelte-trusted-html')` throws while the module graph is
 * evaluating and the whole panel script dies before mounting - measured on a
 * real signed-in post page, where the only trace was one uncaught exception.
 *
 * The fallback has to leave an accepted policy alone (never hand back a fake
 * when the real one works) and only stand in when the name is refused.
 */

function refusingFactory(): PolicyFactoryLike {
  return {
    createPolicy: (name) => {
      throw new TypeError(`Policy "${name}" disallowed.`);
    },
  };
}

describe('installTrustedTypesFallback', () => {
  it('falls back to an identity policy when the page refuses the policy name', () => {
    const factory = refusingFactory();
    installTrustedTypesFallback(factory);

    const policy = factory.createPolicy('svelte-trusted-html', { createHTML: (s) => s });
    expect(policy.name).toBe('svelte-trusted-html');
    expect(policy.createHTML('<b>x</b>')).toBe('<b>x</b>');
  });

  it('returns the real policy untouched when the page allows it', () => {
    const real = {
      name: 'real-policy',
      createHTML: (s: string) => s,
      createScript: (s: string) => s,
      createScriptURL: (s: string) => s,
    };
    const factory: PolicyFactoryLike = { createPolicy: () => real };
    installTrustedTypesFallback(factory);

    expect(factory.createPolicy('svelte-trusted-html')).toBe(real);
  });

  it("honours the caller's own createHTML in the fallback rather than dropping it", () => {
    const factory = refusingFactory();
    installTrustedTypesFallback(factory);

    const policy = factory.createPolicy('svelte-trusted-html', {
      createHTML: (s) => `wrapped:${s}`,
    });
    expect(policy.createHTML('x')).toBe('wrapped:x');
  });

  it('does nothing when the environment has no Trusted Types at all', () => {
    expect(() => installTrustedTypesFallback(undefined)).not.toThrow();
  });
});
