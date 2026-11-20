import type { ConfirmField } from '@extension/storage';

/**
 * Functions that run inside the page. Puppeteer sends each one as source text, so every function
 * here must be self-contained: no imports, no helpers from this file, no outer variables.
 */

// An element as the page sees it, before the gate classifies it
export interface RawElement {
  tagName: string;
  attributes: Record<string, string>;
  // The text the element shows
  text: string;
  editable: boolean;
  // The form around the element, if any
  form: { attributes: Record<string, string>; hasPassword: boolean } | null;
  // The class, id, title and src of the element and each ancestor, joined
  ancestry: string;
  // The element sits in a spreadsheet or data grid, where Enter and Delete edit cells
  inGrid?: boolean;
}

export interface FocusReading {
  // 'frame' means focus is inside an iframe, which the page cannot see into
  where: 'element' | 'body' | 'frame';
  element: RawElement | null;
}

export interface CommitContent {
  fields: ConfirmField[];
  // Text of the dialog around the control, when there is one
  context: string;
}

export interface CommitEffect {
  url: string;
  // Per snippet: how many times the text shows on the page outside any editor
  visible: number[];
  // Per snippet: the text is still sitting in an editor
  pending: boolean[];
}

/**
 * Reads the element that has keyboard focus.
 */
export const readFocus = (): FocusReading => {
  let el: Element | null = document.activeElement;
  while (el && el.shadowRoot && el.shadowRoot.activeElement) {
    el = el.shadowRoot.activeElement;
  }
  if (!el || el === document.body || el === document.documentElement) {
    return { where: 'body', element: null };
  }
  if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
    return { where: 'frame', element: null };
  }

  const attributesOf = (node: Element): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const name of node.getAttributeNames()) {
      out[name] = node.getAttribute(name) ?? '';
    }
    return out;
  };

  const ancestry: string[] = [];
  for (let node: Element | null = el; node; node = node.parentElement) {
    ancestry.push(
      [node.getAttribute('class'), node.getAttribute('id'), node.getAttribute('title'), node.getAttribute('src')]
        .filter(Boolean)
        .join(' '),
    );
  }

  const form = el.closest('form');
  const isField = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;
  // Google Sheets edits cells in a contenteditable box outside its grid, so its page is matched too
  const inGrid =
    el.closest('[role="grid"], [role="treegrid"], [role="gridcell"]') !== null ||
    /(^|\s)(cell-input|waffle-rich-text-editor)(\s|$)/.test(ancestry.join(' ')) ||
    (location.hostname === 'docs.google.com' && location.pathname.startsWith('/spreadsheets/'));
  return {
    where: 'element',
    element: {
      tagName: el.tagName.toLowerCase(),
      attributes: attributesOf(el),
      // The text of a field is its content, not its label, so it is left out here
      text:
        isField || (el instanceof HTMLElement && el.isContentEditable)
          ? ''
          : (el.textContent ?? '').trim().slice(0, 200),
      editable: el instanceof HTMLElement && el.isContentEditable,
      form: form
        ? { attributes: attributesOf(form), hasPassword: form.querySelector('input[type="password"]') !== null }
        : null,
      ancestry: ancestry.join(' '),
      inGrid,
    },
  };
};

/**
 * Reads back what an action would commit: the filled fields of the form around the control, or the
 * nearest editor when there is no form (a chat composer). Pass null to start from the focused element.
 */
export const readCommitContent = (start: Element | null): CommitContent => {
  const MAX_VALUE = 2000;
  const MAX_FIELDS = 30;
  const FIELD_SELECTOR =
    'input, textarea, select, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]';

  const clip = (text: string, max: number): string => {
    const clean = text.replace(/\u00a0/g, ' ').trim();
    return clean.length > max ? `${clean.slice(0, max)}…` : clean;
  };

  let el: Element | null = start;
  if (!el) {
    el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) {
      el = el.shadowRoot.activeElement;
    }
  }
  if (!el) {
    return { fields: [], context: '' };
  }

  const isVisible = (node: Element): boolean => {
    const rect = node.getBoundingClientRect();
    const style = getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };

  const labelOf = (field: Element): string => {
    const id = field.getAttribute('id');
    const byFor = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    const labelledBy = field.getAttribute('aria-labelledby');
    const byAria = labelledBy
      ? labelledBy
          .split(/\s+/)
          .map(part => document.getElementById(part)?.textContent ?? '')
          .join(' ')
      : '';
    const label =
      byFor?.textContent ||
      field.closest('label')?.textContent ||
      field.getAttribute('aria-label') ||
      byAria ||
      field.getAttribute('placeholder') ||
      field.getAttribute('name') ||
      '';
    return clip(label, 80);
  };

  // The value a field would commit; null for a field that commits nothing
  const valueOf = (field: Element): string | null => {
    if (field instanceof HTMLInputElement) {
      const type = field.type.toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset'].includes(type)) {
        return null;
      }
      if (type === 'password') {
        // A password is never read back
        return field.value ? '••••••' : null;
      }
      if (type === 'checkbox' || type === 'radio') {
        return field.checked ? field.value || 'on' : null;
      }
      if (type === 'file') {
        return Array.from(field.files ?? [])
          .map(file => file.name)
          .join(', ');
      }
      return field.value;
    }
    if (field instanceof HTMLTextAreaElement) {
      return field.value;
    }
    if (field instanceof HTMLSelectElement) {
      return Array.from(field.selectedOptions)
        .map(option => (option.textContent ?? '').trim())
        .join(', ');
    }
    if (field instanceof HTMLElement && field.isContentEditable) {
      return field.innerText;
    }
    return null;
  };

  const collect = (root: Element): { label: string; value: string }[] => {
    const fields: { label: string; value: string }[] = [];
    const candidates = root.matches(FIELD_SELECTOR) ? [root] : Array.from(root.querySelectorAll(FIELD_SELECTOR));
    for (const field of candidates) {
      if (fields.length >= MAX_FIELDS || !isVisible(field)) {
        continue;
      }
      const value = valueOf(field);
      if (value === null || value.trim() === '') {
        continue;
      }
      fields.push({ label: labelOf(field), value: clip(value, MAX_VALUE) });
    }
    return fields;
  };

  let fields: { label: string; value: string }[] = [];
  const form = el.closest('form');
  if (form) {
    fields = collect(form);
  } else {
    // No form: look for the editor the control belongs to, starting at the control and widening
    let scope: Element | null = el.closest('[contenteditable]') ?? el;
    for (let depth = 0; scope && depth < 7 && fields.length === 0; depth++) {
      fields = collect(scope);
      scope = scope.parentElement;
    }
  }

  const dialog = el.closest('[role="dialog"], [role="alertdialog"], dialog');
  const context = dialog instanceof HTMLElement ? clip(dialog.innerText, 600) : '';
  return { fields, context };
};

/**
 * Reads the label of a live element, to check it is still the control the user approved.
 */
export const readLiveLabel = (el: Element): string => {
  const text =
    (el instanceof HTMLElement ? el.innerText : el.textContent) ||
    (el instanceof HTMLInputElement ? el.value : '') ||
    el.getAttribute('aria-label') ||
    el.getAttribute('title') ||
    '';
  return text.replace(/\s+/g, ' ').trim();
};

/**
 * Reads where the given texts show on the page. Read before and after a committed action,
 * the difference tells whether the action took effect.
 */
export const readCommitEffect = (snippets: string[]): CommitEffect => {
  const normalize = (text: string): string => text.replace(/\s+/g, ' ').trim();
  const count = (haystack: string, needle: string): number => (needle ? haystack.split(needle).length - 1 : 0);

  const editors = Array.from(
    document.querySelectorAll(
      'input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]',
    ),
  );
  const editorValues = editors.map(editor =>
    editor instanceof HTMLInputElement || editor instanceof HTMLTextAreaElement
      ? editor.value
      : editor instanceof HTMLElement
        ? editor.innerText
        : '',
  );
  // The page text includes rich-text editors but not input values
  const pageText = normalize(document.body ? document.body.innerText : '');
  const richEditorText = normalize(
    editors
      .filter(editor => editor instanceof HTMLElement && editor.isContentEditable)
      .map(editor => (editor as HTMLElement).innerText)
      .join(' \n '),
  );
  const allEditorText = normalize(editorValues.join(' \n '));

  return {
    url: location.href,
    visible: snippets.map(snippet => {
      const needle = normalize(snippet);
      return count(pageText, needle) - count(richEditorText, needle);
    }),
    pending: snippets.map(snippet => allEditorText.includes(normalize(snippet))),
  };
};
