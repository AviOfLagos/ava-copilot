/**
 * Functions that run inside the page. Puppeteer sends each one as source text, so every function
 * here must be self-contained: no imports, no helpers from this file, no outer variables.
 */

export interface PageTextSlice {
  text: string;
  // Where this slice starts, and the length of the whole page text, in characters
  offset: number;
  total: number;
}

/**
 * Reads a slice of the text the page shows.
 */
export const readPageText = (range: { offset: number; max: number }): PageTextSlice => {
  const all = (document.body ? document.body.innerText : '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const offset = Math.max(0, Math.min(range.offset, all.length));
  return { text: all.slice(offset, offset + range.max), offset, total: all.length };
};

/**
 * Measures how much of the viewport is drawn on canvas, where the page has no elements to list.
 * Spreadsheets and document editors draw their content this way.
 *
 * @returns The share of the viewport covered by visible canvases, 0 to 1
 */
export const readCanvasCoverage = (): number => {
  const viewport = window.innerWidth * window.innerHeight;
  if (viewport === 0) {
    return 0;
  }
  let covered = 0;
  for (const canvas of Array.from(document.querySelectorAll('canvas'))) {
    const rect = canvas.getBoundingClientRect();
    const style = getComputedStyle(canvas);
    if (style.visibility === 'hidden' || style.display === 'none') {
      continue;
    }
    const width = Math.max(0, Math.min(rect.right, window.innerWidth) - Math.max(rect.left, 0));
    const height = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
    covered += width * height;
  }
  return Math.min(1, covered / viewport);
};
