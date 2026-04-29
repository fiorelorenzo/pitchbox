export const SCAFFOLD_SECTIONS = [
  'Product',
  'Target audience',
  'Voice & tone',
  'Offer',
  'Key features',
  'Links',
] as const;

export type ScaffoldSection = (typeof SCAFFOLD_SECTIONS)[number];

export const DESCRIPTION_SCAFFOLD: string = SCAFFOLD_SECTIONS.map((s) => `## ${s}\n\n…\n`).join(
  '\n',
);
