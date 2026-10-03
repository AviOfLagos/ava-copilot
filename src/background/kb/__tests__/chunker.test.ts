import { describe, expect, it } from 'vitest';
import type { MeetingNote, ThreadMessage } from '@extension/storage';
import {
  CHUNK_CHARS,
  chunkMeeting,
  chunkPage,
  chunkThread,
  clockLabel,
  hashText,
  noteText,
  splitText,
  TRANSCRIPT_WINDOW_SECONDS,
} from '../chunker';

const message = (seq: number, actor: ThreadMessage['actor'], content: string): ThreadMessage => ({
  id: `m${seq}`,
  threadId: 't1',
  seq,
  actor,
  content,
  ts: seq,
});

const note: MeetingNote = {
  title: 'Stage 2 sync',
  tldr: ['Stage 2 moves to Friday'],
  decisions: ['Stage 2 deadline is Friday 10 October'],
  actionItems: [{ owner: 'Ada', task: 'Email the mentors', due: 'Thursday' }],
  openQuestions: [],
  participants: ['Ada', 'Avi'],
};

describe('hashText', () => {
  it('is stable and tells texts apart', () => {
    expect(hashText('hello')).toBe(hashText('hello'));
    expect(hashText('hello')).not.toBe(hashText('hello!'));
    expect(hashText('')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('clockLabel', () => {
  it('formats minutes and hours', () => {
    expect(clockLabel(0)).toBe('0:00');
    expect(clockLabel(724)).toBe('12:04');
    expect(clockLabel(3725)).toBe('1:02:05');
  });
});

describe('splitText', () => {
  it('keeps short text whole', () => {
    expect(splitText('  one paragraph  ')).toEqual(['one paragraph']);
    expect(splitText('   ')).toEqual([]);
  });

  it('cuts long text into pieces no longer than the limit, at sentence ends', () => {
    const text = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
    const pieces = splitText(text, 300);
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(300);
      expect(piece.endsWith('.')).toBe(true);
    }
    // Nothing is lost
    expect(pieces.join(' ').replace(/\s+/g, ' ')).toBe(text);
  });

  it('repeats the overlap at the start of the next piece', () => {
    const text = Array.from({ length: 80 }, (_, i) => `word${i}`).join(' ');
    const [first, second] = splitText(text, 200, 40);
    const lastWord = first.split(' ').at(-1)!;
    expect(second).toContain(lastWord);
  });
});

describe('chunkThread', () => {
  it('keeps what the user asked and the copilot answered, anchored at the first message', () => {
    const chunks = chunkThread('t1', [
      message(1, 'user', 'What is the Stage 2 deadline?'),
      message(2, 'navigator', 'Clicking element 4'),
      message(3, 'planner', 'It is Friday.'),
      message(4, 'system', 'Task cancelled'),
    ]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('User: What is the Stage 2 deadline?\nCopilot: It is Friday.');
    expect(chunks[0].anchor).toEqual({ kind: 'thread', threadId: 't1', seq: 1 });
    expect(chunks[0].label).toBe('message 1');
  });

  it('starts a new chunk when the next turn would not fit', () => {
    const long = 'x'.repeat(CHUNK_CHARS - 100);
    const chunks = chunkThread('t1', [message(1, 'user', long), message(2, 'planner', long)]);
    expect(chunks).toHaveLength(2);
    expect(chunks[1].anchor).toEqual({ kind: 'thread', threadId: 't1', seq: 2 });
  });

  it('has nothing to index in a chat without answers or questions', () => {
    expect(chunkThread('t1', [message(1, 'navigator', 'Scrolling')])).toEqual([]);
  });
});

describe('chunkMeeting', () => {
  it('puts the note first, then the transcript in windows with their start time', () => {
    const segments = [
      { tStart: 5, speaker: 'Ada', text: 'Welcome everyone.' },
      { tStart: 30, speaker: '', text: 'Stage 2 moves to Friday.' },
      { tStart: 30 + TRANSCRIPT_WINDOW_SECONDS + 10, speaker: 'Avi', text: 'Mentors need an email.' },
    ];
    const chunks = chunkMeeting({ id: 'm1', note }, segments);
    expect(chunks[0]).toMatchObject({ label: 'note', anchor: { kind: 'meeting', meetingId: 'm1', t: -1 } });
    expect(chunks[0].text).toContain('Ada: Email the mentors (due Thursday)');
    expect(chunks[1]).toMatchObject({ label: '0:05', anchor: { t: 5 } });
    expect(chunks[1].text).toBe('[0:05] Ada: Welcome everyone.\n[0:30] Stage 2 moves to Friday.');
    expect(chunks[2]).toMatchObject({ label: '2:40', anchor: { t: 160 } });
  });

  it('indexes a meeting without a note by its transcript alone', () => {
    const chunks = chunkMeeting({ id: 'm1', note: null }, [{ tStart: 1, speaker: '', text: 'Hello' }]);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].anchor).toEqual({ kind: 'meeting', meetingId: 'm1', t: 1 });
  });
});

describe('noteText', () => {
  it('leaves out empty sections', () => {
    const text = noteText(note);
    expect(text).toContain('Decisions:\n- Stage 2 deadline is Friday 10 October');
    expect(text).not.toContain('Open questions');
    expect(text).toContain('Participants: Ada, Avi');
  });
});

describe('chunkPage', () => {
  it('cites the page URL in every chunk', () => {
    const text = Array.from({ length: 400 }, (_, i) => `Paragraph ${i}.`).join('\n\n');
    const chunks = chunkPage('https://example.com/a', text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk => chunk.anchor.kind === 'page' && chunk.anchor.url === 'https://example.com/a')).toBe(
      true,
    );
    expect(chunks[1].label).toBe('part 2');
  });
});
