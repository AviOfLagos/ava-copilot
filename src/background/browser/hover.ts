/**
 * Controls that only show on hover (Pinterest's per-pin "Save", a card's "Delete", a row's "Edit").
 * The page state lists what is visible, so these never appear in it. Two parts:
 *  - `findHiddenControls` runs in the page and reads controls that are in the DOM and in view but invisible
 *    (opacity 0, visibility hidden), with the chain of ancestors above each.
 *  - `matchHoverHosts` / `formatHoverHints` (plain code) turn that into one short line per element the model can
 *    hover: "[12] reveals: Save, Share".
 */

// What the page reports for one hidden control
export interface HiddenControl {
  label: string;
  // The control's own XPath: one that already has an index is offered to the model and needs no hint
  xpath: string;
  // XPaths of the ancestors, nearest first, in the same form as DOMElementNode.xpath
  ancestors: string[];
}

export interface HoverHint {
  index: number;
  labels: string[];
}

const MAX_HINTS = 8;
const MAX_LABELS = 3;
// How far up to look for an indexed element inside an ancestor
const NEAR_ANCESTORS = 3;

/**
 * Runs inside the page. Puppeteer sends it as source text, so it must stay self-contained: no imports, no
 * helpers, no outer variables.
 */
export const findHiddenControls = (): HiddenControl[] => {
  const found: HiddenControl[] = [];
  const vw = window.innerWidth || document.documentElement.clientWidth;
  const vh = window.innerHeight || document.documentElement.clientHeight;

  const position = (el: Element): number => {
    const parent = el.parentElement;
    if (!parent) return 0;
    const tag = el.nodeName.toLowerCase();
    const same = Array.from(parent.children).filter(s => s.nodeName.toLowerCase() === tag);
    return same.length === 1 ? 0 : same.indexOf(el) + 1;
  };
  const xpathOf = (el: Element): string => {
    const segments: string[] = [];
    let cur: Node | null = el;
    while (cur && cur.nodeType === Node.ELEMENT_NODE) {
      if (cur.parentNode instanceof ShadowRoot || cur.parentNode instanceof HTMLIFrameElement) break;
      const e = cur as Element;
      const pos = position(e);
      segments.unshift(`${e.nodeName.toLowerCase()}${pos > 0 ? `[${pos}]` : ''}`);
      cur = cur.parentNode;
    }
    return segments.join('/');
  };
  // Opacity multiplies down the tree, so an ancestor at 0 hides the control too
  const invisible = (el: Element): boolean => {
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden') return true;
    for (let node: Element | null = el, depth = 0; node && depth < 8; node = node.parentElement, depth++) {
      if (parseFloat(getComputedStyle(node).opacity) < 0.05) return true;
    }
    return false;
  };

  const candidates = document.querySelectorAll(
    'button, a[href], [role="button"], [role="menuitem"], [role="link"], [tabindex="0"]',
  );
  let scanned = 0;
  for (const el of Array.from(candidates)) {
    if (found.length >= 60 || ++scanned > 400) break;
    const rect = el.getBoundingClientRect();
    if (rect.width < 8 || rect.height < 8) continue;
    // Only what is on screen now: something off screen is for scrolling, not hovering
    if (rect.bottom < 0 || rect.right < 0 || rect.top > vh || rect.left > vw) continue;
    if (!invisible(el)) continue;
    if ((el as HTMLElement).getAttribute('aria-hidden') === 'true') continue;
    const label = (
      el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      (el as HTMLElement).innerText ||
      el.textContent ||
      ''
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 30);
    if (!label) continue;
    const ancestors: string[] = [];
    for (let p = el.parentElement; p && p !== document.body && ancestors.length < 8; p = p.parentElement) {
      ancestors.push(xpathOf(p));
    }
    found.push({ label, xpath: xpathOf(el), ancestors });
  }
  return found;
};

/**
 * Groups hidden controls under the element the model can hover (one that has an index): the nearest ancestor that
 * has one, or else the first indexed element inside one of the closest ancestors (a pin's link sits next to its
 * Save button, not around it). Equal labels under one host are listed once.
 */
export function matchHoverHosts(controls: HiddenControl[], indexByXpath: Map<string, number>): HoverHint[] {
  const indexed = [...indexByXpath.entries()].sort((a, b) => a[1] - b[1]);
  const hostOf = (control: HiddenControl): number | undefined => {
    for (const xpath of control.ancestors) {
      const exact = indexByXpath.get(xpath);
      if (exact !== undefined) return exact;
    }
    for (const xpath of control.ancestors.slice(0, NEAR_ANCESTORS)) {
      const inside = indexed.find(([candidate]) => candidate.startsWith(`${xpath}/`));
      if (inside) return inside[1];
    }
    return undefined;
  };
  const byIndex = new Map<number, string[]>();
  for (const control of controls) {
    if (indexByXpath.has(control.xpath)) continue;
    const host = hostOf(control);
    if (host === undefined) continue;
    const labels = byIndex.get(host) ?? [];
    if (!labels.includes(control.label)) labels.push(control.label);
    byIndex.set(host, labels);
  }
  return [...byIndex.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(0, MAX_HINTS)
    .map(([index, labels]) => ({ index, labels: labels.slice(0, MAX_LABELS) }));
}

/** One short block for the state message; empty when nothing is hidden. */
export function formatHoverHints(hints: HoverHint[]): string {
  if (hints.length === 0) return '';
  const lines = hints.map(hint => `[${hint.index}] reveals: ${hint.labels.join(', ')}`);
  return `[Hidden until hover: use hover_element on the index, then click what appears]\n${lines.join('\n')}`;
}
