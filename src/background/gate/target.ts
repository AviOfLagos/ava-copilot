import { DOMElementNode } from '../browser/dom/views';
import type { DOMBaseNode } from '../browser/dom/views';
import { EMPTY_TARGET, looksLikeCaptcha } from './classify';
import type { GateTarget } from './classify';
import type { RawElement } from './probes';

const LABEL_ATTRIBUTES = ['aria-label', 'title', 'value', 'alt', 'placeholder', 'data-tooltip', 'data-original-title'];
const HINT_ATTRIBUTES = ['id', 'name', 'data-testid', 'data-test-id', 'data-qa', 'data-action'];
const SEARCH_PATTERN = /\bsearch\b/i;

const attributeOf = (attributes: Record<string, string>, name: string): string => String(attributes[name] ?? '').trim();

/**
 * Turns identifiers such as "sendButton" or "btn-send_msg" into words: "send Button", "btn send msg".
 */
export function identifierWords(identifier: string): string {
  return identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim();
}

function isSearchLike(raw: RawElement): boolean {
  const attr = (name: string) => attributeOf(raw.attributes, name);
  if (attr('type').toLowerCase() === 'search' || attr('role').toLowerCase() === 'searchbox') {
    return true;
  }
  if (attr('name').toLowerCase() === 'q') {
    return true;
  }
  if (
    [attr('name'), attr('placeholder'), attr('aria-label'), attr('id')].some(value =>
      SEARCH_PATTERN.test(identifierWords(value)),
    )
  ) {
    return true;
  }
  if (!raw.form) {
    return false;
  }
  const form = raw.form.attributes;
  return (
    attributeOf(form, 'role').toLowerCase() === 'search' ||
    SEARCH_PATTERN.test(
      identifierWords(`${attributeOf(form, 'action')} ${attributeOf(form, 'id')} ${attributeOf(form, 'class')}`),
    )
  );
}

/**
 * Turns an element, as read from the page or the DOM snapshot, into what the gate classifies.
 */
export function targetFromRaw(raw: RawElement | null | undefined): GateTarget {
  if (!raw) {
    return EMPTY_TARGET;
  }
  const attr = (name: string) => attributeOf(raw.attributes, name);

  return {
    tagName: raw.tagName.toLowerCase(),
    inputType: attr('type').toLowerCase(),
    role: attr('role').toLowerCase(),
    label: [raw.text, ...LABEL_ATTRIBUTES.map(attr)].filter(Boolean).join(' '),
    hints: HINT_ATTRIBUTES.map(name => identifierWords(attr(name)))
      .filter(Boolean)
      .join(' '),
    href: attr('href'),
    editable: raw.editable,
    inForm: raw.form !== null,
    searchLike: isSearchLike(raw),
    formHasPassword: raw.form?.hasPassword ?? false,
    // A CAPTCHA widget shows through an iframe from its provider, or a container named after it
    inCaptcha: looksLikeCaptcha(raw.ancestry),
  };
}

function hasPasswordField(node: DOMBaseNode): boolean {
  if (!(node instanceof DOMElementNode)) {
    return false;
  }
  if (node.tagName?.toLowerCase() === 'input' && attributeOf(node.attributes, 'type').toLowerCase() === 'password') {
    return true;
  }
  return node.children.some(hasPasswordField);
}

/**
 * Reads an element of the DOM snapshot in the same shape the page probes return.
 */
export function rawFromNode(node: DOMElementNode): RawElement {
  const chain: DOMElementNode[] = [];
  for (let current = node.parent; current !== null; current = current.parent) {
    chain.push(current);
  }
  const form = chain.find(ancestor => ancestor.tagName?.toLowerCase() === 'form');
  const editableValue = attributeOf(node.attributes, 'contenteditable').toLowerCase();
  const tagName = node.tagName?.toLowerCase() ?? '';
  const isField = tagName === 'input' || tagName === 'textarea';

  return {
    tagName,
    attributes: node.attributes,
    text: isField ? '' : node.getAllTextTillNextClickableElement(),
    editable: 'contenteditable' in node.attributes && editableValue !== 'false',
    form: form ? { attributes: form.attributes, hasPassword: hasPasswordField(form) } : null,
    ancestry: [node, ...chain]
      .map(element =>
        ['class', 'id', 'title', 'src']
          .map(name => attributeOf(element.attributes, name))
          .filter(Boolean)
          .join(' '),
      )
      .join(' '),
  };
}

/**
 * Describes the element an action targets from the DOM snapshot, for the gate to classify.
 */
export function describeTarget(node: DOMElementNode | null | undefined): GateTarget {
  return node ? targetFromRaw(rawFromNode(node)) : EMPTY_TARGET;
}
