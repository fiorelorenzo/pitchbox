import { createGateway } from '@ai-sdk/gateway';

// The Gateway's own model list, so the admin form offers what can actually be
// picked instead of a free-text box where a typo becomes a failed run for every
// tenant (#411). Measured 2026-09-08: 345 models, each with an id and per-token
// pricing.
//
// Everything here degrades rather than throws. A deployment with no Gateway key
// (every self-host install today) has no catalogue and must still be able to
// read and save the configuration, so a failure returns an empty list plus the
// reason, and the form falls back to accepting an id typed by hand.

export interface GatewayModel {
  id: string;
  name: string;
  /** USD per input token, as the Gateway reports it. Null when it does not. */
  inputPerToken: number | null;
  outputPerToken: number | null;
}

export interface GatewayCatalogue {
  models: GatewayModel[];
  /** Null when the list is real; a sentence to show the operator when it is not. */
  unavailable: string | null;
  fetchedAt: Date;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
let cache: { value: GatewayCatalogue; expiresAt: number } | null = null;

export function clearGatewayCatalogueCache(): void {
  cache = null;
}

function num(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // The Gateway reports pricing as decimal strings ("0.00000012"), which is
  // deliberate on their side: these are small enough that a float printed back
  // would read as noise.
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function pricingOf(model: unknown): { input: unknown; output: unknown } {
  if (!model || typeof model !== 'object' || !('pricing' in model))
    return { input: null, output: null };
  const pricing = model.pricing;
  if (!pricing || typeof pricing !== 'object') return { input: null, output: null };
  return {
    input: 'input' in pricing ? pricing.input : null,
    output: 'output' in pricing ? pricing.output : null,
  };
}

export async function loadGatewayCatalogue(
  opts: { apiKey?: string | null; force?: boolean } = {},
): Promise<GatewayCatalogue> {
  const now = Date.now();
  if (!opts.force && cache && cache.expiresAt > now) return cache.value;

  const apiKey = opts.apiKey ?? process.env.AI_GATEWAY_API_KEY ?? null;
  if (!apiKey) {
    return {
      models: [],
      unavailable:
        'No AI Gateway key is configured on this deployment, so the model list cannot be fetched. Type a model id to set one anyway.',
      fetchedAt: new Date(),
    };
  }

  try {
    const gateway = createGateway({ apiKey });
    const response = await gateway.getAvailableModels();
    const models: GatewayModel[] = response.models
      .map((m) => {
        const pricing = pricingOf(m);
        return {
          id: m.id,
          name: m.name ?? m.id,
          inputPerToken: num(pricing.input),
          outputPerToken: num(pricing.output),
        };
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    const value: GatewayCatalogue = { models, unavailable: null, fetchedAt: new Date() };
    cache = { value, expiresAt: now + CACHE_TTL_MS };
    return value;
  } catch (err) {
    // Not cached: a transient Gateway failure should not blank the form for the
    // next ten minutes.
    return {
      models: [],
      unavailable: `The AI Gateway model list could not be read: ${
        err instanceof Error ? err.message : String(err)
      }`,
      fetchedAt: new Date(),
    };
  }
}
