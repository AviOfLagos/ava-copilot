/**
 * Functions that run inside the WhatsApp Web tab (chrome.scripting.executeScript). Each is self-contained
 * per CLAUDE.md: no imports, helpers or outer variables, so every one repeats its tiny `find` helper. They
 * take the selectors from the whatsapp-web skill as an argument and never hard-code the page's structure.
 * None of them sends anything except `clickSend` and `sendAttachment`, which the callers only reach after
 * the user's approval.
 */

type Sel = Record<string, string[]>;

export type WaPageState = 'logged_out' | 'loading' | 'ready' | 'chat_open' | 'invalid_number';

export interface WaProbe {
  state: WaPageState;
  header: string;
  composerText: string;
  outgoing: number;
}

/** What the tab shows right now. */
export const probePage = (arg: { sel: Sel }): WaProbe => {
  const find = (key: string, root: ParentNode = document): Element | null => {
    for (const selector of arg.sel[key] ?? []) {
      try {
        const found = root.querySelector(selector);
        if (found) return found;
      } catch {
        // A selector the browser does not understand: try the next
      }
    }
    return null;
  };
  const count = (key: string): number => {
    for (const selector of arg.sel[key] ?? []) {
      try {
        const found = document.querySelectorAll(selector).length;
        if (found) return found;
      } catch {
        // Next selector
      }
    }
    return 0;
  };
  const composer = find('composer');
  const header = find('chatHeader');
  const base = {
    header: (header?.getAttribute('title') || header?.textContent || '').trim(),
    composerText: (composer?.textContent || '').replace(/\u00a0/g, ' ').trim(),
    outgoing: count('outgoing'),
  };
  if (find('loggedOut') && !find('chatList')) return { state: 'logged_out', ...base };
  if (!composer && find('invalidNumber') && location.pathname.startsWith('/send')) {
    return { state: 'invalid_number', ...base };
  }
  if (composer) return { state: 'chat_open', ...base };
  if (find('chatList')) return { state: 'ready', ...base };
  return { state: 'loading', ...base };
};

export interface WaUnreadChat {
  name: string;
  preview: string;
  unread: string;
}

/** The chats WhatsApp marked unread in the chat list, without opening any of them. */
export const readUnreadChats = (arg: { sel: Sel; limit: number }): WaUnreadChat[] => {
  const findIn = (key: string, root: ParentNode): Element | null => {
    for (const selector of arg.sel[key] ?? []) {
      try {
        const found = root.querySelector(selector);
        if (found) return found;
      } catch {
        // Next selector
      }
    }
    return null;
  };
  const list = findIn('chatList', document);
  if (!list) return [];
  let rows: Element[] = [];
  for (const selector of arg.sel.chatRow ?? []) {
    try {
      rows = [...list.querySelectorAll(selector)];
    } catch {
      rows = [];
    }
    if (rows.length) break;
  }
  const out: WaUnreadChat[] = [];
  for (const row of rows) {
    const badge = findIn('rowUnread', row);
    if (!badge) continue;
    const title = findIn('rowTitle', row);
    const name = (title?.getAttribute('title') || title?.textContent || '').trim();
    if (!name) continue;
    const preview = findIn('rowPreview', row);
    out.push({
      name,
      preview: (preview?.getAttribute('title') || preview?.textContent || '').trim().slice(0, 300),
      unread: (badge.textContent || badge.getAttribute('aria-label') || '').trim().slice(0, 40),
    });
    if (out.length >= arg.limit) break;
  }
  return out;
};

/**
 * Opens a chat by its name through the search box, and waits until its header shows that name.
 * Async: chrome.scripting waits for the promise.
 */
export const openChatByName = async (arg: {
  sel: Sel;
  name: string;
}): Promise<{ ok: boolean; reason: string; header: string }> => {
  const find = (key: string, root: ParentNode = document): Element | null => {
    for (const selector of arg.sel[key] ?? []) {
      try {
        const found = root.querySelector(selector);
        if (found) return found;
      } catch {
        // Next selector
      }
    }
    return null;
  };
  const all = (key: string, root: ParentNode = document): Element[] => {
    for (const selector of arg.sel[key] ?? []) {
      try {
        const found = [...root.querySelectorAll(selector)];
        if (found.length) return found;
      } catch {
        // Next selector
      }
    }
    return [];
  };
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const norm = (text: string) => text.replace(/\s+/g, ' ').trim().toLowerCase();
  const wanted = norm(arg.name);
  const headerText = () => {
    const header = find('chatHeader');
    return (header?.getAttribute('title') || header?.textContent || '').trim();
  };
  if (norm(headerText()) === wanted) return { ok: true, reason: '', header: headerText() };

  const search = find('searchBox') as HTMLElement | null;
  if (!search) return { ok: false, reason: 'no_search', header: '' };
  search.focus();
  if (search instanceof HTMLInputElement) {
    search.value = arg.name;
    search.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    document.execCommand('selectAll', false);
    document.execCommand('insertText', false, arg.name);
  }

  const clickRow = (row: Element) => {
    const target = (row.closest('[role="listitem"], [role="row"]') as HTMLElement | null) ?? (row as HTMLElement);
    for (const type of ['mousedown', 'mouseup', 'click']) {
      target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
  };
  const deadline = Date.now() + 8000;
  let clicked = false;
  while (Date.now() < deadline) {
    if (!clicked) {
      const list = find('chatList') ?? document;
      const row = all('chatRow', list).find(candidate => {
        const title = find('rowTitle', candidate);
        return norm(title?.getAttribute('title') || title?.textContent || '') === wanted;
      });
      if (row) {
        clickRow(row);
        clicked = true;
      }
    }
    if (norm(headerText()) === wanted && find('composer')) return { ok: true, reason: '', header: headerText() };
    await sleep(200);
  }
  return { ok: false, reason: clicked ? 'not_opened' : 'not_found', header: headerText() };
};

export interface WaMessage {
  from: 'them' | 'me';
  text: string;
}

/** The last messages of the open chat, oldest first. */
export const readOpenChat = (arg: { sel: Sel; limit: number }): WaMessage[] => {
  const findIn = (key: string, root: ParentNode): Element | null => {
    for (const selector of arg.sel[key] ?? []) {
      try {
        const found = root.querySelector(selector);
        if (found) return found;
      } catch {
        // Next selector
      }
    }
    return null;
  };
  const selectors = (arg.sel.message ?? []).join(', ');
  let nodes: Element[] = [];
  try {
    nodes = selectors ? [...document.querySelectorAll(selectors)] : [];
  } catch {
    nodes = [];
  }
  const outgoing = (arg.sel.outgoing ?? []).join(', ');
  return nodes.slice(-arg.limit).map(node => {
    const textEl = findIn('messageText', node) ?? node;
    let mine = false;
    try {
      mine = outgoing ? node.matches(outgoing) || node.closest(outgoing) !== null : false;
    } catch {
      mine = false;
    }
    return { from: mine ? 'me' : 'them', text: (textEl.textContent || '').trim().slice(0, 1000) };
  });
};

/** Puts text in the open chat's message box, replacing what is there, and leaves the box focused. Sends nothing. */
export const typeInComposer = (arg: { sel: Sel; text: string }): { ok: boolean; text: string } => {
  let composer: HTMLElement | null = null;
  for (const selector of arg.sel.composer ?? []) {
    try {
      composer = document.querySelector(selector);
    } catch {
      composer = null;
    }
    if (composer) break;
  }
  if (!composer) return { ok: false, text: '' };
  composer.focus();
  document.execCommand('selectAll', false);
  document.execCommand('delete', false);
  const lines = arg.text.split('\n');
  lines.forEach((line, index) => {
    if (index > 0) document.execCommand('insertLineBreak', false);
    if (line) document.execCommand('insertText', false, line);
  });
  return { ok: true, text: (composer.textContent || '').replace(/\u00a0/g, ' ').trim() };
};

/** Clicks the send button of the open chat. Only called after the user approved this message. */
export const clickSend = (arg: { sel: Sel }): boolean => {
  for (const selector of arg.sel.sendButton ?? []) {
    try {
      const found = document.querySelector(selector) as HTMLElement | null;
      const button = (found?.closest('button, [role="button"]') as HTMLElement | null) ?? found;
      if (button) {
        button.click();
        return true;
      }
    } catch {
      // Next selector
    }
  }
  return false;
};

/**
 * Pastes one file into the open chat, types the caption and sends it. Runs in the page's own world, so
 * WhatsApp sees an ordinary paste. Only called after the user approved the batch.
 */
export const sendAttachment = async (arg: {
  sel: Sel;
  name: string;
  type: string;
  base64: string;
  caption: string;
}): Promise<boolean> => {
  const find = (key: string): HTMLElement | null => {
    for (const selector of arg.sel[key] ?? []) {
      try {
        const found = document.querySelector(selector) as HTMLElement | null;
        if (found) return found;
      } catch {
        // Next selector
      }
    }
    return null;
  };
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  const composer = find('composer');
  if (!composer) return false;
  const bytes = Uint8Array.from(atob(arg.base64), char => char.charCodeAt(0));
  const file = new File([bytes], arg.name, { type: arg.type || 'application/octet-stream' });
  const data = new DataTransfer();
  data.items.add(file);
  composer.focus();
  composer.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  const deadline = Date.now() + 15000;
  let caption: HTMLElement | null = null;
  while (Date.now() < deadline && !caption) {
    caption = find('mediaCaption');
    if (!caption) await sleep(250);
  }
  if (!caption) return false;
  if (arg.caption) {
    caption.focus();
    document.execCommand('insertText', false, arg.caption);
  }
  await sleep(300);
  const send = find('mediaSend');
  const button = (send?.closest('button, [role="button"]') as HTMLElement | null) ?? send;
  if (!button) return false;
  button.click();
  return true;
};
