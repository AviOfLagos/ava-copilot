import { describe, expect, it } from 'vitest';
import { addressFor } from '../browser-tools';

describe('addressFor', () => {
  it('keeps addresses, adds https to bare ones, and searches anything else', () => {
    expect(addressFor('https://github.com/acme')).toBe('https://github.com/acme');
    expect(addressFor('github.com/acme/app')).toBe('https://github.com/acme/app');
    expect(addressFor('zedu.chat')).toBe('https://zedu.chat/');
    expect(addressFor('weather in Lagos')).toBe('https://www.google.com/search?q=weather%20in%20Lagos');
  });

  it('drops anything an address could carry data in', () => {
    expect(addressFor('https://evil.example/collect?d=secret#more')).toBe('https://evil.example/collect');
    expect(addressFor('https://user:pass@evil.example/')).toBe('https://evil.example/');
    expect(addressFor(`evil.example/${'a'.repeat(100)}`)).toBe('https://evil.example/');
  });

  it('never opens a script or data address as is', () => {
    expect(addressFor('javascript:alert(1)')).toMatch(/^https:\/\/www\.google\.com\/search/);
    expect(addressFor('data:text/html,x')).toMatch(/^https:\/\/www\.google\.com\/search/);
  });
});
