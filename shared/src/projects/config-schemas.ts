import { z } from 'zod';

export const productPitchSchema = z.object({ text: z.string().min(1) });
export const productUrlSchema = z.object({ url: z.string().url() });
export const productDefaultAccountRoleSchema = z.object({
  role: z.enum(['personal', 'brand']),
});
export const productSelfPromoPolicySchema = z.object({
  default: z.enum(['never', 'allowed', 'on_request']),
});
export const productDisclosurePolicySchema = z.object({ default: z.string() });

export const offerSchema = z.object({
  name: z.string().min(1),
  cta: z.string().min(1),
  composeSubject: z.string().min(1),
  url: z.string().url().optional(),
});

export const voiceDmRulesSchema = z.object({
  hardBans: z.array(z.string()),
  dos: z.array(z.string()),
  disclosure: z.string(),
  examples: z.array(z.string()),
});

export const voicePostRulesSchema = z.object({
  hardBans: z.array(z.string()),
  dos: z.array(z.string()),
  lengthRange: z
    .tuple([z.number().int().min(0), z.number().int().min(0)])
    .refine(([min, max]) => max >= min, {
      message: 'lengthRange max must be >= min',
    }),
});

export const topicAnglesSchema = z.array(z.string());

export const CONFIG_SCHEMAS = {
  'product.pitch': productPitchSchema,
  'product.url': productUrlSchema,
  'product.defaultAccountRole': productDefaultAccountRoleSchema,
  'product.selfPromoPolicy': productSelfPromoPolicySchema,
  'product.disclosurePolicy': productDisclosurePolicySchema,
  offer: offerSchema,
  'voice.dm_rules': voiceDmRulesSchema,
  'voice.post_rules': voicePostRulesSchema,
  topicAngles: topicAnglesSchema,
} as const satisfies Record<string, z.ZodTypeAny>;

export type KnownConfigKey = keyof typeof CONFIG_SCHEMAS;

export function isKnownConfigKey(key: string): key is KnownConfigKey {
  return Object.prototype.hasOwnProperty.call(CONFIG_SCHEMAS, key);
}

function assertJsonSafe(value: unknown, path: string, seen: WeakSet<object>): void {
  if (value === null) return;
  const t = typeof value;
  if (t === 'string' || t === 'boolean') return;
  if (t === 'number') {
    if (!Number.isFinite(value as number)) {
      throw new Error(`Config value at ${path} is not JSON-safe: ${value}`);
    }
    return;
  }
  if (t === 'undefined' || t === 'function' || t === 'symbol' || t === 'bigint') {
    throw new Error(`Config value at ${path} has unsupported type: ${t}`);
  }
  if (t !== 'object') {
    throw new Error(`Config value at ${path} has unsupported type: ${t}`);
  }
  const obj = value as object;
  if (seen.has(obj)) {
    throw new Error(`Config value at ${path} contains a circular reference`);
  }
  seen.add(obj);
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => assertJsonSafe(v, `${path}[${i}]`, seen));
    return;
  }
  // Plain object only: reject Date, Map, Set, RegExp, etc.
  const proto = Object.getPrototypeOf(obj);
  if (proto !== Object.prototype && proto !== null) {
    throw new Error(
      `Config value at ${path} is not a plain object (got ${proto?.constructor?.name ?? 'unknown'})`,
    );
  }
  for (const [k, v] of Object.entries(obj)) {
    assertJsonSafe(v, `${path}.${k}`, seen);
  }
}

// Validates the value against a known schema if any, otherwise enforces JSON-serializability.
export function parseConfigValue(key: string, value: unknown): unknown {
  if (isKnownConfigKey(key)) return CONFIG_SCHEMAS[key].parse(value);
  assertJsonSafe(value, `<${key}>`, new WeakSet());
  return value;
}
