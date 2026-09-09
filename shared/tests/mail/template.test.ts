import { describe, expect, it } from 'vitest';
import { renderPlainTextMail } from '../../src/mail/template.js';

describe('renderPlainTextMail', () => {
  it('carries both a text part and an HTML part, and the text part is not empty', () => {
    const rendered = renderPlainTextMail(
      'Reset your password',
      'Click the link below to reset your password.\n\nIf you did not request this, ignore this email.',
    );

    expect(rendered.text.length).toBeGreaterThan(0);
    expect(rendered.html.length).toBeGreaterThan(0);
    expect(rendered.text).toBe(
      'Click the link below to reset your password.\n\nIf you did not request this, ignore this email.',
    );
    expect(rendered.html).toContain('Click the link below to reset your password.');
    expect(rendered.html).toContain('<html');
  });

  it('preserves the subject verbatim (trimmed)', () => {
    const rendered = renderPlainTextMail('  Reset your password  ', 'body');
    expect(rendered.subject).toBe('Reset your password');
  });

  it('escapes HTML-significant characters from the text in the HTML part', () => {
    const rendered = renderPlainTextMail('Subject', 'Use <script>alert(1)</script> & enjoy');
    expect(rendered.html).not.toContain('<script>alert(1)</script>');
    expect(rendered.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(rendered.html).toContain('&amp;');
    // The text part is untouched - callers get the literal text back.
    expect(rendered.text).toBe('Use <script>alert(1)</script> & enjoy');
  });

  it('rejects an empty text body rather than silently producing a text-less mail', () => {
    expect(() => renderPlainTextMail('Subject', '')).toThrow(/text must not be empty/);
    expect(() => renderPlainTextMail('Subject', '   ')).toThrow(/text must not be empty/);
  });

  it('rejects an empty subject', () => {
    expect(() => renderPlainTextMail('', 'body')).toThrow(/subject must not be empty/);
  });
});
