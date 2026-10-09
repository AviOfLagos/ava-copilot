import type { KnowledgeAnchor, MeetingNote, MeetingRecord, ThreadMessage, TranscriptSegment } from '@extension/storage';

// Characters per chunk: about 400 tokens, small enough for a citation to point somewhere useful
export const CHUNK_CHARS = 1600;
// Characters repeated from the end of one page chunk at the start of the next
export const PAGE_OVERLAP_CHARS = 200;
// A transcript chunk never spans more than this, so its timestamp stays close to every line in it
export const TRANSCRIPT_WINDOW_SECONDS = 120;

export interface DraftChunk {
  text: string;
  label: string;
  anchor: KnowledgeAnchor;
}

/** FNV-1a, enough to tell whether a chunk's text changed. */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Seconds as m:ss or h:mm:ss. */
export function clockLabel(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
}

/**
 * Splits text into pieces of at most `max` characters, breaking at paragraphs, then sentences,
 * then words, and repeating `overlap` characters between pieces.
 */
export function splitText(text: string, max = CHUNK_CHARS, overlap = 0): string[] {
  const clean = text
    .replace(/\r/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!clean) return [];
  if (clean.length <= max) return [clean];

  const pieces: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + max, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      // Prefer the last paragraph break, then sentence end, then space, in the second half
      const breaks = [window.lastIndexOf('\n\n'), window.search(/[.!?]\s[^.!?]*$/), window.lastIndexOf(' ')];
      const cut = breaks.find(index => index > max / 2);
      if (cut !== undefined) end = start + cut + 1;
    }
    const piece = clean.slice(start, end).trim();
    if (piece) pieces.push(piece);
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
    // Start the overlap at a word boundary
    if (overlap > 0) {
      const space = clean.indexOf(' ', start);
      if (space !== -1 && space < end) start = space + 1;
    }
  }
  return pieces;
}

/**
 * A chat as chunks of consecutive turns. Only what the user asked and what the copilot answered is
 * kept; step-by-step logs of clicks and typing are not worth searching.
 */
export function chunkThread(threadId: string, messages: ThreadMessage[]): DraftChunk[] {
  const turns = messages
    .filter(message => (message.actor === 'user' || message.actor === 'planner') && message.content.trim())
    .sort((a, b) => a.seq - b.seq);

  const chunks: DraftChunk[] = [];
  let lines: string[] = [];
  let firstSeq = 0;
  const flush = () => {
    if (lines.length === 0) return;
    chunks.push({
      text: lines.join('\n'),
      label: `message ${firstSeq}`,
      anchor: { kind: 'thread', threadId, seq: firstSeq },
    });
    lines = [];
  };

  for (const message of turns) {
    const speaker = message.actor === 'user' ? 'User' : 'Copilot';
    for (const piece of splitText(message.content)) {
      const line = `${speaker}: ${piece}`;
      if (lines.length > 0 && lines.join('\n').length + line.length + 1 > CHUNK_CHARS) {
        flush();
      }
      if (lines.length === 0) firstSeq = message.seq;
      lines.push(line);
    }
  }
  flush();
  return chunks;
}

/** The meeting note as text: what most questions about a meeting are answered from. */
export function noteText(note: MeetingNote): string {
  const list = (title: string, items: string[]) =>
    items.length ? `${title}:\n${items.map(item => `- ${item}`).join('\n')}` : '';
  return [
    note.title,
    list('Summary', note.tldr),
    list('Decisions', note.decisions),
    list(
      'Action items',
      note.actionItems.map(item => `${item.owner}: ${item.task}${item.due ? ` (due ${item.due})` : ''}`),
    ),
    list('Open questions', note.openQuestions),
    note.participants.length ? `Participants: ${note.participants.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * A meeting as chunks: the note first, then the transcript in windows of up to two minutes, each
 * anchored at the time its first line was said.
 */
export function chunkMeeting(
  meeting: Pick<MeetingRecord, 'id' | 'note'>,
  segments: Pick<TranscriptSegment, 'tStart' | 'speaker' | 'text'>[],
): DraftChunk[] {
  const chunks: DraftChunk[] = [];
  if (meeting.note) {
    for (const piece of splitText(noteText(meeting.note))) {
      chunks.push({ text: piece, label: 'note', anchor: { kind: 'meeting', meetingId: meeting.id, t: -1 } });
    }
  }

  let lines: string[] = [];
  let windowStart = 0;
  const flush = () => {
    if (lines.length === 0) return;
    chunks.push({
      text: lines.join('\n'),
      label: clockLabel(windowStart),
      anchor: { kind: 'meeting', meetingId: meeting.id, t: Math.floor(windowStart) },
    });
    lines = [];
  };

  for (const segment of [...segments].sort((a, b) => a.tStart - b.tStart)) {
    const text = segment.text.trim();
    if (!text) continue;
    const line = `[${clockLabel(segment.tStart)}] ${segment.speaker ? `${segment.speaker}: ` : ''}${text}`;
    const tooLong = lines.join('\n').length + line.length + 1 > CHUNK_CHARS;
    const tooLate = segment.tStart - windowStart > TRANSCRIPT_WINDOW_SECONDS;
    if (lines.length > 0 && (tooLong || tooLate)) flush();
    if (lines.length === 0) windowStart = segment.tStart;
    lines.push(line);
  }
  flush();
  return chunks;
}

/** A note as chunks, each citing the note. */
export function chunkNote(itemId: string, text: string): DraftChunk[] {
  return splitText(text, CHUNK_CHARS, PAGE_OVERLAP_CHARS).map((piece, index) => ({
    text: piece,
    label: `part ${index + 1}`,
    anchor: { kind: 'note', itemId },
  }));
}

/** A saved page as overlapping chunks, each citing the page URL. */
export function chunkPage(url: string, text: string): DraftChunk[] {
  return splitText(text, CHUNK_CHARS, PAGE_OVERLAP_CHARS).map((piece, index) => ({
    text: piece,
    label: `part ${index + 1}`,
    anchor: { kind: 'page', url },
  }));
}
