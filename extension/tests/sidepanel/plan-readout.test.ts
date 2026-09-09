// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mount, unmount } from 'svelte';
import PlanReadout from '../../src/sidepanel/components/PlanReadout.svelte';
import type { LinkedInAssistPlanState } from '../../src/lib/api.js';

/**
 * The plan and remaining-suggestion readout PairingList.svelte shows per
 * paired backend (#556), against the real compiled component - same
 * posture as `home-state-line.test.ts`: a missing dictionary entry or a
 * template branch that never renders both look like a working panel until
 * something reads the actual text. Its own component (not PairingList
 * itself) precisely so it can be mounted without that component's
 * pairing/permission/AlertDialog machinery, which needs a real profile to
 * exercise meaningfully anyway (#400's own acceptance).
 */

let host: HTMLElement;
let component: Record<string, unknown> | null = null;

beforeEach(() => {
  document.body.innerHTML = '';
  host = document.createElement('div');
  document.body.append(host);
});

afterEach(() => {
  if (component) unmount(component);
  component = null;
  document.body.innerHTML = '';
});

function plan(over: Partial<LinkedInAssistPlanState> = {}): LinkedInAssistPlanState {
  return {
    id: 'growth',
    name: 'Growth',
    suggestionsUsed: 10,
    suggestionsLimit: 50,
    suggestionsRemaining: 40,
    readOnly: false,
    ...over,
  };
}

function render(planState: LinkedInAssistPlanState): string {
  component = mount(PlanReadout, {
    target: host,
    props: { plan: planState },
  }) as Record<string, unknown>;
  return (host.textContent ?? '').replace(/\s+/g, ' ').trim();
}

describe('the plan readout (#556)', () => {
  it('reads as fine with plenty of the allowance left', () => {
    const text = render(
      plan({ suggestionsUsed: 10, suggestionsLimit: 50, suggestionsRemaining: 40 }),
    );

    expect(text).toBe('Growth plan: 40 of 50 suggestions left this period');
  });

  it('reads as near the limit once the 80%-used warning threshold is crossed', () => {
    const text = render(
      plan({ suggestionsUsed: 46, suggestionsLimit: 50, suggestionsRemaining: 4 }),
    );

    expect(text).toBe('Growth plan: only 4 of 50 suggestions left this period');
  });

  it('reads as read-only once a failed payment has gone past its grace window', () => {
    const text = render(
      plan({ readOnly: true, suggestionsUsed: 50, suggestionsLimit: 50, suggestionsRemaining: 0 }),
    );

    expect(text).toBe('Growth plan: read-only until the payment issue is fixed');
  });

  it('names the plan as unlimited rather than a fraction when self-host resolves no ceiling', () => {
    const text = render(plan({ suggestionsLimit: null, suggestionsRemaining: null }));

    expect(text).toBe('Growth plan: unlimited suggestions');
  });

  it('read-only wins over a low-remaining count - one message, not two contradicting ones', () => {
    const text = render(
      plan({ readOnly: true, suggestionsUsed: 46, suggestionsLimit: 50, suggestionsRemaining: 4 }),
    );

    expect(text).toBe('Growth plan: read-only until the payment issue is fixed');
    expect(text).not.toMatch(/only 4/);
  });
});
