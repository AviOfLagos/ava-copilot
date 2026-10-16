import { describe, expect, it } from 'vitest';
import {
  canonicalLink,
  cleanTitle,
  createDocUrl,
  exportUrl,
  folderUrl,
  isDriveUrl,
  isSignInUrl,
  openUrl,
  parseDriveRef,
  searchUrl,
  withAccount,
} from '../urls';

const ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-xy';

describe('parseDriveRef', () => {
  it('reads editor links, with or without /u/<n>/ and a sheet tab', () => {
    expect(parseDriveRef(`https://docs.google.com/document/d/${ID}/edit?usp=sharing`)).toEqual({
      id: ID,
      kind: 'document',
    });
    expect(parseDriveRef(`https://docs.google.com/document/u/1/d/${ID}/edit`)).toEqual({ id: ID, kind: 'document' });
    expect(parseDriveRef(`https://docs.google.com/spreadsheets/d/${ID}/edit#gid=42`)).toEqual({
      id: ID,
      kind: 'spreadsheet',
      gid: '42',
    });
    expect(parseDriveRef(`https://docs.google.com/presentation/d/${ID}/edit#slide=id.p`)).toEqual({
      id: ID,
      kind: 'presentation',
    });
  });

  it('reads viewer, folder and open links, and a bare id', () => {
    expect(parseDriveRef(`https://drive.google.com/file/d/${ID}/view?usp=drive_link`)).toEqual({
      id: ID,
      kind: 'file',
    });
    expect(parseDriveRef(`https://drive.google.com/drive/u/0/folders/${ID}`)).toEqual({ id: ID, kind: 'folder' });
    expect(parseDriveRef(`https://drive.google.com/open?id=${ID}`)).toEqual({ id: ID, kind: null });
    expect(parseDriveRef(`  ${ID}  `)).toEqual({ id: ID, kind: null });
  });

  it('refuses other sites, plain http and things that are not files', () => {
    expect(parseDriveRef(`https://evil.example/document/d/${ID}/edit`)).toBeNull();
    expect(parseDriveRef(`http://docs.google.com/document/d/${ID}/edit`)).toBeNull();
    expect(parseDriveRef('https://drive.google.com/drive/my-drive')).toBeNull();
    expect(parseDriveRef('hello world')).toBeNull();
    expect(parseDriveRef(`https://docs.google.com.evil.example/document/d/${ID}/edit`)).toBeNull();
  });
});

describe('addresses', () => {
  it('builds export addresses per kind', () => {
    expect(exportUrl({ id: ID, kind: 'document' })).toBe(`https://docs.google.com/document/d/${ID}/export?format=txt`);
    expect(exportUrl({ id: ID, kind: 'spreadsheet', gid: '7' })).toBe(
      `https://docs.google.com/spreadsheets/d/${ID}/export?format=csv&gid=7`,
    );
    expect(exportUrl({ id: ID, kind: 'presentation' })).toBe(`https://docs.google.com/presentation/d/${ID}/export/txt`);
    expect(exportUrl({ id: ID, kind: 'file' })).toBeNull();
  });

  it('adds the account as authuser, before a hash', () => {
    expect(withAccount('https://drive.google.com/drive/my-drive', 'ada@x.com')).toBe(
      'https://drive.google.com/drive/my-drive?authuser=ada%40x.com',
    );
    expect(withAccount('https://drive.google.com/drive/my-drive', null)).toBe(
      'https://drive.google.com/drive/my-drive',
    );
    expect(openUrl({ id: ID, kind: 'spreadsheet', gid: '3' }, 'ada@x.com')).toBe(
      `https://docs.google.com/spreadsheets/d/${ID}/edit?authuser=ada%40x.com#gid=3`,
    );
    expect(openUrl({ id: ID, kind: null })).toBe(`https://drive.google.com/open?id=${ID}`);
  });

  it('builds search, folder and new-Doc addresses', () => {
    expect(searchUrl(' q3 plan ', 'ada@x.com')).toBe(
      'https://drive.google.com/drive/search?q=q3+plan&authuser=ada%40x.com',
    );
    expect(folderUrl(null)).toBe('https://drive.google.com/drive/my-drive');
    expect(folderUrl(`https://drive.google.com/drive/folders/${ID}`)).toBe(
      `https://drive.google.com/drive/folders/${ID}`,
    );
    expect(createDocUrl('Q3 plan', ID)).toBe(`https://docs.google.com/document/create?title=Q3+plan&folder=${ID}`);
  });

  it('keeps a plain link without the account', () => {
    expect(canonicalLink({ id: ID, kind: 'document' })).toBe(`https://docs.google.com/document/d/${ID}/edit`);
  });

  it('tells Drive pages and the sign-in page apart', () => {
    expect(isDriveUrl('https://docs.google.com/document/d/x/edit')).toBe(true);
    expect(isDriveUrl('https://mail.google.com/')).toBe(false);
    expect(isSignInUrl('https://accounts.google.com/v3/signin/identifier?continue=x')).toBe(true);
    expect(isSignInUrl('https://drive.google.com/drive/my-drive')).toBe(false);
  });

  it('cleans the tab title', () => {
    expect(cleanTitle('Q3 plan - Google Docs')).toBe('Q3 plan');
    expect(cleanTitle('report.pdf - Google Drive')).toBe('report.pdf');
  });
});
