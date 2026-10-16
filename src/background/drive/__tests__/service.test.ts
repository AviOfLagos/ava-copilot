import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { readPageText } from '../../reader/probes';
import { parseSelectors } from '../../whatsapp/selectors';
import {
  clickFirst,
  fetchInPage,
  fillShareEmail,
  pasteIntoDoc,
  pickShareRole,
  probeDoc,
  readDriveRows,
  renameDoc,
  shareDialogOpen,
} from '../page';
import type { DriveListReading, FetchReading } from '../page';
import { DriveError, DriveService, DriveSignInError, kindFromWords } from '../service';
import type { DriveTab } from '../tab';

const skill = fs.readFileSync(path.join(__dirname, '../../../storage/lib/skills/builtin/google-drive.md'), 'utf8');
const sel = parseSelectors(skill);
const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';

const reading = (over: Partial<FetchReading>): FetchReading => ({
  ok: true,
  status: 200,
  contentType: 'text/plain; charset=utf-8',
  finalUrl: '',
  text: '',
  truncated: false,
  ...over,
});

/** A tab whose page functions answer from the test's script. */
function fakeTab(script: {
  redirect?: (url: string) => string;
  rows?: DriveListReading;
  fetch?: (url: string) => FetchReading;
  pageText?: string;
  probe?: { ready: boolean; title: string; noAccess: boolean };
  title?: string;
}) {
  let url = 'about:blank';
  const calls: { func: string; arg: unknown; options?: unknown }[] = [];
  const answers = new Map<unknown, (arg: never) => unknown>([
    [readDriveRows, () => script.rows ?? { rows: [], empty: true, noAccess: false }],
    [fetchInPage, (arg: { url: string }) => script.fetch?.(arg.url) ?? reading({ ok: false, status: 0 })],
    [readPageText, () => ({ text: script.pageText ?? '', offset: 0, total: 0 })],
    [probeDoc, () => script.probe ?? { ready: true, title: script.title ?? '', noAccess: false }],
    [renameDoc, () => true],
    [pasteIntoDoc, () => ({ ok: true })],
    [clickFirst, () => true],
    [fillShareEmail, () => true],
    [pickShareRole, () => true],
  ]);
  let dialog = false;
  const tab: DriveTab & { calls: typeof calls; visited: string[] } = {
    tabId: 1,
    calls,
    visited: [],
    async navigate(next) {
      url = script.redirect ? script.redirect(next) : next;
      tab.visited.push(next);
      return url;
    },
    async run(func, arg, options) {
      calls.push({ func: func.name, arg, options });
      if (func === (shareDialogOpen as unknown)) {
        // Opens after the Share click, closes after Send
        const clicks = calls.filter(call => call.func === 'clickFirst').length;
        dialog = clicks === 1;
        return [dialog] as never;
      }
      const answer = answers.get(func);
      return [answer ? answer(arg as never) : undefined] as never;
    },
    async info() {
      return { url, title: script.title ?? '' };
    },
    async show() {},
  };
  return tab;
}

const service = (fetchText = vi.fn(async () => reading({ ok: false, status: 0 }))) =>
  new DriveService({ selectors: async () => sel, fetchText, sleep: async () => {} });

describe('the google-drive skill', () => {
  it('carries the selectors the feature needs', () => {
    for (const key of ['row', 'rowName', 'docsTextTarget', 'shareButton', 'shareEmail', 'shareSend', 'roleEditor']) {
      expect(sel[key]?.length, key).toBeGreaterThan(0);
    }
  });

  it('tells kinds apart by the words on a row', () => {
    expect(kindFromWords('Q3 plan Google Docs', sel)).toBe('document');
    expect(kindFromWords('Budget Google Sheets', sel)).toBe('spreadsheet');
    expect(kindFromWords('Shared folder', sel)).toBe('folder');
    expect(kindFromWords('report PDF', sel)).toBe('file');
  });
});

describe('DriveService', () => {
  it('searches in the tab, as the workspace account, and lists rows with links', async () => {
    const tab = fakeTab({
      rows: {
        rows: [
          { id: ID, title: 'Q3 plan', typeText: 'Google Docs' },
          { id: `${ID}f`, title: 'Plans', typeText: 'Folder' },
        ],
        empty: false,
        noAccess: false,
      },
    });
    const files = await service().search(tab, 'q3', 'ada@x.com');
    expect(tab.visited[0]).toBe('https://drive.google.com/drive/search?q=q3&authuser=ada%40x.com');
    expect(files).toEqual([
      { id: ID, title: 'Q3 plan', kind: 'document', link: `https://docs.google.com/document/d/${ID}/edit` },
      { id: `${ID}f`, title: 'Plans', kind: 'folder', link: `https://drive.google.com/drive/folders/${ID}f` },
    ]);
  });

  it('says so when Google shows its sign-in page', async () => {
    const tab = fakeTab({ redirect: () => 'https://accounts.google.com/ServiceLogin?continue=x' });
    await expect(service().search(tab, 'q3', null)).rejects.toBeInstanceOf(DriveSignInError);
  });

  it('reads a Doc through its export, fetched in the Docs tab', async () => {
    const tab = fakeTab({
      title: 'Q3 plan - Google Docs',
      fetch: url =>
        url.includes('/export?format=txt')
          ? reading({ text: '\uFEFFRevenue up 12%.', finalUrl: url })
          : reading({ ok: false }),
    });
    const fetchText = vi.fn(async () => reading({ ok: false, status: 0 }));
    const read = await service(fetchText).read(tab, `https://docs.google.com/document/d/${ID}/edit`, null);
    expect(read).toMatchObject({
      title: 'Q3 plan',
      text: 'Revenue up 12%.',
      link: `https://docs.google.com/document/d/${ID}/edit`,
    });
    expect(fetchText).not.toHaveBeenCalled();
  });

  it("falls back to the background's fetch, then to the Doc's light page", async () => {
    const tab = fakeTab({ title: 'Notes - Google Docs', pageText: 'Text from mobilebasic' });
    const fetchText = vi.fn(async () => reading({ ok: false, status: 0 }));
    const read = await service(fetchText).read(tab, `https://docs.google.com/document/d/${ID}/edit`, null);
    expect(fetchText).toHaveBeenCalledWith(`https://docs.google.com/document/d/${ID}/export?format=txt`, 200_000);
    expect(tab.visited.at(-1)).toBe(`https://docs.google.com/document/d/${ID}/mobilebasic`);
    expect(read.text).toBe('Text from mobilebasic');
  });

  it('never takes an HTML page (sign-in or error) for the file', async () => {
    const tab = fakeTab({
      title: 'Sheet - Google Sheets',
      fetch: () => reading({ contentType: 'text/html', text: '<html>Sign in</html>' }),
    });
    await expect(service().read(tab, `https://docs.google.com/spreadsheets/d/${ID}/edit`, null)).rejects.toMatchObject({
      problem: 'no_access',
    });
    const signIn = fakeTab({ fetch: () => reading({ finalUrl: 'https://accounts.google.com/v3/signin' }) });
    await expect(
      service().read(signIn, `https://docs.google.com/presentation/d/${ID}/edit`, null),
    ).rejects.toBeInstanceOf(DriveSignInError);
  });

  it('finds out what a bare id is by opening it, and reads a PDF from the viewer', async () => {
    const viewer = `Report 2026\n${'Lorem ipsum dolor sit amet. '.repeat(10)}`;
    const tab = fakeTab({
      redirect: url => (url.includes('open?id=') ? `https://drive.google.com/file/d/${ID}/view` : url),
      title: 'report.pdf - Google Drive',
      pageText: viewer,
    });
    const read = await service().read(tab, ID, null);
    expect(read.ref.kind).toBe('file');
    expect(read.title).toBe('report.pdf');
    expect(read.text).toBe(viewer);
  });

  it('refuses a folder and a link that is not Drive', async () => {
    const tab = fakeTab({});
    await expect(service().read(tab, `https://drive.google.com/drive/folders/${ID}`, null)).rejects.toMatchObject({
      problem: 'folder',
    });
    await expect(service().read(tab, 'https://example.com/x', null)).rejects.toBeInstanceOf(DriveError);
    expect(tab.visited).toEqual([]);
  });

  it('creates a Doc, pastes the text in the page world and checks it was saved', async () => {
    const tab = fakeTab({
      redirect: url => (url.includes('/document/create') ? `https://docs.google.com/document/d/${ID}/edit` : url),
      probe: { ready: true, title: 'Untitled document', noAccess: false },
      fetch: () => reading({ text: 'Agenda\nOne' }),
    });
    const made = await service().createDoc(tab, { title: 'Agenda', content: 'Agenda\nOne', folder: null }, null);
    expect(tab.visited[0]).toBe('https://docs.google.com/document/create?title=Agenda');
    expect(tab.calls.find(call => call.func === 'renameDoc')?.arg).toMatchObject({ title: 'Agenda' });
    expect(tab.calls.find(call => call.func === 'pasteIntoDoc')?.options).toEqual({ world: 'MAIN' });
    expect(made).toEqual({
      file: { id: ID, title: 'Agenda', kind: 'document', link: `https://docs.google.com/document/d/${ID}/edit` },
      verified: true,
    });
  });

  it('shares only after the confirmation, with the title the page shows', async () => {
    const tab = fakeTab({ title: 'Q3 plan - Google Docs' });
    const confirm = vi.fn(async () => false);
    const declined = await service().share(
      tab,
      { file: `https://docs.google.com/document/d/${ID}/edit`, email: 'ada@x.com', role: 'editor' },
      null,
      confirm,
    );
    expect(confirm).toHaveBeenCalledWith("Share 'Q3 plan' with ada@x.com as editor");
    expect(declined.outcome).toBe('declined');
    // The dialog was filled in (which shares nothing), the focus put back in it for the card, and Send never pressed
    const names = tab.calls.map(call => call.func);
    expect(names).toContain('fillShareEmail');
    expect(names).toContain('pickShareRole');
    expect(names.indexOf('focusShareEmail')).toBeGreaterThan(names.indexOf('pickShareRole'));
    const clicks = tab.calls.filter(call => call.func === 'clickFirst');
    expect(clicks).toHaveLength(1);
    expect((clicks[0].arg as { selectors: string[] }).selectors).toEqual(sel.shareButton);

    const shared = await service().share(
      fakeTab({ title: 'Q3 plan - Google Docs' }),
      { file: `https://docs.google.com/document/d/${ID}/edit`, email: 'ada@x.com', role: 'editor' },
      null,
      async () => true,
    );
    expect(shared.outcome).toBe('shared');
  });
});
