import { describe, expect, it } from 'vitest';
import { isPrivateHost } from '../net';

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
    ]) {
      expect(isPrivateHost(host), host).toBe(true);
    }
  });

  it('allows public sites', () => {
    for (const host of ['hn.algolia.com', 'huggingface.co', '8.8.8.8', 'api.github.com', '172.32.0.1']) {
      expect(isPrivateHost(host), host).toBe(false);
    }
  });
});
