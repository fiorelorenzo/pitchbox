import { z } from 'zod';
import type { ScenarioSlug } from './scenarios.js';
import { SCENARIO_SCHEMAS } from './scenario-schemas.js';

function describeType(z0: z.ZodTypeAny, path: string, lines: string[]): void {
  const def = z0._def;
  if (def.typeName === 'ZodObject') {
    for (const [key, child] of Object.entries((z0 as z.ZodObject<z.ZodRawShape>).shape)) {
      describeType(child as z.ZodTypeAny, path ? `${path}.${key}` : key, lines);
    }
    return;
  }
  if (def.typeName === 'ZodArray') {
    const inner = (z0 as z.ZodArray<z.ZodTypeAny>).element;
    const innerDesc =
      inner._def.typeName === 'ZodString'
        ? 'string'
        : inner._def.typeName.replace(/^Zod/, '').toLowerCase();
    lines.push(`- ${path}: array of ${innerDesc}`);
    return;
  }
  if (def.typeName === 'ZodEnum') {
    const values = (z0 as z.ZodEnum<[string, ...string[]]>).options.map((v) => `"${v}"`).join(', ');
    lines.push(`- ${path}: one of ${values}`);
    return;
  }
  if (def.typeName === 'ZodNumber') {
    lines.push(`- ${path}: integer (1-5)`);
    return;
  }
  if (def.typeName === 'ZodString') {
    lines.push(`- ${path}: string`);
    return;
  }
  lines.push(`- ${path}: ${def.typeName.replace(/^Zod/, '').toLowerCase()}`);
}

export function describeScenarioSchema(slug: ScenarioSlug): string {
  const schema = SCENARIO_SCHEMAS[slug];
  const lines: string[] = [];
  lines.push('## Profile fields (must be filled exactly with this structure)');
  lines.push('');
  describeType(schema as z.ZodTypeAny, '', lines);
  return lines.join('\n');
}
