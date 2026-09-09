import { describe, expect, it, vi } from 'vitest';
import { NullMailTransport } from '../../src/mail/base.js';
import { renderPlainTextMail } from '../../src/mail/template.js';

describe('NullMailTransport', () => {
  it('reports its name as "null"', () => {
    expect(new NullMailTransport().name).toBe('null');
  });

  it('resolves without throwing when sending', async () => {
    const transport = new NullMailTransport();
    const rendered = renderPlainTextMail('Reset your password', 'Click the link to reset.');

    await expect(transport.send({ to: 'user@example.com', ...rendered })).resolves.toBeUndefined();
  });

  it('logs the subject, recipient and text body it would have sent', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const transport = new NullMailTransport();
      const rendered = renderPlainTextMail('Reset your password', 'Click the link to reset.');

      await transport.send({ to: 'user@example.com', ...rendered });

      expect(logSpy).toHaveBeenCalledTimes(1);
      const logged = logSpy.mock.calls[0]?.[0] as string;
      expect(logged).toContain('user@example.com');
      expect(logged).toContain('Reset your password');
      expect(logged).toContain('Click the link to reset.');
    } finally {
      logSpy.mockRestore();
    }
  });
});
