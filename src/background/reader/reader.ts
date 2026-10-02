import { z } from 'zod';
import { ActionResult } from '../agent/types';
import type { AgentContext } from '../agent/types';
import type { ActionSchema } from '../agent/actions/schemas';
import { Actors, ExecutionState } from '../agent/event/types';
import { wrapUntrustedContent } from '../agent/messages/utils';
import { createLogger } from '../log';
import { readCanvasCoverage, readPageText } from './probes';
import type { PageTextSlice } from './probes';

const logger = createLogger('Reader');

// Characters of page text returned by one read_page_text call
export const PAGE_TEXT_CHUNK = 12_000;
// Above this share of the viewport on canvas, the element list alone does not show the page
export const CANVAS_VISION_THRESHOLD = 0.25;

export const readPageTextActionSchema = {
  name: 'read_page_text',
  description:
    'Read the text the current page shows, to read an article, email, table or document without scrolling. Returns one part at a time; pass the offset from the previous result to read on.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    offset: z.number().int().min(0).default(0).describe('character position to start reading from'),
  }),
} satisfies ActionSchema;

/**
 * Formats a slice of page text for the model, saying where it sits in the page and how to read on.
 */
export function describeSlice(slice: PageTextSlice): string {
  if (slice.total === 0) {
    return 'The page shows no text.';
  }
  const end = slice.offset + slice.text.length;
  const more =
    end < slice.total
      ? ` More text follows: call read_page_text with offset ${end}.`
      : ' This is the end of the page text.';
  return `Page text, characters ${slice.offset} to ${end} of ${slice.total}.${more}`;
}

/**
 * Handles the read_page_text action.
 */
export async function readPageTextAction(
  context: AgentContext,
  input: z.infer<typeof readPageTextActionSchema.schema>,
): Promise<ActionResult> {
  context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, input.intent || 'Reading the page text');
  const page = await context.browserContext.getCurrentPage();
  const slice = await page.evaluateInPage(readPageText, { offset: input.offset, max: PAGE_TEXT_CHUNK });
  const header = describeSlice(slice);
  context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, header);
  // Page text is data, never instructions. It is shown once; the model caches what it needs.
  return new ActionResult({
    extractedContent: slice.text ? `${header}\n${wrapUntrustedContent(slice.text)}` : header,
    includeInMemory: false,
  });
}

/**
 * Whether the page needs a screenshot for the model to see it: much of it is drawn on canvas.
 */
export async function needsVision(context: AgentContext): Promise<boolean> {
  try {
    const page = await context.browserContext.getCurrentPage();
    return (await page.evaluateInPage(readCanvasCoverage, undefined)) >= CANVAS_VISION_THRESHOLD;
  } catch (error) {
    logger.debug('Could not measure canvas coverage', error);
    return false;
  }
}

export const navigatorReaderSection = `
# READING PAGES:
- read_page_text returns the text the page shows. Use it to read articles, emails, tables and documents instead of scrolling through them. Cache what you need from it with cache_content, because its result is shown only once.
- When a screenshot is attached without being asked for, the page draws its content on a canvas (a spreadsheet or document editor). The element list cannot show that content; read it from the screenshot.
- When a suggestion list, mention menu or dialog opens, deal with it before anything else: pick the option you want, or close it with Escape.
`;
