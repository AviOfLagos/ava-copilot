import { describe, expect, it } from 'vitest';
import { addressFor, spokenSite } from '../browser-tools';

describe('addressFor', () => {
  it('keeps addresses, adds https to bare ones, and searches anything else', () => {
    expect(addressFor('https://github.com/acme')).toBe('https://github.com/');
    expect(addressFor('github.com/acme/app', new Set(['https://github.com/acme/app']))).toBe(
      'https://github.com/acme/app',
    );
    // A new path on a site that is open still loses its path
    expect(addressFor('github.com/acme/other', new Set(['https://github.com/acme/app']))).toBe('https://github.com/');
    expect(addressFor('github.com/acme/app')).toBe('https://github.com/');
    expect(addressFor('zedu.chat')).toBe('https://zedu.chat/');
    expect(addressFor('weather in Lagos')).toBe('https://www.google.com/search?q=weather%20in%20Lagos');
  });

  it('drops anything an address could carry data in', () => {
    expect(addressFor('https://evil.example/collect?d=secret#more')).toBe('https://evil.example/');
    // The page that was read is open, but a new path on its site could carry data
    expect(addressFor('https://evil.example/c2VjcmV0', new Set(['https://evil.example/article']))).toBe(
      'https://evil.example/',
    );
    expect(addressFor('https://c2VjcmV0LXRva2VuLWhlcmUtMTIzNDU.evil.example/')).toMatch(/google\.com\/search/);
    expect(addressFor('a.b.c.d.evil.example')).toMatch(/google\.com\/search/);
    expect(addressFor('https://user:pass@evil.example/')).toBe('https://evil.example/');
    expect(addressFor(`evil.example/${'a'.repeat(100)}`)).toBe('https://evil.example/');
  });

  it('cuts a long search, so it cannot carry a page of text', () => {
    const query = decodeURIComponent(addressFor('word '.repeat(100)).split('q=')[1]);
    expect(query.length).toBe(120);
  });

  it('never opens a script or data address as is', () => {
    expect(addressFor('javascript:alert(1)')).toMatch(/^https:\/\/www\.google\.com\/search/);
    expect(addressFor('data:text/html,x')).toMatch(/^https:\/\/www\.google\.com\/search/);
  });
});

describe('spokenSite', () => {
  it('knows a site the user named', () => {
    expect(spokenSite('github.com', 'open github for me')).toBe(true);
    expect(spokenSite('zedu.chat', 'go to Zedu')).toBe(true);
    expect(spokenSite('youtube.com', 'put on YouTube')).toBe(true);
    expect(spokenSite('news.ycombinator.com', 'open y combinator news')).toBe(true);
  });

  it('refuses a site the user never named', () => {
    expect(spokenSite('evil.example', 'open github for me')).toBe(false);
    expect(spokenSite('collect-data.net', '')).toBe(false);
    // A common word the user said is not the name of a site called that
    expect(spokenSite('open.io', 'open github for me')).toBe(false);
    expect(spokenSite('page.example', 'read this page')).toBe(false);
    // Part of a word is not the word
    expect(spokenSite('hub.example', 'open github')).toBe(false);
  });
});
