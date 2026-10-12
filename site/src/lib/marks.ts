/*
 * Monochrome brand marks from simple-icons (CC0), looked up at build time and drawn inline in `currentColor`: no
 * image requests, no colour of their own. Where simple-icons has no mark (it removed some at their owners'
 * request), the page shows the name as text instead. The marks stay their owners'; the page says so.
 */
import * as icons from 'simple-icons';

interface SimpleIcon {
  title: string;
  path: string;
}

const table = icons as unknown as Record<string, SimpleIcon | undefined>;

/** The mark's SVG path for a simple-icons slug (`googledrive`), or null when there is none. */
export function mark(slug: string | null | undefined): SimpleIcon | null {
  if (!slug) return null;
  const key = `si${slug[0].toUpperCase()}${slug.slice(1)}`;
  const icon = table[key];
  return icon && typeof icon.path === 'string' ? { title: icon.title, path: icon.path } : null;
}
