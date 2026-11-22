import { z } from 'zod';
import { stripTaskMarkers } from '@extension/storage';
import type { MeetingNote, NoteUpdate } from '@extension/storage';

/**
 * The meeting note's "Updates" section (docs/pm-desk.md, Part 9.1): what each person who gave an update on the call
 * said they did, are doing and will do next. The note's model fills it; everything after (who the name is, the
 * date the words name, which open task a "did" is) is code in ./updates.ts.
 */

const lines = (description: string) => z.array(z.string()).describe(description);

export const personUpdatesSchema = z
  .array(
    z.object({
      name: z.string().describe('the person who gave the update, as they are called on the call'),
      did: lines('what they said they have finished'),
      doing: lines('what they said they are working on now'),
      next: lines('what they said they will do next'),
      by: z.string().nullable().describe('when they said the next thing will be ready, as said ("Thursday"), or null'),
      blockers: lines('what they said is in their way'),
    }),
  )
  .describe('one entry per person who gave an update on their own work; empty when nobody did');

export const PERSON_UPDATES_INSTRUCTIONS = `Updates: one entry for each person who said, in their own words on the call, what they finished, what they are on now or what they will do next. Use the name they are called on the call. "did" is what they said is finished, "doing" what they are working on, "next" what comes next, "by" the day or date they gave for it as said, "blockers" what they said is in their way. Someone others only talk about gets no entry. If nobody gave an update, give an empty list. Keep each line short and in their words.`;

/** A list of a note's update lines as Markdown, every word cleared of task markers (a model wrote them). */
const plain = (text: string) => stripTaskMarkers(text.replace(/\s+/g, ' ').trim());

/** The "## Updates" section of a note, or nothing when no one gave an update. */
export function personUpdatesMarkdown(note: Pick<MeetingNote, 'personUpdates'>): string[] {
  const updates = (note.personUpdates ?? []).filter(hasWords);
  if (!updates.length) return [];
  const blocks = updates.map(update => {
    const rows = [
      ...update.did.map(item => `- Did: ${plain(item)}`),
      ...update.doing.map(item => `- Doing: ${plain(item)}`),
      ...update.next.map((item, index) =>
        index === update.next.length - 1 && update.by
          ? `- Next: ${plain(item)} (by ${plain(update.by)})`
          : `- Next: ${plain(item)}`,
      ),
      ...(update.next.length === 0 && update.by ? [`- Ready by: ${plain(update.by)}`] : []),
      ...update.blockers.map(item => `- Blocked: ${plain(item)}`),
    ];
    return [`**${plain(update.name)}**`, ...rows].join('\n');
  });
  return ['## Updates', blocks.join('\n\n')];
}

/** Whether an update says anything: a name with every list empty is not one. */
export function hasWords(update: Pick<NoteUpdate, 'did' | 'doing' | 'next' | 'blockers'>): boolean {
  return [update.did, update.doing, update.next, update.blockers].some(list => list.some(item => item.trim()));
}
