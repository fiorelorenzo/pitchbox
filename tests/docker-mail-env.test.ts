import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `docker-compose.app.yml` enumerates the container's environment rather than
 * passing the whole `.env` through, so a variable the code reads but the
 * compose file does not list simply never reaches the process - and the
 * failure is silent, because `loadMailEnv` falls back to the null transport,
 * which logs and drops. That is not hypothetical: on 2026-09-09 prod held a
 * real Resend key in `/opt/apps/pitchbox/.env` and sent nothing, because none
 * of the mail variables were in this file.
 *
 * So this reads the variables `shared/src/mail/env.ts` actually looks up and
 * asserts the web service passes each one through from the deployment
 * environment. It fails when somebody adds a mail variable to the loader and
 * forgets the deployment. No YAML parser on purpose: this repo has none, and
 * the shape being checked is one line per variable.
 */
const root = join(import.meta.dirname, '..');

function mailEnvVarsReadByTheLoader(): string[] {
  const src = readFileSync(join(root, 'shared/src/mail/env.ts'), 'utf8');
  const names = new Set<string>();
  for (const m of src.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1]);
  return [...names].sort();
}

/** The `web:` service's own block, cut at the next service at the same indent. */
function webServiceBlock(): string {
  const src = readFileSync(join(root, 'docker-compose.app.yml'), 'utf8');
  const start = src.indexOf('\n  web:\n');
  if (start < 0) throw new Error('docker-compose.app.yml has no web service');
  const rest = src.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}\w[\w-]*:\n/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

describe('the deployed app receives the mail configuration it reads', () => {
  it('finds the variables to check, rather than passing on an empty set', () => {
    const vars = mailEnvVarsReadByTheLoader();
    expect(vars).toContain('MAIL_PROVIDER');
    expect(vars).toContain('RESEND_API_KEY');
    expect(vars.length).toBeGreaterThan(4);
  });

  it.each(mailEnvVarsReadByTheLoader())(
    'passes %s into the web container, interpolated from the deployment environment',
    (name) => {
      expect(webServiceBlock()).toMatch(new RegExp(`^\\s+${name}: \\$\\{${name}(:-[^}]*)?\\}$`, 'm'));
    },
  );
});
