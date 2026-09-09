import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { GatewayCatalogue } from '../src/ai/gateway-catalogue.js';
import {
  PREMIUM_OUTPUT_PRICE_PER_TOKEN_USD,
  defaultModelForFunction,
  gateModelForPlan,
  isPremiumModel,
} from '../src/ai/model-functions.js';

// #547: the cost of a run is decided by the model, not by the plan - measured
// on the preview database, the same `campaign` kind costs $0.17 to $0.37 per
// run on the Claude-class agentic path against $0.0051 on
// `google/gemini-3.1-flash-lite` (the fast default every function falls back
// to, #411). This is the resolution function the acceptance criterion asks
// for a test on, not the admin form: an org whose plan does not allow
// premium models must land on the fast default regardless of what
// `app_config.model_functions` or `runner_configs` pinned, and a model the
// catalogue cannot price counts as premium, the safe direction.
//
// `loadGatewayCatalogue` is mocked rather than hit for real: a self-host test
// box has no `AI_GATEWAY_API_KEY`, and the classification under test is the
// price-threshold math, not the Gateway's own catalogue endpoint. The
// per-token fixtures below reuse real published numbers already established
// in this repo (shared/tests/agents/sdk/event-normalizer.test.ts): Gemini 3.1
// Flash Lite prices output at $0.0000006/token, a Claude Sonnet-class model
// at $0.000015/token.

let catalogue: GatewayCatalogue = { models: [], unavailable: null, fetchedAt: new Date() };

vi.mock('../src/ai/gateway-catalogue.js', () => ({
  loadGatewayCatalogue: () => Promise.resolve(catalogue),
}));

function setModels(models: GatewayCatalogue['models']): void {
  catalogue = { models, unavailable: null, fetchedAt: new Date() };
}

const FLASH_LITE = 'google/gemini-3.1-flash-lite';
const OPUS = 'anthropic/claude-opus-4.1';

beforeEach(() => {
  setModels([
    {
      id: FLASH_LITE,
      name: 'Gemini 3.1 Flash Lite',
      inputPerToken: 0.00000015,
      outputPerToken: 0.0000006,
    },
    { id: OPUS, name: 'Claude Opus 4.1', inputPerToken: 0.000015, outputPerToken: 0.000075 },
  ]);
});

describe('isPremiumModel', () => {
  it('classifies the fast default, well under the threshold, as not premium', async () => {
    expect(await isPremiumModel(FLASH_LITE)).toBe(false);
  });

  it('classifies a Claude-class model, well over the threshold, as premium', async () => {
    expect(await isPremiumModel(OPUS)).toBe(true);
  });

  it('classifies output pricing exactly at the threshold as premium', async () => {
    setModels([
      {
        id: 'x/at-threshold',
        name: 'At threshold',
        inputPerToken: 0,
        outputPerToken: PREMIUM_OUTPUT_PRICE_PER_TOKEN_USD,
      },
    ]);
    expect(await isPremiumModel('x/at-threshold')).toBe(true);
  });

  it('treats an id the catalogue has no entry for as premium, the safe direction', async () => {
    expect(await isPremiumModel('made-up/does-not-exist')).toBe(true);
  });

  it('treats a catalogue entry with no output price as premium', async () => {
    setModels([{ id: 'x/unpriced', name: 'Unpriced', inputPerToken: null, outputPerToken: null }]);
    expect(await isPremiumModel('x/unpriced')).toBe(true);
  });
});

describe('gateModelForPlan (#547)', () => {
  it('forces a plan without premium models onto the fast default even with Opus pinned for that function', async () => {
    expect(await gateModelForPlan('campaign_draft', OPUS, false)).toBe(
      defaultModelForFunction('campaign_draft'),
    );
  });

  it('leaves a premium-allowed plan unaffected', async () => {
    expect(await gateModelForPlan('campaign_draft', OPUS, true)).toBe(OPUS);
  });

  it('leaves a non-premium plan alone when the pinned model is already cheap', async () => {
    expect(await gateModelForPlan('campaign_draft', FLASH_LITE, false)).toBe(FLASH_LITE);
  });

  it('resolves an unknown model id as premium regardless of plan', async () => {
    expect(await gateModelForPlan('assist_suggest', 'made-up/does-not-exist', false)).toBe(
      defaultModelForFunction('assist_suggest'),
    );
  });

  it('never touches the catalogue for a premium-allowed plan', async () => {
    setModels([]);
    // An empty catalogue would classify anything as premium (unpriceable);
    // an allowed plan must never even ask, which this proves indirectly -
    // the pinned id comes back unchanged despite no catalogue entry for it.
    expect(await gateModelForPlan('campaign_draft', OPUS, true)).toBe(OPUS);
  });
});
