/**
 * Reads the deployment's mail configuration straight from the environment,
 * the same way `AI_GATEWAY_API_KEY` works for the cloud runner
 * (`shared/src/agents/sdk/runner.ts`): a deployment-level secret read once
 * from `process.env`, never persisted to the database or exposed on a
 * Settings page. `app_config` (`runner_configs`, `quota_defaults`,
 * `notification_webhooks`) is for operator-editable, non-secret settings a
 * deploy can change without a restart - a provider API key or an SMTP
 * password is not that, so it stays in `.env` alongside `ENCRYPTION_KEY`
 * and `PITCHBOX_INTERNAL_TOKEN`.
 *
 * `MAIL_PROVIDER` selects the transport explicitly (`resend` | `smtp`);
 * unset, unrecognized, or missing the provider's required credential all
 * fall back to `null` - see `./registry.ts` for why a half-configured
 * provider must not become a transport that only fails once it tries to
 * send.
 */
export type MailEnv =
  | { provider: 'null' }
  | { provider: 'resend'; apiKey: string; from: string }
  | {
      provider: 'smtp';
      host: string;
      port: number;
      secure: boolean;
      user?: string;
      pass?: string;
      from: string;
    };

const DEFAULT_FROM = 'Pitchbox <no-reply@pitchbox.app>';
const DEFAULT_SMTP_PORT = 587;

export function loadMailEnv(env: Record<string, string | undefined> = process.env): MailEnv {
  const from = env.MAIL_FROM?.trim() || DEFAULT_FROM;
  const provider = env.MAIL_PROVIDER?.trim().toLowerCase();

  if (provider === 'resend') {
    const apiKey = env.RESEND_API_KEY?.trim();
    if (!apiKey) {
      console.warn(
        '[mail] MAIL_PROVIDER=resend but RESEND_API_KEY is not set - falling back to the null transport',
      );
      return { provider: 'null' };
    }
    return { provider: 'resend', apiKey, from };
  }

  if (provider === 'smtp') {
    const host = env.SMTP_HOST?.trim();
    if (!host) {
      console.warn(
        '[mail] MAIL_PROVIDER=smtp but SMTP_HOST is not set - falling back to the null transport',
      );
      return { provider: 'null' };
    }
    const port = env.SMTP_PORT ? Number(env.SMTP_PORT) : DEFAULT_SMTP_PORT;
    if (!Number.isFinite(port)) {
      console.warn(
        `[mail] MAIL_PROVIDER=smtp but SMTP_PORT ("${env.SMTP_PORT}") is not a number - falling back to the null transport`,
      );
      return { provider: 'null' };
    }
    return {
      provider: 'smtp',
      host,
      port,
      secure: env.SMTP_SECURE === 'true',
      user: env.SMTP_USER?.trim() || undefined,
      pass: env.SMTP_PASS?.trim() || undefined,
      from,
    };
  }

  return { provider: 'null' };
}
