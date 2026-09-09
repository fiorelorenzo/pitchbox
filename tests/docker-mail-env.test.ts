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

function envVarsReadBy(loaderPath: string): string[] {
  const src = readFileSync(join(root, loaderPath), 'utf8');
  const names = new Set<string>();
  for (const m of src.matchAll(/\benv\.([A-Z][A-Z0-9_]*)/g)) names.add(m[1]);
  return [...names].sort();
}

function mailEnvVarsReadByTheLoader(): string[] {
  return envVarsReadBy('shared/src/mail/env.ts');
}

/** The optional GitHub App's credential (#390), read the same way and with
 * the same failure shape: a variable the loader reads and the compose files
 * do not pass produces a deployment that reads repositories anonymously while
 * its `.env` holds a perfectly good key. `loadGithubAppEnv` throws on a
 * partial configuration, so a missing one here is worse than silent - it
 * takes the route down - which is another reason to check it in CI rather
 * than in production. */
function githubAppEnvVarsReadByTheLoader(): string[] {
  return envVarsReadBy('shared/src/github-app.ts');
}

/** Hosted billing's own configuration (#549, #551), which fails in the same
 * silent shape as mail: `loadStripeEnv` collapses to `{ enabled: false }` and
 * every billing route answers 404 `billing_disabled`, so a deployment holding
 * a real live key looks configured and sells nothing. Measured on prod
 * 2026-09-10: the four variables were in `/opt/apps/pitchbox/.env` and in
 * neither compose file. */
function stripeEnvVarsReadByTheLoader(): string[] {
  return envVarsReadBy('shared/src/stripe/env.ts');
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

/** The blue-green overlay's `x-web-common` anchor, which is what a deployed
 * web container actually gets: that overlay disables the base `web` service
 * and replaces its whole `environment` block, so a variable present only in
 * the base file reaches nothing in production. Not theory: #579 added these
 * to the base file alone, shipped, and prod's active web came up with no
 * MAIL_PROVIDER (#580). */
function blueGreenCommonBlock(): string {
  const src = readFileSync(join(root, 'docker-compose.bluegreen.yml'), 'utf8');
  const start = src.indexOf('x-web-common:');
  if (start < 0) throw new Error('docker-compose.bluegreen.yml has no x-web-common anchor');
  const rest = src.slice(start);
  const next = rest.search(/\nservices:\n/);
  return next < 0 ? rest : rest.slice(0, next);
}

describe('the deployed app receives the GitHub App credential it reads', () => {
  it('finds the variables to check, rather than passing on an empty set', () => {
    expect(githubAppEnvVarsReadByTheLoader()).toEqual([
      'GITHUB_APP_ID',
      'GITHUB_APP_PRIVATE_KEY_B64',
      'GITHUB_APP_SLUG',
    ]);
  });

  it.each(githubAppEnvVarsReadByTheLoader())('passes %s into the base web service', (name) => {
    expect(webServiceBlock()).toMatch(new RegExp(`^\\s+${name}: \\$\\{${name}(:-[^}]*)?\\}$`, 'm'));
  });

  it.each(githubAppEnvVarsReadByTheLoader())(
    'passes %s into the blue-green web containers, which are what production runs',
    (name) => {
      expect(blueGreenCommonBlock()).toMatch(
        new RegExp(`^\\s+${name}: \\$\\{${name}(:-[^}]*)?\\}$`, 'm'),
      );
    },
  );
});

describe('the deployed app receives the mail configuration it reads', () => {
  it('finds the variables to check, rather than passing on an empty set', () => {
    const vars = mailEnvVarsReadByTheLoader();
    expect(vars).toContain('MAIL_PROVIDER');
    expect(vars).toContain('RESEND_API_KEY');
    expect(vars.length).toBeGreaterThan(4);
  });

  it.each(mailEnvVarsReadByTheLoader())(
    'passes %s into the base web service, interpolated from the deployment environment',
    (name) => {
      expect(webServiceBlock()).toMatch(
        new RegExp(`^\\s+${name}: \\$\\{${name}(:-[^}]*)?\\}$`, 'm'),
      );
    },
  );

  it.each(mailEnvVarsReadByTheLoader())(
    'passes %s into the blue-green web containers, which are what production runs',
    (name) => {
      expect(blueGreenCommonBlock()).toMatch(
        new RegExp(`^\\s+${name}: \\$\\{${name}(:-[^}]*)?\\}$`, 'm'),
      );
    },
  );
});

describe('the deployed app receives the billing configuration it reads', () => {
  it('finds the variables to check, rather than passing on an empty set', () => {
    expect(stripeEnvVarsReadByTheLoader()).toEqual([
      'PITCHBOX_BILLING',
      'STRIPE_PORTAL_CONFIGURATION',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
    ]);
  });

  it.each(stripeEnvVarsReadByTheLoader())(
    'passes %s into the base web service, interpolated from the deployment environment',
    (name) => {
      expect(webServiceBlock()).toMatch(
        new RegExp(`^\\s+${name}: \\$\\{${name}(:-[^}]*)?\\}$`, 'm'),
      );
    },
  );

  it.each(stripeEnvVarsReadByTheLoader())(
    'passes %s into the blue-green web containers, which are what production runs',
    (name) => {
      expect(blueGreenCommonBlock()).toMatch(
        new RegExp(`^\\s+${name}: \\$\\{${name}(:-[^}]*)?\\}$`, 'm'),
      );
    },
  );
});
