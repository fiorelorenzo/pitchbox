// A thin REST client over the Stripe API, mirroring `scripts/stripe-setup.ts`'s
// own `stripe()`/`form()` helpers rather than adding the `stripe` npm package as
// a dependency: the whole surface the app needs (create a customer, start a
// Checkout session, start a portal session, read a subscription/product back)
// is a handful of endpoints, and the setup script already proved this shape
// works against the real API, including the Managed Payments quirks. Every
// call is pinned to `STRIPE_API_VERSION` via the `Stripe-Version` header, so
// the response shape this file's types describe cannot drift under it.
import { z } from 'zod';
import { STRIPE_API_VERSION } from './env.js';

export type StripeMetadata = Record<string, string>;

export type StripeCustomer = {
  id: string;
  email: string | null;
  metadata: StripeMetadata;
  deleted?: boolean;
};

export type StripeCheckoutSession = {
  id: string;
  url: string | null;
  mode: string;
  customer: string | null;
  client_reference_id: string | null;
  subscription: string | null;
};

export type StripePortalSession = {
  id: string;
  url: string;
};

export type StripeSubscriptionItem = {
  id: string;
  price: StripePrice;
  current_period_start: number;
  current_period_end: number;
};

export type StripeSubscription = {
  id: string;
  customer: string;
  status:
    | 'trialing'
    | 'active'
    | 'past_due'
    | 'canceled'
    | 'incomplete'
    | 'incomplete_expired'
    | 'unpaid'
    | 'paused';
  cancel_at_period_end: boolean;
  metadata: StripeMetadata;
  items: { data: StripeSubscriptionItem[] };
};

export type StripePrice = {
  id: string;
  lookup_key: string | null;
  product: string | StripeProduct;
};

export type StripeProduct = {
  id: string;
  metadata: StripeMetadata;
};

export type StripeInvoice = {
  id: string;
  customer: string;
  subscription: string | null;
};

// The envelope Stripe posts to a webhook endpoint. `data.object` stays
// `z.unknown()` here on purpose: each handler in
// `shared/src/billing/webhook.ts` validates it against the event-specific
// schema its own event type actually carries, rather than this module
// trying to describe every object shape Stripe can ever deliver.
const StripeEventSchema = z.object({
  id: z.string(),
  type: z.string(),
  created: z.number(),
  data: z.object({ object: z.unknown() }),
});
export type StripeEvent = z.infer<typeof StripeEventSchema>;

export class InvalidStripeEventError extends Error {}

/** Parses the raw JSON body of a webhook delivery into a `StripeEvent`,
 * throwing `InvalidStripeEventError` if it does not even carry the fields
 * every Stripe event has. The caller (the webhook route) has already
 * verified the signature over these exact bytes before calling this - a
 * signed-but-malformed body is not something Stripe itself would ever
 * send, so this is a defensive last check, not the primary validation. */
export function parseStripeEvent(rawBody: string): StripeEvent {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    throw new InvalidStripeEventError('webhook body is not valid JSON');
  }
  const parsed = StripeEventSchema.safeParse(json);
  if (!parsed.success) {
    throw new InvalidStripeEventError(
      `webhook body is not a Stripe event: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

export class StripeApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly stripeType: string | undefined,
    public readonly stripeCode: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'StripeApiError';
  }
}

function form(value: unknown, prefix = '', out = new URLSearchParams()): URLSearchParams {
  if (value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    value.forEach((item, i) => form(item, `${prefix}[${i}]`, out));
    return out;
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      form(v, prefix ? `${prefix}[${k}]` : k, out);
    }
    return out;
  }
  out.append(prefix, String(value));
  return out;
}

export type StripeClient = {
  createCustomer(params: { email?: string; metadata?: StripeMetadata }): Promise<StripeCustomer>;
  getCustomer(id: string): Promise<StripeCustomer>;
  createCheckoutSession(params: Record<string, unknown>): Promise<StripeCheckoutSession>;
  createPortalSession(params: Record<string, unknown>): Promise<StripePortalSession>;
  getSubscription(id: string): Promise<StripeSubscription>;
  getProduct(id: string): Promise<StripeProduct>;
  getPriceByLookupKey(lookupKey: string): Promise<StripePrice | null>;
};

/** Builds a client bound to one secret key (test or live - the caller decides
 * which by which key `loadStripeEnv` handed it). No shared mutable state
 * between calls; safe to construct per-request. */
export function createStripeClient(secretKey: string): StripeClient {
  async function request<T>(path: string, body?: unknown, method?: string): Promise<T> {
    const verb = method ?? (body ? 'POST' : 'GET');
    const res = await fetch(`https://api.stripe.com/v1/${path}`, {
      method: verb,
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': STRIPE_API_VERSION,
      },
      body: body ? form(body) : undefined,
    });
    const payload: unknown = await res.json();
    if (!res.ok) {
      let message = `${verb} /v1/${path} -> ${res.status}`;
      let type: string | undefined;
      let code: string | undefined;
      if (payload && typeof payload === 'object' && 'error' in payload) {
        const err = payload.error;
        if (err && typeof err === 'object') {
          if ('message' in err && typeof err.message === 'string') {
            message = `${message} ${err.message}`;
          }
          if ('type' in err && typeof err.type === 'string') type = err.type;
          if ('code' in err && typeof err.code === 'string') code = err.code;
        }
      }
      throw new StripeApiError(res.status, type, code, message);
    }
    // Stripe's response shape is documented per endpoint, and each typed
    // method below names the fields it reads - a wrong shape surfaces
    // immediately as `undefined` rather than a runtime schema failure.
    return payload as T;
  }

  return {
    createCustomer(params) {
      return request('customers', params);
    },
    getCustomer(id) {
      return request(`customers/${id}`, undefined, 'GET');
    },
    createCheckoutSession(params) {
      return request('checkout/sessions', params);
    },
    createPortalSession(params) {
      return request('billing_portal/sessions', params);
    },
    getSubscription(id) {
      return request(`subscriptions/${id}?expand[]=items.data.price.product`, undefined, 'GET');
    },
    getProduct(id) {
      return request(`products/${id}`, undefined, 'GET');
    },
    async getPriceByLookupKey(lookupKey) {
      const list = await request<{ data: StripePrice[] }>(
        `prices?lookup_keys[]=${encodeURIComponent(lookupKey)}`,
        undefined,
        'GET',
      );
      return list.data[0] ?? null;
    },
  };
}
