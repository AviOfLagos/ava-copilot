/**
 * Google Drive and Docs addresses: reading a link the user pasted (or a bare file id), and building the
 * addresses the feature opens, each with the Google account to act as. Pure, so it is tested on its own.
 *
 * Checked against Google's public pages and links on 2026-10-16: `/document/d/<id>/export?format=txt`,
 * `/spreadsheets/d/<id>/export?format=csv&gid=<n>`, `/presentation/d/<id>/export/txt`, `/document/d/<id>/mobilebasic`,
 * `drive.google.com/open?id=<id>`, `drive/search?q=`, `drive/folders/<id>`, `/u/<n>/` and `authuser=`.
 */

export type DriveKind = 'document' | 'spreadsheet' | 'presentation' | 'folder' | 'file';

export interface DriveRef {
  id: string;
  // Unknown for a bare id: opening it tells
  kind: DriveKind | null;
  // A sheet's tab
  gid?: string;
}

// Drive ids are URL-safe base64; real ones are 19 to 44+ characters (older ones start with "0B")
const ID = '[A-Za-z0-9_-]{10,128}';
const ID_ONLY = new RegExp(`^${ID}$`);

const DRIVE_HOSTS = new Set(['drive.google.com', 'docs.google.com']);

/** Whether an address is a Drive or Docs page (any account). */
export function isDriveUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && DRIVE_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}

/** Whether Google sent the tab to its sign-in or account chooser. */
export function isSignInUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.hostname === 'accounts.google.com' || /\/ServiceLogin\b/.test(parsed.pathname);
  } catch {
    return false;
  }
}

const KIND_OF_SEGMENT: Record<string, DriveKind> = {
  document: 'document',
  spreadsheets: 'spreadsheet',
  presentation: 'presentation',
  forms: 'file',
  drawings: 'file',
};

/**
 * The file a link or id names, or null when it names none. Takes editor links (`/document/d/<id>/edit`, with
 * `/u/<n>/`), viewer links (`/file/d/<id>/view`), `open?id=`, `uc?id=`, folder links, and a bare id.
 */
export function parseDriveRef(input: string): DriveRef | null {
  const text = input.trim();
  if (ID_ONLY.test(text)) return { id: text, kind: null };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !DRIVE_HOSTS.has(url.hostname)) return null;
  const path = url.pathname.replace(/\/u\/\d+\//, '/');
  const editor = new RegExp(`^/(document|spreadsheets|presentation|forms|drawings)/d/(${ID})(?:/|$)`).exec(path);
  if (editor) {
    const ref: DriveRef = { id: editor[2], kind: KIND_OF_SEGMENT[editor[1]] };
    const gid = /(?:^|[#&?])gid=(\d+)/.exec(`${url.search}${url.hash}`)?.[1];
    if (ref.kind === 'spreadsheet' && gid) ref.gid = gid;
    return ref;
  }
  const file = new RegExp(`^/file/d/(${ID})(?:/|$)`).exec(path);
  if (file) return { id: file[1], kind: 'file' };
  const folder = new RegExp(`^/drive/(?:[\\w-]+/)*folders/(${ID})(?:/|$)`).exec(path);
  if (folder) return { id: folder[1], kind: 'folder' };
  const id = url.searchParams.get('id');
  if (id && ID_ONLY.test(id) && /^\/(open|uc)$/.test(path)) return { id, kind: null };
  return null;
}

/** Adds the account to act as: `authuser=<email>` works on every Drive and Docs address. */
export function withAccount(url: string, account: string | null | undefined): string {
  const email = account?.trim();
  if (!email) return url;
  const parsed = new URL(url);
  parsed.searchParams.set('authuser', email);
  return parsed.href;
}

const enc = encodeURIComponent;

/** The page that opens a file the way Google shows it. */
export function openUrl(ref: DriveRef, account?: string | null): string {
  const base = (() => {
    switch (ref.kind) {
      case 'document':
        return `https://docs.google.com/document/d/${enc(ref.id)}/edit`;
      case 'spreadsheet':
        return `https://docs.google.com/spreadsheets/d/${enc(ref.id)}/edit${ref.gid ? `#gid=${ref.gid}` : ''}`;
      case 'presentation':
        return `https://docs.google.com/presentation/d/${enc(ref.id)}/edit`;
      case 'folder':
        return `https://drive.google.com/drive/folders/${enc(ref.id)}`;
      case 'file':
        return `https://drive.google.com/file/d/${enc(ref.id)}/view`;
      default:
        return `https://drive.google.com/open?id=${enc(ref.id)}`;
    }
  })();
  // authuser goes before the hash
  if (!account) return base;
  const [head, hash] = base.split('#');
  return `${withAccount(head, account)}${hash ? `#${hash}` : ''}`;
}

/** The link kept with a saved file: the plain editor or viewer address, no account. */
export function canonicalLink(ref: DriveRef): string {
  return openUrl(ref);
}

/** Where a Google file's text comes from: Docs as text, Sheets as CSV, Slides as text. Null for other files. */
export function exportUrl(ref: DriveRef, account?: string | null): string | null {
  switch (ref.kind) {
    case 'document':
      return withAccount(`https://docs.google.com/document/d/${enc(ref.id)}/export?format=txt`, account);
    case 'spreadsheet':
      return withAccount(
        `https://docs.google.com/spreadsheets/d/${enc(ref.id)}/export?format=csv${ref.gid ? `&gid=${ref.gid}` : ''}`,
        account,
      );
    case 'presentation':
      return withAccount(`https://docs.google.com/presentation/d/${enc(ref.id)}/export/txt`, account);
    default:
      return null;
  }
}

/** A Doc's light, readable page: plain HTML text, used when the export cannot be fetched. */
export function mobileBasicUrl(id: string, account?: string | null): string {
  return withAccount(`https://docs.google.com/document/d/${enc(id)}/mobilebasic`, account);
}

/** A plain file's bytes (text files only are read from it). */
export function downloadUrl(id: string, account?: string | null): string {
  return withAccount(`https://drive.google.com/uc?export=download&id=${enc(id)}`, account);
}

export function searchUrl(query: string, account?: string | null): string {
  return withAccount(`https://drive.google.com/drive/search?q=${enc(query.trim())}`, account);
}

export function folderUrl(folder: string | null, account?: string | null): string {
  const ref = folder ? parseDriveRef(folder) : null;
  return withAccount(
    ref ? `https://drive.google.com/drive/folders/${enc(ref.id)}` : 'https://drive.google.com/drive/my-drive',
    account,
  );
}

export function createDocUrl(title: string, folderId: string | null, account?: string | null): string {
  const params = new URLSearchParams({ title: title.trim() });
  if (folderId) params.set('folder', folderId);
  return withAccount(`https://docs.google.com/document/create?${params.toString()}`, account);
}

/** "Q3 plan - Google Docs" → "Q3 plan". */
export function cleanTitle(title: string | undefined): string {
  return (title ?? '').replace(/\s+[-–]\s+Google (Docs|Sheets|Slides|Drive|Forms|Drawings)$/i, '').trim();
}
