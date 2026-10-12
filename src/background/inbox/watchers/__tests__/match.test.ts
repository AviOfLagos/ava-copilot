import { describe, expect, it } from 'vitest';
import { matchesGmailUrl } from '../gmail';
import { matchesSlackUrl } from '../slack';
import { matchesWhatsappUrl } from '../whatsapp';

describe('matchesWhatsappUrl', () => {
  it('matches only web.whatsapp.com', () => {
    expect(matchesWhatsappUrl('https://web.whatsapp.com/')).toBe(true);
    expect(matchesWhatsappUrl('https://web.whatsapp.com/send?phone=1')).toBe(true);
    expect(matchesWhatsappUrl('https://whatsapp.com/')).toBe(false);
    expect(matchesWhatsappUrl('https://evil.example/web.whatsapp.com')).toBe(false);
    expect(matchesWhatsappUrl('not a url')).toBe(false);
  });
});

describe('matchesSlackUrl', () => {
  it('matches any *.slack.com workspace', () => {
    expect(matchesSlackUrl('https://nexprove.slack.com/client/T1/C1')).toBe(true);
    expect(matchesSlackUrl('https://app.slack.com/client/T1')).toBe(true);
    expect(matchesSlackUrl('https://slack.com/')).toBe(false);
    expect(matchesSlackUrl('https://evil.example/slack.com')).toBe(false);
    expect(matchesSlackUrl('not a url')).toBe(false);
  });
});

describe('matchesGmailUrl', () => {
  it('matches only mail.google.com', () => {
    expect(matchesGmailUrl('https://mail.google.com/mail/u/0/#inbox')).toBe(true);
    expect(matchesGmailUrl('https://google.com/')).toBe(false);
    expect(matchesGmailUrl('https://evil.example/mail.google.com')).toBe(false);
    expect(matchesGmailUrl('not a url')).toBe(false);
  });
});
