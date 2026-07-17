import { z } from 'zod';
import type { ScenarioSlug } from './scenarios.js';
import { SCENARIO_SCHEMAS } from './scenario-schemas.js';

// zod v4 dropped `_def.typeName` (e.g. 'ZodObject'); the schema kind now lives on
// `_def.type` as a lowercase discriminator ('object', 'array', 'enum', ...). We
// read the schema structurally because v4's public generics changed shape.
type ZodKindDef = { _def: { type: string } };
const kindOf = (z0: z.ZodType): string => (z0 as unknown as ZodKindDef)._def.type;

function describeType(z0: z.ZodType, path: string, lines: string[]): void {
  const type = kindOf(z0);
  if (type === 'object') {
    const shape = (z0 as unknown as { shape: Record<string, z.ZodType> }).shape;
    for (const [key, child] of Object.entries(shape)) {
      describeType(child, path ? `${path}.${key}` : key, lines);
    }
    return;
  }
  if (type === 'array') {
    const inner = (z0 as unknown as { element: z.ZodType }).element;
    lines.push(`- ${path}: array of ${kindOf(inner)}`);
    return;
  }
  if (type === 'enum') {
    const options = (z0 as unknown as { options: readonly string[] }).options;
    const values = options.map((v) => `"${v}"`).join(', ');
    lines.push(`- ${path}: one of ${values}`);
    return;
  }
  if (type === 'number') {
    lines.push(`- ${path}: integer (1-5)`);
    return;
  }
  if (type === 'string') {
    lines.push(`- ${path}: string`);
    return;
  }
  lines.push(`- ${path}: ${type}`);
}

export function describeScenarioSchema(slug: ScenarioSlug): string {
  const schema = (SCENARIO_SCHEMAS as Record<string, z.ZodType | undefined>)[slug];
  if (!schema) {
    // No structured schema registered for this scenario yet (e.g. mastodon-*) -
    // fall back to a freeform instruction instead of crashing on an undefined
    // schema (see getSchema's doc comment for the same "accepted as-is" stance).
    return 'No structured profile schema is registered for this scenario yet. Produce a single flat JSON object capturing the fields implied by the objective (voice, targeting, offer, etc).';
  }
  const lines: string[] = [];
  lines.push('## Profile fields (must be filled exactly with this structure)');
  lines.push('');
  describeType(schema, '', lines);
  return lines.join('\n');
}
