import { describe, expect, it } from 'vitest';
import { TRUSTED_ORIGINS } from '../svelte.config.js';

/**
 * #424: the app moved off the apex to app.pitchbox.app. adapter-node's
 * ORIGIN env var (PUBLIC_WEB_ORIGIN) decides the one origin SvelteKit's
 * cross-site form-submission check trusts by default; a stale value during
 * the manual DNS/env cutover turns every mutation into a 403 with nothing
 * pointing at ORIGIN as the cause. `trustedOrigins` is the allowlist that
 * closes that gap regardless of which manual step lands first, and it has
 * to carry both hosts for that to hold.
 */
describe('csrf.trustedOrigins', () => {
  it('trusts the new app host', () => {
    expect(TRUSTED_ORIGINS).toContain('https://app.pitchbox.app');
  });

  it('still trusts the apex during the transition', () => {
    expect(TRUSTED_ORIGINS).toContain('https://pitchbox.app');
    expect(TRUSTED_ORIGINS).toContain('https://www.pitchbox.app');
  });
});
