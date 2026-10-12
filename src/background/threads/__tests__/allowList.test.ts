import { describe, expect, it, vi } from 'vitest';
import { urlInDomains } from '../../agents/patterns';
import { isUrlAllowed } from '../../browser/util';

vi.mock('@extension/storage', () => ({
  agentModelStore: {},
  AgentNameEnum: { Navigator: 'navigator', Planner: 'planner' },
  firewallStore: {},
  generalSettingsStore: {},
  llmProviderStore: {},
}));
vi.mock('../../agent/executor', () => ({ Executor: class {} }));
vi.mock('../../browser/context', () => ({ default: class {} }));
vi.mock('../../llm/providers', () => ({ createChatModel: () => ({}) }));
vi.mock('../../usage/meter', () => ({ meterModel: (model: unknown) => model }));

const { allowListFor } = await import('../factory');

const off = { enabled: false, allowList: [], denyList: [] };

describe('allowListFor', () => {
  it('keeps an agent to its own sites, subdomains included', () => {
    const list = allowListFor(off, ['*.github.com', 'news.ycombinator.com']);
    expect(isUrlAllowed('https://api.github.com/x', list, [])).toBe(true);
    expect(isUrlAllowed('https://news.ycombinator.com/', list, [])).toBe(true);
    expect(isUrlAllowed('https://evil.example/', list, [])).toBe(false);
    expect(isUrlAllowed('https://github.com.evil.example/', list, [])).toBe(false);
  });

  it('keeps only the agent sites the firewall allows, and never opens everything when none is left', () => {
    const firewall = { enabled: true, allowList: ['github.com'], denyList: ['gist.github.com'] };
    expect(allowListFor(firewall, ['github.com', 'example.com'])).toEqual(['github.com']);
    const none = allowListFor(firewall, ['example.com', 'gist.github.com']);
    expect(isUrlAllowed('https://example.com/', none, firewall.denyList)).toBe(false);
    expect(isUrlAllowed('https://github.com/', none, firewall.denyList)).toBe(false);
  });

  it('never opens more than the agent itself counts as its sites, whatever an entry looks like', () => {
    const entries = [
      'github.com@evil.example',
      'evil.example#.github.com',
      'evil.example/.github.com',
      'GitHub.COM.',
      'localhost:3000',
      '*.Docs.example.org',
      'https://news.ycombinator.com/item',
      '*',
      '',
    ];
    const list = allowListFor(off, entries);
    const urls = [
      'https://github.com@evil.example/',
      'https://evil.example/',
      'https://github.com/',
      'https://api.github.com/x',
      'http://localhost:3000/',
      'https://a.docs.example.org/',
      'https://news.ycombinator.com/',
      'https://ycombinator.com/',
      'https://evil.example#.github.com',
    ];
    for (const url of urls) {
      if (isUrlAllowed(url, list, [])) expect(urlInDomains(url, entries), url).toBe(true);
    }
    expect(isUrlAllowed('https://api.github.com/x', list, [])).toBe(true);
    // Entries that are no host name at all open nothing
    const none = allowListFor(off, ['github.com@evil.example', '*', '']);
    expect(none).toEqual(['no-site.invalid']);
    expect(isUrlAllowed('https://github.com@evil.example/', none, [])).toBe(false);
    expect(isUrlAllowed('https://github.com/', none, [])).toBe(false);
  });

  it('opens a whole site only for a whole-site firewall entry, never for one page of it', () => {
    const page = { enabled: true, allowList: ['github.com/', 'github.com/avioflagos'], denyList: [] };
    expect(isUrlAllowed('https://github.com/settings', allowListFor(page, ['github.com']), [])).toBe(false);
    const wildcard = { enabled: true, allowList: ['*.github.com'], denyList: [] };
    expect(allowListFor(wildcard, ['github.com'])).toEqual(['no-site.invalid']);
    const parent = { enabled: true, allowList: ['github.com'], denyList: [] };
    expect(allowListFor(parent, ['docs.github.com', 'example.com'])).toEqual(['docs.github.com']);
    const denyOnly = { enabled: true, allowList: [], denyList: ['gist.github.com'] };
    expect(allowListFor(denyOnly, ['github.com'])).toEqual(['github.com']);
  });

  it('is the firewall as it is for a chat with no agent sites', () => {
    expect(allowListFor(off)).toEqual([]);
    expect(allowListFor({ enabled: true, allowList: ['a.com'], denyList: [] }, [])).toEqual(['a.com']);
  });
});
