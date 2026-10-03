import type { TranscriptSegment } from '@extension/storage';

export interface ChunkWindow {
  index: number;
  tStart: number;
  tEnd: number;
}

// What a transcriber returns for one clip: times in seconds from the start of the clip
export interface ClipSegment {
  start: number;
  end: number;
  speaker: string;
  text: string;
}

/**
 * Places a clip's segments on the meeting's timeline and drops what a neighbouring chunk covers.
 * Chunks overlap; the middle of the overlap is the boundary. A segment belongs to the chunk its
 * midpoint falls in, so a sentence spoken across a boundary is kept once.
 *
 * @param isLast - The chunk has no successor, so it keeps everything up to its end
 */
export function placeSegments(
  clip: ClipSegment[],
  chunk: ChunkWindow,
  overlapSeconds: number,
  isLast: boolean,
): Omit<TranscriptSegment, 'id' | 'meetingId'>[] {
  const duration = chunk.tEnd - chunk.tStart;
  const lower = chunk.index > 0 ? chunk.tStart + overlapSeconds / 2 : -Infinity;
  const upper = isLast ? Infinity : chunk.tEnd - overlapSeconds / 2;

  return clip
    .filter(segment => segment.text.trim() !== '')
    .map(segment => {
      const start = Math.min(Math.max(segment.start, 0), duration);
      const end = Math.min(Math.max(segment.end, start), duration);
      return {
        tStart: chunk.tStart + start,
        tEnd: chunk.tStart + end,
        speaker: segment.speaker.trim(),
        text: segment.text.trim(),
        chunkIndex: chunk.index,
      };
    })
    .filter(segment => {
      const middle = (segment.tStart + segment.tEnd) / 2;
      return middle >= lower && middle < upper;
    });
}

const wordsOf = (text: string) => text.split(/\s+/).filter(Boolean);
const comparable = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');

/**
 * Joins the last line of one chunk to the first line of the next. A sentence spoken across a chunk
 * boundary is heard by both clips: the first stops mid-word ("mo-"), the second repeats some of
 * its words. The cut-off word goes, and so do the words the second line repeats.
 *
 * @param minWords - The fewest repeated words that count as an overlap rather than a coincidence
 * @returns The two lines to keep; `next` is '' when the second line only repeats the first
 */
export function stitchOverlap(previous: string, next: string, minWords = 2): { previous: string; next: string } {
  const before = wordsOf(previous);
  const after = wordsOf(next);
  // A word cut off at the end of a clip is dropped: the next clip has it whole
  const cut = before.length > 0 && /[-–…]$/.test(before[before.length - 1]);
  const kept = cut ? before.slice(0, -1) : before;

  for (let size = Math.min(kept.length, after.length); size >= minWords; size--) {
    const tail = kept.slice(-size).map(comparable).join(' ');
    const head = after.slice(0, size).map(comparable).join(' ');
    if (tail === head) {
      return { previous: kept.join(' '), next: after.slice(size).join(' ') };
    }
  }
  return { previous: cut ? kept.join(' ') : previous, next };
}

/**
 * Seconds as m:ss, or h:mm:ss past an hour.
 */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/**
 * A transcript as lines of "[m:ss] Speaker: text".
 */
export function transcriptText(segments: Pick<TranscriptSegment, 'tStart' | 'speaker' | 'text'>[]): string {
  return segments
    .map(segment => `[${formatClock(segment.tStart)}] ${segment.speaker ? `${segment.speaker}: ` : ''}${segment.text}`)
    .join('\n');
}

const PLATFORMS: [RegExp, string][] = [
  [/(^|\.)meet\.google\.com$/, 'Google Meet'],
  [/(^|\.)zoom\.(us|com)$/, 'Zoom'],
  [/(^|\.)teams\.(microsoft|live)\.com$/, 'Microsoft Teams'],
  [/(^|\.)webex\.com$/, 'Webex'],
  [/(^|\.)whereby\.com$/, 'Whereby'],
];

/**
 * The name of the meeting platform a page belongs to, or its host for anything else.
 */
export function platformOf(url: string): string {
  try {
    const host = new URL(url).hostname;
    return PLATFORMS.find(([pattern]) => pattern.test(host))?.[1] ?? host;
  } catch {
    return '';
  }
}

export function isKnownMeetingPlatform(url: string): boolean {
  const platform = platformOf(url);
  return PLATFORMS.some(([, name]) => name === platform);
}
