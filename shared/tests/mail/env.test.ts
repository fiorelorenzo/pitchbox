import { describe, expect, it, vi } from 'vitest';
import { loadMailEnv } from '../../src/mail/env.js';

describe('loadMailEnv', () => {
  it('selects the null transport when nothing is configured', () => {
    expect(loadMailEnv({})).toEqual({ provider: 'null' });
  });

  it('selects resend when MAIL_PROVIDER=resend and RESEND_API_KEY is set', () => {
    const cfg = loadMailEnv({ MAIL_PROVIDER: 'resend', RESEND_API_KEY: 're_abc123' });
    expect(cfg).toEqual({
      provider: 'resend',
      apiKey: 're_abc123',
      from: 'Pitchbox <no-reply@pitchbox.app>',
    });
  });

  it('falls back to null when MAIL_PROVIDER=resend but RESEND_API_KEY is missing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(loadMailEnv({ MAIL_PROVIDER: 'resend' })).toEqual({ provider: 'null' });
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('falls back to null when MAIL_PROVIDER=resend but RESEND_API_KEY is blank', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadMailEnv({ MAIL_PROVIDER: 'resend', RESEND_API_KEY: '   ' })).toEqual({
      provider: 'null',
    });
    vi.restoreAllMocks();
  });

  it('selects smtp when MAIL_PROVIDER=smtp and SMTP_HOST is set', () => {
    const cfg = loadMailEnv({
      MAIL_PROVIDER: 'smtp',
      SMTP_HOST: 'smtp.example.com',
      SMTP_PORT: '2525',
      SMTP_SECURE: 'true',
      SMTP_USER: 'bot',
      SMTP_PASS: 'secret',
    });
    expect(cfg).toEqual({
      provider: 'smtp',
      host: 'smtp.example.com',
      port: 2525,
      secure: true,
      user: 'bot',
      pass: 'secret',
      from: 'Pitchbox <no-reply@pitchbox.app>',
    });
  });

  it('defaults the smtp port to 587 when SMTP_PORT is unset', () => {
    const cfg = loadMailEnv({ MAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.example.com' });
    expect(cfg).toMatchObject({ provider: 'smtp', port: 587, secure: false });
  });

  it('falls back to null when MAIL_PROVIDER=smtp but SMTP_HOST is missing', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(loadMailEnv({ MAIL_PROVIDER: 'smtp' })).toEqual({ provider: 'null' });
    vi.restoreAllMocks();
  });

  it('falls back to null when MAIL_PROVIDER=smtp but SMTP_PORT is not a number', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(
      loadMailEnv({ MAIL_PROVIDER: 'smtp', SMTP_HOST: 'smtp.example.com', SMTP_PORT: 'nope' }),
    ).toEqual({ provider: 'null' });
    vi.restoreAllMocks();
  });

  it('falls back to null for an unrecognized MAIL_PROVIDER value', () => {
    expect(loadMailEnv({ MAIL_PROVIDER: 'sendgrid', RESEND_API_KEY: 're_abc123' })).toEqual({
      provider: 'null',
    });
  });

  it('honors a custom MAIL_FROM', () => {
    const cfg = loadMailEnv({
      MAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_abc123',
      MAIL_FROM: 'Pitchbox Support <support@pitchbox.app>',
    });
    expect(cfg).toMatchObject({ from: 'Pitchbox Support <support@pitchbox.app>' });
  });
});
