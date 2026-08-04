import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Every playbook carries the same verbatim "House style" section: the rules that
// keep drafted outreach reading like a person wrote it. The section is duplicated
// on purpose (a playbook body is shipped standalone - seeded into `playbooks.body`
// and handed to the agent as the whole prompt, with no include mechanism), so the
// only thing keeping the 13 copies from drifting is this test.
const PLAYBOOKS_DIR = fileURLToPath(new URL('../../playbooks', import.meta.url));
const HEADING = '## House style: write like a human';

// Typographic AI tells. The section bans them in drafted text; banning them in the
// playbook source too means the prompt never shows the agent an example to imitate.
const BANNED_CHARS: Array<[string, string]> = [
  ['\u2014', 'em dash'],
  ['\u2013', 'en dash'],
  ['\u2018', 'curly opening apostrophe'],
  ['\u2019', 'curly apostrophe'],
  ['\u201c', 'curly opening quote'],
  ['\u201d', 'curly closing quote'],
  ['\u2026', 'single-character ellipsis'],
  ['\u00a0', 'non-breaking space'],
];

function houseStyleSection(body: string): string {
  const start = body.indexOf(HEADING);
  if (start === -1) return '';
  const rest = body.slice(start + HEADING.length);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
}

const files = readdirSync(PLAYBOOKS_DIR)
  .filter((f) => f.endsWith('.md'))
  .sort();
const bodies = new Map(files.map((f) => [f, readFileSync(join(PLAYBOOKS_DIR, f), 'utf8')]));

describe('playbooks house style', () => {
  it('finds the playbook corpus', () => {
    expect(files.length).toBeGreaterThanOrEqual(13);
  });

  it.each(files)('%s carries the House style section', (file) => {
    expect(bodies.get(file)).toContain(HEADING);
  });

  it('keeps the section byte-identical across every playbook', () => {
    const reference = houseStyleSection(bodies.get(files[0]!)!);
    expect(reference.length).toBeGreaterThan(500);
    for (const file of files) {
      expect(houseStyleSection(bodies.get(file)!), `${file} diverged from ${files[0]}`).toBe(
        reference,
      );
    }
  });

  it('states the rule outranks campaign config', () => {
    const reference = houseStyleSection(bodies.get(files[0]!)!);
    expect(reference).toMatch(/campaign config can only tighten these rules, never relax them/);
  });

  it.each(files)('%s contains no AI typography', (file) => {
    const body = bodies.get(file)!;
    for (const [char, name] of BANNED_CHARS) {
      const at = body.indexOf(char);
      const line = at === -1 ? 0 : body.slice(0, at).split('\n').length;
      expect(at, `${file}:${line} contains ${name}`).toBe(-1);
    }
  });
});
