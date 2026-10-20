import { describe, expect, it, vi } from 'vitest';

vi.mock('@extension/i18n', () => ({ t: (key: string) => key }));

const { clip, describeRequest, toWhatsAppText } = await import('../format');
const { inQuietHours, mayNotify } = await import('../notices');
const { DEFAULT_WHATSAPP_REMOTE_SETTINGS } = await import('../state');

describe('WhatsApp text', () => {
  it('turns markdown into WhatsApp’s own marks and drops tables and code fences', () => {
    const text = toWhatsAppText(
      [
        '# Plan',
        '',
        'Some **bold** and *soft* words with `code` and [a link](https://example.com).',
        '',
        '| Name | Score |',
        '| :--- | ---: |',
        '| Avi | 10 |',
        '',
        '```js',
        'const x = 1;',
        '```',
        '',
        '',
        '',
        '* one',
        '- two',
        '> quoted',
        '![picture](https://example.com/p.png)',
      ].join('\n'),
    );
    expect(text).toBe(
      [
        '*Plan*',
        '',
        'Some *bold* and _soft_ words with code and a link (https://example.com).',
        '',
        'Name · Score',
        'Avi · 10',
        '',
        'const x = 1;',
        '',
        '• one',
        '• two',
        'quoted',
        'picture',
      ].join('\n'),
    );
  });

  it('keeps a long answer to a phone-sized length, cut at a sentence', () => {
    const long = Array.from({ length: 200 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const text = toWhatsAppText(long, 300, '… more');
    expect(text.length).toBeLessThanOrEqual(300);
    expect(text.endsWith('. … more')).toBe(true);
    expect(clip('short', 300)).toBe('short');
  });

  it('says in a few words what waits for the click', () => {
    const base = { id: 'r', taskId: 't', intent: 'Send it', pageTitle: '', pageUrl: '', fields: [], context: '' };
    expect(describeRequest({ ...base, mode: 'commit', kind: 'send', target: 'Send   to Tomi' })).toBe(
      'send: Send to Tomi',
    );
    expect(describeRequest({ ...base, mode: 'needs_user', kind: 'login', target: '' })).toBe('wava_req_login');
    expect(describeRequest(null)).toBe('');
  });
});

describe('quiet hours', () => {
  const at = (hours: number, minutes = 0) => new Date(2026, 9, 20, hours, minutes);

  it('wrap past midnight', () => {
    expect(inQuietHours(at(22), '22:00', '07:00')).toBe(true);
    expect(inQuietHours(at(3), '22:00', '07:00')).toBe(true);
    expect(inQuietHours(at(7), '22:00', '07:00')).toBe(false);
    expect(inQuietHours(at(12), '22:00', '07:00')).toBe(false);
    expect(inQuietHours(at(13), '12:00', '14:00')).toBe(true);
    expect(inQuietHours(at(13), '', '14:00')).toBe(false);
  });

  it('hold everything but approvals, and a kind switched off is never sent', () => {
    const settings = DEFAULT_WHATSAPP_REMOTE_SETTINGS;
    expect(mayNotify('approval', settings, at(23))).toBe(true);
    expect(mayNotify('brief', settings, at(23))).toBe(false);
    expect(mayNotify('brief', settings, at(8))).toBe(true);
    expect(mayNotify('approval', { ...settings, notify: { ...settings.notify, approval: false } }, at(12))).toBe(false);
  });
});
