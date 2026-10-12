import { describe, expect, it } from 'vitest';
import {
  hostInDomains,
  LISTEN_PATTERN,
  matchesUrlPattern,
  normalizeDomain,
  tabPatternIssue,
  topicMatches,
  urlInDomains,
} from '../patterns';

describe('matchesUrlPattern', () => {
  it('matches a bare domain, its subdomains and nothing else', () => {
    expect(matchesUrlPattern('x.com', 'https://x.com/home')).toBe(true);
    expect(matchesUrlPattern('x.com', 'https://mobile.x.com/notifications')).toBe(true);
    expect(matchesUrlPattern('x.com', 'https://notx.com/')).toBe(false);
    expect(matchesUrlPattern('x.com', 'https://x.com.evil.example/')).toBe(false);
  });

  it('matches host and path globs, with *. covering the bare domain', () => {
    expect(matchesUrlPattern('*.linkedin.com/feed*', 'https://www.linkedin.com/feed/')).toBe(true);
    expect(matchesUrlPattern('*.linkedin.com/feed*', 'https://linkedin.com/feed')).toBe(true);
    expect(matchesUrlPattern('*.linkedin.com/feed*', 'https://www.linkedin.com/in/someone')).toBe(false);
    expect(matchesUrlPattern('x.com/*/status/*', 'https://x.com/ada/status/123')).toBe(true);
    expect(matchesUrlPattern('x.com/*/status/*', 'https://x.com/home')).toBe(false);
  });

  it('matches the whole address when the pattern has a scheme', () => {
    expect(matchesUrlPattern('https://news.ycombinator.com/item*', 'https://news.ycombinator.com/item?id=1')).toBe(
      true,
    );
    expect(matchesUrlPattern('https://news.ycombinator.com/*', 'http://news.ycombinator.com/news')).toBe(false);
    expect(matchesUrlPattern('*://news.ycombinator.com/*', 'http://news.ycombinator.com/news')).toBe(true);
  });

  it('looks at the query only when the pattern has one, and at the port', () => {
    expect(matchesUrlPattern('127.0.0.1:*/fixture.html?watch=*', 'http://127.0.0.1:5173/fixture.html?watch=1')).toBe(
      true,
    );
    expect(matchesUrlPattern('127.0.0.1:*/fixture.html?watch=*', 'http://127.0.0.1:5173/fixture.html')).toBe(false);
    expect(matchesUrlPattern('127.0.0.1:*/fixture.html', 'http://127.0.0.1:5173/fixture.html?watch=1')).toBe(true);
  });

  it('never matches pages off the web or an empty pattern', () => {
    expect(matchesUrlPattern('x.com', 'chrome://settings')).toBe(false);
    expect(matchesUrlPattern('x.com', 'not a url')).toBe(false);
    expect(matchesUrlPattern('  ', 'https://x.com/')).toBe(false);
  });
});

describe('tabPatternIssue', () => {
  it('accepts patterns that name a site', () => {
    for (const pattern of ['x.com', 'x.com/*', '*.linkedin.com/feed*', 'https://x.com/*', '127.0.0.1:*/page.html'])
      expect(tabPatternIssue(pattern)).toBeNull();
  });

  it('refuses patterns that would match every site', () => {
    for (const pattern of ['*', '*/*', '*://*/*', '*.com', 'https://*/x', '*x.com', ''])
      expect(tabPatternIssue(pattern)).not.toBeNull();
    expect(tabPatternIssue('x.com /a')).toMatch(/spaces/);
  });
});

describe('sites', () => {
  it('normalises entries to host names', () => {
    expect(normalizeDomain('https://www.X.com/home?a=1')).toBe('x.com');
    expect(normalizeDomain('*.linkedin.com')).toBe('*.linkedin.com');
    expect(normalizeDomain('127.0.0.1:8080')).toBe('127.0.0.1');
    expect(normalizeDomain('not a host')).toBeNull();
    expect(normalizeDomain('')).toBeNull();
  });

  it('allows a host on the list or under it, and everything when the list is empty', () => {
    expect(hostInDomains('mobile.x.com', ['x.com'])).toBe(true);
    expect(hostInDomains('x.com', ['*.x.com'])).toBe(true);
    expect(hostInDomains('evilx.com', ['x.com'])).toBe(false);
    expect(hostInDomains('anything.example', [])).toBe(true);
    expect(urlInDomains('about:blank', ['x.com'])).toBe(true);
    expect(urlInDomains('https://y.com/', ['x.com'])).toBe(false);
  });
});

describe('topics', () => {
  it('matches exact topics and trailing wildcards', () => {
    expect(topicMatches('social.mentions', 'social.mentions')).toBe(true);
    expect(topicMatches('social.*', 'social.mentions')).toBe(true);
    expect(topicMatches('social.*', 'research.brief')).toBe(false);
    expect(topicMatches('Social.Mentions', 'social.mentions')).toBe(true);
    expect(topicMatches('', 'x')).toBe(false);
  });

  it('never lets an agent listen to everything', () => {
    expect(LISTEN_PATTERN.test('*')).toBe(false);
    expect(LISTEN_PATTERN.test('news.*')).toBe(true);
  });
});

describe('matchesUrlPattern never lets a pattern stretch across site and path', () => {
  it('keeps look-alike sites out', () => {
    expect(matchesUrlPattern('x.com*', 'https://x.com.evil.com/')).toBe(false);
    expect(matchesUrlPattern('https://x.com*', 'https://x.com.evil.com/home')).toBe(false);
    expect(matchesUrlPattern('x.com/*', 'https://x.com.evil.com/x.com/')).toBe(false);
    expect(matchesUrlPattern('x.com', 'https://evil.com/x.com')).toBe(false);
    expect(matchesUrlPattern('*.linkedin.com/feed*', 'https://linkedin.com.evil.io/feed')).toBe(false);
  });

  it('still matches what the patterns mean', () => {
    expect(matchesUrlPattern('x.com', 'https://x.com/home')).toBe(true);
    expect(matchesUrlPattern('x.com', 'https://mobile.x.com/')).toBe(true);
    expect(matchesUrlPattern('x.com/*', 'https://x.com/i/notifications')).toBe(true);
    expect(matchesUrlPattern('*.linkedin.com/feed*', 'https://www.linkedin.com/feed/')).toBe(true);
    expect(matchesUrlPattern('*.linkedin.com/feed*', 'https://linkedin.com/feed')).toBe(true);
    expect(matchesUrlPattern('https://news.ycombinator.com/item*', 'https://news.ycombinator.com/item?id=1')).toBe(
      true,
    );
    expect(matchesUrlPattern('http://news.ycombinator.com/item*', 'https://news.ycombinator.com/item')).toBe(false);
    expect(matchesUrlPattern('127.0.0.1:8080/page.html?watch=*', 'http://127.0.0.1:8080/page.html?watch=1')).toBe(true);
    expect(matchesUrlPattern('127.0.0.1:8080/page.html', 'http://127.0.0.1:9090/page.html')).toBe(false);
  });
});
