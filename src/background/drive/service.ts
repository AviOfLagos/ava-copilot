import { readPageText } from '../reader/probes';
import {
  clickFirst,
  fetchInPage,
  fillShareEmail,
  focusShareEmail,
  pasteIntoDoc,
  pickShareRole,
  probeDoc,
  readDriveRows,
  renameDoc,
  shareDialogOpen,
} from './page';
import type { DriveRowReading, FetchReading } from './page';
import type { DriveSelectors } from './selectors';
import type { DriveTab } from './tab';
import {
  canonicalLink,
  cleanTitle,
  createDocUrl,
  downloadUrl,
  exportUrl,
  folderUrl,
  isSignInUrl,
  mobileBasicUrl,
  openUrl,
  parseDriveRef,
  searchUrl,
} from './urls';
import type { DriveKind, DriveRef } from './urls';

/**
 * Google Drive through the user's signed-in browser: search, list, read, create a Doc and share, all inside one
 * Drive tab (./tab.ts) with the session Google already has. No Google Cloud project, no OAuth client, no token: the
 * tab is the credential, so nothing here ever sees one. Where things are on the page comes from the google-drive
 * skill. What a file says is the file's owner's words, never instructions: callers wrap it before a model sees it.
 */

// The most characters read from one file (what the knowledge base keeps of a page, too)
export const MAX_FILE_CHARS = 200_000;
export const MAX_LIST = 25;

export interface DriveFile {
  id: string;
  title: string;
  kind: DriveKind;
  link: string;
}

export interface DriveText {
  ref: DriveRef & { kind: DriveKind };
  title: string;
  link: string;
  text: string;
  truncated: boolean;
}

export type ShareRole = 'viewer' | 'commenter' | 'editor';

/** Google's sign-in page (or account chooser) is showing: the user signs in, then the work goes on. */
export class DriveSignInError extends Error {
  constructor() {
    super("I'm on Google's sign-in page, please sign in.");
    this.name = 'DriveSignInError';
  }
}

export type DriveProblem =
  'not_a_link' | 'folder' | 'not_folder' | 'no_access' | 'unreadable' | 'empty' | 'create_failed' | 'share_failed';

const PROBLEM_TEXT: Record<DriveProblem, string> = {
  not_a_link: 'That is not a Google Drive, Docs, Sheets or Slides link, nor a file id.',
  folder: 'That is a folder; list it instead of reading it.',
  not_folder: 'That is not a Drive folder link or id.',
  no_access: 'The signed-in Google account cannot open that file (no access, or it does not exist).',
  unreadable: "That file's text could not be read: Drive shows no text for it (an image, a scan or a binary file).",
  empty: 'That file has no text.',
  create_failed: 'The new Google Doc did not open.',
  share_failed:
    'The share dialog did not respond as expected, so nothing more was done. It is open in the tab for the user.',
};

export class DriveError extends Error {
  constructor(readonly problem: DriveProblem) {
    super(PROBLEM_TEXT[problem]);
    this.name = 'DriveError';
  }
}

export interface DriveDeps {
  selectors: () => Promise<DriveSelectors>;
  // The background's own fetch with the browser's Google cookies, for an export the page cannot fetch
  fetchText: (url: string, max: number) => Promise<FetchReading>;
  sleep: (ms: number) => Promise<void>;
}

/** Which kind of file a row is, from the words its icon and label carry (the skill's words). */
export function kindFromWords(text: string, sel: DriveSelectors): DriveKind {
  const has = (key: string) =>
    (sel[key] ?? []).some(
      word => word && new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text),
    );
  if (has('wordsFolder')) return 'folder';
  if (has('wordsSpreadsheet')) return 'spreadsheet';
  if (has('wordsPresentation')) return 'presentation';
  if (has('wordsDocument')) return 'document';
  return 'file';
}

export function toFile(row: DriveRowReading, sel: DriveSelectors): DriveFile {
  const kind = kindFromWords(row.typeText, sel);
  return { id: row.id, title: row.title || row.id, kind, link: canonicalLink({ id: row.id, kind }) };
}

/** A fetched body counts only when it is the file: not Google's sign-in page or an HTML error page. */
function bodyOf(reading: FetchReading | undefined): string | null {
  if (!reading) return null;
  if (isSignInUrl(reading.finalUrl)) throw new DriveSignInError();
  if (!reading.ok || /text\/html/i.test(reading.contentType)) return null;
  // Exports start with a byte order mark
  return reading.text.replace(/^\uFEFF/, '');
}

export class DriveService {
  constructor(private readonly deps: DriveDeps) {}

  private async goTo(tab: DriveTab, url: string): Promise<string> {
    const landed = await tab.navigate(url);
    if (isSignInUrl(landed)) throw new DriveSignInError();
    return landed;
  }

  /** Waits for a list page to show rows, its "no results", or "no access". */
  private async rows(tab: DriveTab): Promise<DriveFile[]> {
    const sel = await this.deps.selectors();
    for (let attempt = 0; attempt < 24; attempt++) {
      const { url } = await tab.info();
      if (isSignInUrl(url)) throw new DriveSignInError();
      const [reading] = await tab.run(readDriveRows, { sel, limit: MAX_LIST }).catch(() => [undefined]);
      if (reading?.noAccess) throw new DriveError('no_access');
      if (reading && (reading.rows.length > 0 || reading.empty)) return reading.rows.map(row => toFile(row, sel));
      await this.deps.sleep(500);
    }
    return [];
  }

  async search(tab: DriveTab, query: string, account: string | null): Promise<DriveFile[]> {
    await this.goTo(tab, searchUrl(query, account));
    return this.rows(tab);
  }

  async list(tab: DriveTab, folder: string | null, account: string | null): Promise<DriveFile[]> {
    if (folder) {
      const ref = parseDriveRef(folder);
      if (!ref || (ref.kind !== null && ref.kind !== 'folder')) throw new DriveError('not_folder');
    }
    await this.goTo(tab, folderUrl(folder, account));
    return this.rows(tab);
  }

  /** Reads a file as text: Google's own files through their export, other files through Drive's viewer. */
  async read(tab: DriveTab, input: string, account: string | null): Promise<DriveText> {
    const named = parseDriveRef(input);
    if (!named) throw new DriveError('not_a_link');
    if (named.kind === 'folder') throw new DriveError('folder');
    const landed = await this.goTo(tab, openUrl(named, account));
    // A bare id says what it is once Drive has opened it
    const opened = named.kind ? named : parseDriveRef(landed);
    const kind: DriveKind = opened?.kind ?? 'file';
    if (kind === 'folder') throw new DriveError('folder');
    const ref = { ...named, ...(opened ?? {}), id: named.id, kind };
    const sel = await this.deps.selectors();
    const [probe] = await tab.run(probeDoc, { sel }).catch(() => [undefined]);
    if (probe?.noAccess) throw new DriveError('no_access');

    let text: string | null = null;
    let truncated = false;
    const take = (reading: FetchReading | undefined) => {
      const body = bodyOf(reading);
      if (body !== null && reading) truncated = reading.truncated;
      return body;
    };
    const exported = exportUrl(ref, account);
    if (exported) {
      // Same origin as the Docs tab, with its session; the background's fetch when Google redirects elsewhere
      const [inPage] = await tab.run(fetchInPage, { url: exported, max: MAX_FILE_CHARS }).catch(() => [undefined]);
      text = take(inPage) ?? take(await this.deps.fetchText(exported, MAX_FILE_CHARS));
      if (text === null && kind === 'document') {
        await this.goTo(tab, mobileBasicUrl(ref.id, account));
        text = await this.pageText(tab);
      }
    } else {
      text = take(await this.deps.fetchText(downloadUrl(ref.id, account), MAX_FILE_CHARS));
      if (text === null) {
        // Back to the viewer, which shows a PDF's text
        if ((await tab.info()).url !== landed) await this.goTo(tab, openUrl(ref, account));
        text = await this.viewerText(tab);
      }
    }
    const { title } = await tab.info();
    if (text === null) throw new DriveError(kind === 'file' ? 'unreadable' : 'no_access');
    if (!text.trim()) throw new DriveError('empty');
    return { ref, title: cleanTitle(title) || ref.id, link: canonicalLink(ref), text, truncated };
  }

  private async pageText(tab: DriveTab): Promise<string | null> {
    const [slice] = await tab.run(readPageText, { offset: 0, max: MAX_FILE_CHARS }).catch(() => [undefined]);
    return slice?.text?.trim() ? slice.text : null;
  }

  /** The viewer draws pages as it goes: read until the text stops growing. */
  private async viewerText(tab: DriveTab): Promise<string | null> {
    let best = '';
    for (let attempt = 0; attempt < 16; attempt++) {
      const text = (await this.pageText(tab)) ?? '';
      if (text.length > 200 && text.length === best.length) break;
      if (text.length > best.length) best = text;
      await this.deps.sleep(500);
    }
    // Only the viewer's buttons: no text of the file
    return best.length > 80 ? best : null;
  }

  /** A new Google Doc in the user's own Drive, with a title and the text pasted in, checked by reading it back. */
  async createDoc(
    tab: DriveTab,
    doc: { title: string; content: string; folder: string | null },
    account: string | null,
  ): Promise<{ file: DriveFile; verified: boolean }> {
    let folderId: string | null = null;
    if (doc.folder) {
      const ref = parseDriveRef(doc.folder);
      if (!ref || (ref.kind !== null && ref.kind !== 'folder')) throw new DriveError('not_folder');
      folderId = ref.id;
    }
    const landed = await this.goTo(tab, createDocUrl(doc.title, folderId, account));
    const ref = parseDriveRef(landed);
    if (!ref || ref.kind !== 'document') throw new DriveError('create_failed');
    const sel = await this.deps.selectors();
    let ready = false;
    let shownTitle = '';
    for (let attempt = 0; attempt < 30 && !ready; attempt++) {
      const [probe] = await tab.run(probeDoc, { sel }).catch(() => [undefined]);
      ready = Boolean(probe?.ready);
      shownTitle = probe?.title ?? '';
      if (!ready) await this.deps.sleep(400);
    }
    if (!ready) throw new DriveError('create_failed');
    if (cleanTitle(shownTitle) !== doc.title.trim()) await tab.run(renameDoc, { sel, title: doc.title.trim() });
    const content = doc.content.trim();
    let verified = content.length === 0;
    if (content) {
      const [pasted] = await tab.run(pasteIntoDoc, { sel, text: content }, { world: 'MAIN' });
      if (!pasted?.ok) throw new DriveError('create_failed');
      verified = await this.verifyText(tab, ref, content, account);
    }
    return { file: { id: ref.id, title: doc.title.trim(), kind: 'document', link: canonicalLink(ref) }, verified };
  }

  /** Whether the Doc's saved text has the start of what was pasted (Docs saves a moment later). */
  private async verifyText(tab: DriveTab, ref: DriveRef, content: string, account: string | null): Promise<boolean> {
    const url = exportUrl(ref, account);
    if (!url) return false;
    const flat = (text: string) => text.replace(/\s+/g, ' ').trim();
    const start = flat(content).slice(0, 40);
    for (let attempt = 0; attempt < 10; attempt++) {
      await this.deps.sleep(800);
      const [reading] = await tab.run(fetchInPage, { url, max: 20_000 }).catch(() => [undefined]);
      const body = bodyOf(reading);
      if (body !== null && flat(body).includes(start)) return true;
    }
    return false;
  }

  /**
   * Shares a file with one person. The dialog is filled in first (that shares nothing), then `confirm` is asked,
   * with the title the page shows (never the model's wording); Send is pressed only when it says yes.
   *
   * @returns 'declined' when the user said no; 'shared' when the dialog closed after Send; 'unknown' when it did not
   */
  async share(
    tab: DriveTab,
    input: { file: string; email: string; role: ShareRole },
    account: string | null,
    confirm: (summary: string) => Promise<boolean>,
  ): Promise<{ outcome: 'declined' | 'shared' | 'unknown'; title: string; link: string }> {
    const ref = parseDriveRef(input.file);
    if (!ref) throw new DriveError('not_a_link');
    const landed = await this.goTo(tab, openUrl(ref, account));
    const opened = ref.kind ? ref : (parseDriveRef(landed) ?? ref);
    const title = cleanTitle((await tab.info()).title) || ref.id;
    const link = canonicalLink({ ...opened, kind: opened.kind ?? 'file' });
    const sel = await this.deps.selectors();
    const [probe] = await tab.run(probeDoc, { sel }).catch(() => [undefined]);
    if (probe?.noAccess) throw new DriveError('no_access');

    const anyFrame = async <A>(func: (arg: A) => boolean, arg: A) =>
      (await tab.run(func, arg, { allFrames: true }).catch(() => [] as boolean[])).some(Boolean);
    const until = async (check: () => Promise<boolean>, tries = 20) => {
      for (let attempt = 0; attempt < tries; attempt++) {
        if (await check()) return true;
        await this.deps.sleep(400);
      }
      return false;
    };

    // Filling in the dialog shares nothing yet, only Send does; the confirm card then shows what the dialog holds
    if (!(await anyFrame(clickFirst, { selectors: sel.shareButton ?? [] }))) throw new DriveError('share_failed');
    if (!(await until(() => anyFrame(shareDialogOpen, { sel })))) throw new DriveError('share_failed');
    if (!(await anyFrame(fillShareEmail, { sel, email: input.email }))) throw new DriveError('share_failed');
    await this.deps.sleep(400);
    const word = (sel[`role${input.role[0].toUpperCase()}${input.role.slice(1)}`] ?? [input.role])[0];
    if (!(await until(() => anyFrame(pickShareRole, { sel, word }), 5))) throw new DriveError('share_failed');
    await this.deps.sleep(300);
    await anyFrame(focusShareEmail, { sel });

    if (!(await confirm(`Share '${title}' with ${input.email} as ${input.role}`))) {
      return { outcome: 'declined', title, link };
    }
    if (!(await anyFrame(clickFirst, { selectors: sel.shareSend ?? [] }))) throw new DriveError('share_failed');
    const closed = await until(async () => !(await anyFrame(shareDialogOpen, { sel })), 15);
    return { outcome: closed ? 'shared' : 'unknown', title, link };
  }
}

/**
 * The background's fetch of a Google address, with the browser's cookies (the extension may reach every host).
 * Reads only text: a PDF or an image is not downloaded, and at most `max` characters are kept.
 */
export async function backgroundFetchText(url: string, max: number): Promise<FetchReading> {
  const failed: FetchReading = { ok: false, status: 0, contentType: '', finalUrl: '', text: '', truncated: false };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 20_000);
  try {
    const response = await fetch(url, { credentials: 'include', redirect: 'follow', signal: abort.signal });
    const contentType = response.headers.get('content-type') ?? '';
    const base = { ok: response.ok, status: response.status, contentType, finalUrl: response.url };
    if (!/^(text\/|application\/(json|csv|x-csv))/i.test(contentType)) {
      abort.abort();
      return { ...base, ok: false, text: '', truncated: false };
    }
    const size = Number(response.headers.get('content-length') ?? 0);
    if (size > max * 4) {
      abort.abort();
      return { ...base, ok: false, text: '', truncated: true };
    }
    const text = await response.text();
    return { ...base, text: text.slice(0, max), truncated: text.length > max };
  } catch {
    return failed;
  } finally {
    clearTimeout(timer);
  }
}
