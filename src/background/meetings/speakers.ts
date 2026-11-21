import { cleanName, nameKey } from '@extension/storage';
import type { SpeakerMark, TranscriptSegment } from '@extension/storage';

/**
 * Who said what, in code (docs/pm-desk.md 5.3). When notes come from the tab's audio, Meet's captions are read
 * alongside for their speaker names only: each caption line leaves a mark of who spoke when, and each audio
 * segment takes the speaker whose marks overlap it most. A segment no mark overlaps keeps what the audio said
 * ("Speaker 1", or nothing). No model is asked.
 */

// The most marks kept for one meeting (a two-hour call of short turns fits)
export const MAX_SPEAKER_MARKS = 4000;
// The most names kept on a meeting's roster
export const MAX_ROSTER = 100;
// A caption reaches us about a second and a half after its words were spoken; marks are widened by this
const SLACK_SECONDS = 2;

/** Marks for caption lines read at `now` (seconds from the start), placed as the caption watcher places lines. */
export function speakerMarks(
  lines: { speaker: string; text: string }[],
  now: number,
  charsPerSecond: number,
): SpeakerMark[] {
  return lines
    .filter(line => cleanName(line.speaker) && line.text.trim())
    .map(line => ({
      t0: Math.max(0, now - Math.max(1, line.text.length / charsPerSecond)),
      t1: now,
      speaker: cleanName(line.speaker),
    }));
}

/** Adds marks, keeping the newest when there are too many. */
export function addMarks(marks: SpeakerMark[], fresh: SpeakerMark[]): SpeakerMark[] {
  const next = [...marks, ...fresh];
  return next.length > MAX_SPEAKER_MARKS ? next.slice(-MAX_SPEAKER_MARKS) : next;
}

/** The speaker whose marks overlap a stretch of time the most, or null when none does. */
export function speakerFor(tStart: number, tEnd: number, marks: SpeakerMark[]): string | null {
  const overlap = new Map<string, number>();
  for (const mark of marks) {
    const from = Math.max(tStart, mark.t0 - SLACK_SECONDS);
    const to = Math.min(tEnd, mark.t1 + SLACK_SECONDS);
    if (to > from) overlap.set(mark.speaker, (overlap.get(mark.speaker) ?? 0) + (to - from));
  }
  let best: string | null = null;
  let most = 0;
  for (const [speaker, seconds] of overlap) {
    if (seconds > most) {
      best = speaker;
      most = seconds;
    }
  }
  return best;
}

/**
 * The audio segments whose speaker the captions name, with that name. Caption lines themselves (chunkIndex -1)
 * already carry Meet's name and are left alone.
 */
export function nameSegments(
  segments: Pick<TranscriptSegment, 'id' | 'tStart' | 'tEnd' | 'speaker' | 'chunkIndex'>[],
  marks: SpeakerMark[],
): { id: string; speaker: string }[] {
  if (marks.length === 0) return [];
  const changes: { id: string; speaker: string }[] = [];
  for (const segment of segments) {
    if (segment.chunkIndex < 0) continue;
    const speaker = speakerFor(segment.tStart, segment.tEnd, marks);
    if (speaker && speaker !== segment.speaker) changes.push({ id: segment.id, speaker });
  }
  return changes;
}

/** The roster with newly read names added: one entry per name, however its case or accents differ. */
export function mergeRoster(roster: string[], names: string[]): string[] {
  const next = [...roster];
  const keys = new Set(roster.map(nameKey));
  for (const name of names) {
    const clean = cleanName(name);
    const key = nameKey(clean);
    if (!key || keys.has(key) || next.length >= MAX_ROSTER) continue;
    keys.add(key);
    next.push(clean);
  }
  return next;
}

/** Whether a speaker label is one the audio made up rather than a name: "Speaker 2", "Unknown", "". */
export const isGenericSpeaker = (speaker: string | null | undefined) =>
  !speaker || /^(speaker\s*\d*|unknown|participant\s*\d*|\?)$/i.test(speaker.trim());
