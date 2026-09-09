import { NullMailTransport, type MailTransport } from './base.js';
import type { MailEnv } from './env.js';
import { ResendMailTransport } from './resend.js';
import { SmtpMailTransport } from './smtp.js';

/**
 * Selects a `MailTransport` from an already-loaded `MailEnv`. Mirrors
 * `createAgentRunner` (`../agents/registry.ts`): one switch over the
 * resolved config, never a re-check of `process.env` here - `loadMailEnv`
 * already turned a missing credential into `{ provider: 'null' }`, so this
 * function can never construct a half-configured real transport.
 */
export function createMailTransport(cfg: MailEnv): MailTransport {
  switch (cfg.provider) {
    case 'resend':
      return new ResendMailTransport(cfg.apiKey, cfg.from);
    case 'smtp':
      return new SmtpMailTransport(
        { host: cfg.host, port: cfg.port, secure: cfg.secure, user: cfg.user, pass: cfg.pass },
        cfg.from,
      );
    case 'null':
      return new NullMailTransport();
  }
}
