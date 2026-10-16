/**
 * Functions run inside a Drive or Docs tab with chrome.scripting.executeScript. Each runs from its own source
 * text in the page, so it must not use imports, helpers or variables from outside itself (see
 * src/background/gate/probes.ts). Selectors come in as arguments, from the google-drive skill.
 */

type Sel = Record<string, string[]>;

export interface DriveRowReading {
  id: string;
  title: string;
  // Words describing the type (an icon's label, the row's aria-label), matched against the skill's words
  typeText: string;
}

export interface DriveListReading {
  rows: DriveRowReading[];
  empty: boolean;
  noAccess: boolean;
}

/** The files a Drive list (My Drive, a folder, search results) shows, top to bottom. */
export function readDriveRows(arg: { sel: Sel; limit: number }): DriveListReading {
  const all = (keys: string[] | undefined, root: ParentNode = document): Element[] => {
    for (const selector of keys ?? []) {
      try {
        const found = root.querySelectorAll(selector);
        if (found.length) return [...found];
      } catch {
        // A selector the browser cannot read is skipped
      }
    }
    return [];
  };
  const textOf = (element: Element | undefined | null): string =>
    (element?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const seen = new Set<string>();
  const rows: DriveRowReading[] = [];
  for (const row of all(arg.sel.row)) {
    const id = row.getAttribute('data-id') ?? '';
    if (!/^[A-Za-z0-9_-]{10,128}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const label = row.getAttribute('aria-label') ?? '';
    const name = textOf(all(arg.sel.rowName, row)[0]) || label || textOf(row).split(' · ')[0];
    const typeBits = all(arg.sel.rowType, row)
      .slice(0, 4)
      .map(
        el =>
          el.getAttribute('data-drive-type') ||
          el.getAttribute('aria-label') ||
          el.getAttribute('alt') ||
          el.getAttribute('data-tooltip') ||
          '',
      )
      .join(' ');
    rows.push({ id, title: name.slice(0, 300), typeText: `${typeBits} ${label}`.slice(0, 400) });
    if (rows.length >= arg.limit) break;
  }
  return { rows, empty: all(arg.sel.emptyResults).length > 0, noAccess: all(arg.sel.noAccess).length > 0 };
}

export interface FetchReading {
  ok: boolean;
  status: number;
  contentType: string;
  finalUrl: string;
  text: string;
  truncated: boolean;
}

/**
 * Fetches an address from the page, with the page's own Google session (same origin: a Docs tab fetching a Docs
 * export). Reads at most `max` characters. A failure (a redirect another origin refuses, the network) comes back
 * as ok: false, status 0.
 */
export async function fetchInPage(arg: { url: string; max: number }): Promise<FetchReading> {
  try {
    const response = await fetch(arg.url, { credentials: 'include', redirect: 'follow' });
    const contentType = response.headers.get('content-type') ?? '';
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      contentType,
      finalUrl: response.url,
      text: text.slice(0, arg.max),
      truncated: text.length > arg.max,
    };
  } catch {
    return { ok: false, status: 0, contentType: '', finalUrl: '', text: '', truncated: false };
  }
}

export interface DocProbe {
  ready: boolean;
  title: string;
  noAccess: boolean;
}

/** Whether the Docs editor is ready to type in, and the title it shows. */
export function probeDoc(arg: { sel: Sel }): DocProbe {
  const first = (keys: string[] | undefined): Element | null => {
    for (const selector of keys ?? []) {
      try {
        const found = document.querySelector(selector);
        if (found) return found;
      } catch {
        // skipped
      }
    }
    return null;
  };
  const target = first(arg.sel.docsTextTarget) as HTMLIFrameElement | null;
  let ready = false;
  try {
    ready = Boolean(target?.contentDocument?.body);
  } catch {
    ready = false;
  }
  const titleInput = first(arg.sel.docsTitle) as HTMLInputElement | null;
  return { ready, title: titleInput?.value ?? document.title, noAccess: first(arg.sel.noAccess) !== null };
}

/** Gives the open Doc a title, through its title box. */
export function renameDoc(arg: { sel: Sel; title: string }): boolean {
  let input: HTMLInputElement | null = null;
  for (const selector of arg.sel.docsTitle ?? []) {
    try {
      input = document.querySelector(selector) as HTMLInputElement | null;
    } catch {
      input = null;
    }
    if (input) break;
  }
  if (!input) return false;
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(input, arg.title);
  else input.value = arg.title;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  input.blur();
  return true;
}

/**
 * Puts text into the open Doc at the cursor, as a paste into the editor's hidden text box: Docs inserts pasted
 * text as typed text. Runs in the page's own world, so the editor's listeners see the paste's data.
 */
export function pasteIntoDoc(arg: { sel: Sel; text: string }): { ok: boolean; reason?: string } {
  let frame: HTMLIFrameElement | null = null;
  for (const selector of arg.sel.docsTextTarget ?? []) {
    try {
      frame = document.querySelector(selector) as HTMLIFrameElement | null;
    } catch {
      frame = null;
    }
    if (frame) break;
  }
  const doc = frame?.contentDocument;
  if (!doc?.body) return { ok: false, reason: 'no_editor' };
  const target = (doc.querySelector('[contenteditable="true"]') as HTMLElement | null) ?? doc.body;
  target.focus();
  const data = new DataTransfer();
  data.setData('text/plain', arg.text);
  const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return { ok: true };
}

/** Clicks the first visible element a selector list finds, in this frame. */
export function clickFirst(arg: { selectors: string[] }): boolean {
  for (const selector of arg.selectors) {
    let found: Element[] = [];
    try {
      found = [...document.querySelectorAll(selector)];
    } catch {
      continue;
    }
    const visible = found.find(el => {
      const box = (el as HTMLElement).getBoundingClientRect?.();
      return box && box.width > 0 && box.height > 0;
    });
    if (visible) {
      (visible as HTMLElement).click();
      return true;
    }
  }
  return false;
}

/** Types an address into the share dialog's people box and turns it into a chip (Enter). Any frame. */
export function fillShareEmail(arg: { sel: Sel; email: string }): boolean {
  let input: HTMLInputElement | null = null;
  for (const selector of arg.sel.shareEmail ?? []) {
    try {
      input = document.querySelector(selector) as HTMLInputElement | null;
    } catch {
      input = null;
    }
    if (input) break;
  }
  if (!input) return false;
  input.focus();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (setter) setter.call(input, arg.email);
  else input.value = arg.email;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
  return true;
}

/** Opens the role menu of the share dialog and picks the role named by `word`. Any frame. */
export function pickShareRole(arg: { sel: Sel; word: string }): boolean {
  const first = (keys: string[] | undefined): HTMLElement | null => {
    for (const selector of keys ?? []) {
      try {
        const found = document.querySelector(selector) as HTMLElement | null;
        if (found) return found;
      } catch {
        // skipped
      }
    }
    return null;
  };
  const button = first(arg.sel.shareRoleButton);
  if (!button) return false;
  if ((button.textContent ?? '').trim().toLowerCase() === arg.word.toLowerCase()) return true;
  button.click();
  for (const selector of arg.sel.shareRoleOption ?? []) {
    let options: HTMLElement[] = [];
    try {
      options = [...document.querySelectorAll(selector)] as HTMLElement[];
    } catch {
      continue;
    }
    const option = options.find(el => (el.textContent ?? '').trim().toLowerCase().startsWith(arg.word.toLowerCase()));
    if (option) {
      option.click();
      return true;
    }
  }
  return false;
}

/** Whether the share dialog is open (shown) in this frame. */
export function shareDialogOpen(arg: { sel: Sel }): boolean {
  for (const selector of arg.sel.shareEmail ?? []) {
    try {
      const input = document.querySelector(selector);
      const box = input?.getBoundingClientRect();
      if (box && box.width > 0 && box.height > 0) return true;
    } catch {
      // skipped
    }
  }
  return false;
}

/** Puts the focus back in the share dialog's people box, so the confirm card reads the dialog. Any frame. */
export function focusShareEmail(arg: { sel: Sel }): boolean {
  for (const selector of arg.sel.shareEmail ?? []) {
    try {
      const input = document.querySelector(selector) as HTMLElement | null;
      if (input) {
        input.focus();
        return true;
      }
    } catch {
      // skipped
    }
  }
  return false;
}
