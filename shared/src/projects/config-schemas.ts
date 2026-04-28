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

// Validates the value against a known schema if any, otherwise enforces JSON-serializability.
export function parseConfigValue(key: string, value: unknown): unknown {
  if (isKnownConfigKey(key)) return CONFIG_SCHEMAS[key].parse(value);
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error(`Config value for key "${key}" is not JSON-serializable`);
  }
  return JSON.parse(serialized);
}
