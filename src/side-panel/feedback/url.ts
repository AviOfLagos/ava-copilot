/**
 * Links to the project's GitHub issue forms (.github/ISSUE_TEMPLATE), with the fields a fixer needs already filled
 * in from this browser: the extension's version and the browser and system. Nothing is sent from here; GitHub
 * shows the form and the user submits it there.
 */

export const ISSUES_URL = 'https://github.com/AviOfLagos/ava-copilot/issues/new';

export interface BrowserInfo {
  brand: string;
  version: string;
  platform: string;
}

type UaData = { brands?: { brand: string; version: string }[]; platform?: string };

/** The browser and system, from the browser's own hints; Brave says so through `navigator.brave`. */
export function browserInfo(nav: Navigator & { userAgentData?: UaData; brave?: unknown }): BrowserInfo {
  const brands = (nav.userAgentData?.brands ?? []).filter(item => !/not.?a.?brand|chromium/i.test(item.brand));
  const chromium = nav.userAgentData?.brands?.find(item => /chromium/i.test(item.brand));
  const named = brands[0];
  const brand = nav.brave ? 'Brave' : (named?.brand ?? (chromium ? 'Chromium' : 'Browser'));
  const version = named?.version ?? chromium?.version ?? '';
  const platform = nav.userAgentData?.platform || nav.platform || '';
  return { brand: brand.replace(/^Google /, ''), version, platform };
}

export function describeBrowser(info: BrowserInfo): string {
  return [info.version ? `${info.brand} ${info.version}` : info.brand, info.platform && `on ${info.platform}`]
    .filter(Boolean)
    .join(' ');
}

/** The issue form's address with its fields filled in (GitHub reads them by each field's id). */
export function issueUrl(kind: 'bug' | 'idea', fields: { version: string; browser: string }): string {
  const params = new URLSearchParams(
    kind === 'bug'
      ? { template: 'bug_report.yml', version: fields.version, browser: fields.browser }
      : { template: 'feature_request.yml' },
  );
  return `${ISSUES_URL}?${params}`;
}
