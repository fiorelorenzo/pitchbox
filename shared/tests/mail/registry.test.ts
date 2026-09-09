import { describe, expect, it, vi } from 'vitest';
import { createMailTransport } from '../../src/mail/registry.js';
import { loadMailEnv } from '../../src/mail/env.js';
import { NullMailTransport } from '../../src/mail/base.js';
import { ResendMailTransport } from '../../src/mail/resend.js';
import { SmtpMailTransport } from '../../src/mail/smtp.js';

describe('createMailTransport', () => {
  it('selects the null transport when nothing is configured', () => {
    const transport = createMailTransport(loadMailEnv({}));
    expect(transport).toBeInstanceOf(NullMailTransport);
  });

  it('selects the resend transport when resend is fully configured', () => {
    const transport = createMailTransport(
      loadMailEnv({ MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_abc123' }),
    );
    expect(transport).toBeInstanceOf(ResendMailTransport);
  });

  it('selects the smtp transport when smtp is fully configured', () => {
    const transport = createMailTransport(
      loadMailEnv({ MAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.example.com' }),
    );
    expect(transport).toBeInstanceOf(SmtpMailTransport);
  });

  // The acceptance case this whole module exists to satisfy: a deploy that
  // opts into a real provider but forgets (or has not yet set) its
  // credential must not get a transport that only discovers the problem on
  // its first real send attempt (an opaque provider auth error at draft
  // time, in front of whoever is testing a reset flow). loadMailEnv already
  // downgrades that to `{ provider: 'null' }` before createMailTransport
  // ever runs its switch, so there is no code path here that can construct
  // a ResendMailTransport/SmtpMailTransport with a missing credential.
  it('falls back to the null transport, not a half-configured real one, when a selected provider is missing its credential', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const resendMissingKey = createMailTransport(loadMailEnv({ MAIL_PROVIDER: 'resend' }));
      expect(resendMissingKey).toBeInstanceOf(NullMailTransport);

      const smtpMissingHost = createMailTransport(loadMailEnv({ MAIL_PROVIDER: 'smtp' }));
      expect(smtpMissingHost).toBeInstanceOf(NullMailTransport);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
