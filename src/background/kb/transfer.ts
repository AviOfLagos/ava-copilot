import { z } from 'zod';
import { KB_EXPORT_FORMAT } from '@extension/storage';
import type { KbExport } from '@extension/storage';

const anchor = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('thread'), threadId: z.string(), seq: z.number() }),
  z.object({ kind: z.literal('meeting'), meetingId: z.string(), t: z.number() }),
  z.object({ kind: z.literal('page'), url: z.string() }),
  z.object({ kind: z.literal('note'), itemId: z.string() }),
]);

const item = z.object({
  id: z.string().min(1),
  sourceType: z.enum(['thread', 'meeting', 'page', 'note']),
  sourceId: z.string(),
  title: z.string(),
  url: z.string().default(''),
  sourceDate: z.number(),
  sourceUpdatedAt: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
  chunkCount: z.number().default(0),
  unembedded: z.number().default(0),
});

const chunk = z.object({
  id: z.string().min(1),
  itemId: z.string().min(1),
  index: z.number(),
  text: z.string(),
  label: z.string(),
  anchor,
  hash: z.string(),
  vector: z.array(z.number()).nullable(),
  embedModel: z.string().nullable(),
});

const kbExport = z.object({
  format: z.literal(KB_EXPORT_FORMAT),
  version: z.number(),
  exportedAt: z.number(),
  items: z.array(item),
  chunks: z.array(chunk),
});

/**
 * Checks a file the user is importing and returns it as a knowledge base export. Chunks of items
 * that are not in the file are dropped.
 *
 * @throws When the file is not a knowledge base export
 */
export function parseKbExport(data: unknown): KbExport {
  const parsed = kbExport.safeParse(data);
  if (!parsed.success) {
    throw new Error(`Not a knowledge base export: ${parsed.error.issues[0]?.message ?? 'invalid file'}`);
  }
  const ids = new Set(parsed.data.items.map(entry => entry.id));
  return { ...parsed.data, chunks: parsed.data.chunks.filter(entry => ids.has(entry.itemId)) } as KbExport;
}
