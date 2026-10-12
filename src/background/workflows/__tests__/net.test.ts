import { describe, expect, it } from 'vitest';
import { isPrivateHost } from '../net';
import { readablePage } from '../page-text';

describe('isPrivateHost', () => {
  it('refuses this machine, private networks, metadata and local names', () => {
    for (const host of [
      'localhost',
      '127.0.0.1',
      '10.0.0.5',
      '172.20.1.1',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '[::1]',
      'fd12:3456::1',
      'fe80::1',
      '::ffff:192.168.0.1',
      'router',
      'nas.local',
      'printer.lan',
      'grafana.internal',
      // The forms the browser rewrites addresses into, and other ways to write them
      '::ffff:7f00:1',
      '[::ffff:7f00:1]',
      '::7f00:1',
      '64:ff9b::7f00:1',
      '64:ff9b::c0a8:101',
      '2002:c0a8:101::',
      '2130706433',
      '0x7f.1',
      '127.1',
      'fec0::1',
      'ff02::1',
      'local',
    ]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
  });

  it('allows public sites', () => {
    for (const host of [
      'hn.algolia.com',
      'huggingface.co',
      '8.8.8.8',
      'api.github.com',
      '172.32.0.1',
      '2606:4700:4700::1111',
      '::ffff:808:808',
    ]) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });
});

describe('readablePage', () => {
  it('keeps the words and the title, never scripts, styles or markup', () => {
    const page = readablePage(
      '<html><head><title>Daily &amp; Papers</title><style>p{}</style></head><body><script>steal()</script>' +
        '<h1>Top</h1><p>One &lt;b&gt; two&#39;s</p><!-- note --><p>Three</p></body></html>',
    );
    expect(page.title).toBe('Daily & Papers');
    expect(page.text).toBe("Top\nOne <b> two's\nThree");
    expect(page.text).not.toContain('steal');
  });
});
