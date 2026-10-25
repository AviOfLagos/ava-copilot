import { describe, expect, it } from 'vitest';
import { browserInfo, describeBrowser, issueUrl } from '../url';

const nav = (data: object) => data as unknown as Navigator;

describe('browserInfo', () => {
  it('names Brave by its own marker, and the system', () => {
    const info = browserInfo(
      nav({ brave: {}, userAgentData: { brands: [{ brand: 'Chromium', version: '131' }], platform: 'macOS' } }),
    );
    expect(describeBrowser(info)).toBe('Brave 131 on macOS');
  });

  it('names Chrome and Edge from their brands, without the filler brand', () => {
    const chrome = browserInfo(
      nav({
        userAgentData: {
          brands: [
            { brand: 'Not_A Brand', version: '24' },
            { brand: 'Chromium', version: '131' },
            { brand: 'Google Chrome', version: '131' },
          ],
          platform: 'Linux',
        },
      }),
    );
    expect(describeBrowser(chrome)).toBe('Chrome 131 on Linux');
    const edge = browserInfo(
      nav({ userAgentData: { brands: [{ brand: 'Microsoft Edge', version: '130' }], platform: 'Windows' } }),
    );
    expect(describeBrowser(edge)).toBe('Microsoft Edge 130 on Windows');
  });

  it('falls back to the platform string without client hints', () => {
    expect(describeBrowser(browserInfo(nav({ platform: 'MacIntel' })))).toBe('Browser on MacIntel');
  });
});

describe('issueUrl', () => {
  it('fills the bug form by its field ids', () => {
    const url = new URL(issueUrl('bug', { version: '0.2.1', browser: 'Brave 131 on macOS' }));
    expect(url.pathname).toBe('/AviOfLagos/ava-copilot/issues/new');
    expect(url.searchParams.get('template')).toBe('bug_report.yml');
    expect(url.searchParams.get('version')).toBe('0.2.1');
    expect(url.searchParams.get('browser')).toBe('Brave 131 on macOS');
  });

  it('opens the idea form with nothing about the browser', () => {
    const url = new URL(issueUrl('idea', { version: '0.2.1', browser: 'x' }));
    expect(url.searchParams.get('template')).toBe('feature_request.yml');
    expect(url.searchParams.has('browser')).toBe(false);
  });
});
