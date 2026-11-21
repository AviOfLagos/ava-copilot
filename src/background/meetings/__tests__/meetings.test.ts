import { describe, expect, it } from 'vitest';
import { blocksOf, meetingContext, noteToMarkdown } from '../notes';
import {
  formatClock,
  isKnownMeetingPlatform,
  placeSegments,
  platformOf,
  stitchOverlap,
  transcriptText,
} from '../segments';

const clip = (start: number, end: number, text: string, speaker = 'Speaker 1') => ({ start, end, speaker, text });

describe('placeSegments', () => {
  // Chunks of 30 s overlapping by 2 s: the second covers 28-58 s, the boundary is at 29 s
  const first = { index: 0, tStart: 0, tEnd: 30 };
  const second = { index: 1, tStart: 28, tEnd: 58 };

  it('moves clip times onto the meeting timeline', () => {
    expect(placeSegments([clip(5, 8, 'Hello')], second, 2, false)).toEqual([
      { tStart: 33, tEnd: 36, speaker: 'Speaker 1', text: 'Hello', chunkIndex: 1 },
    ]);
  });

  it('keeps a sentence spoken across a boundary exactly once', () => {
    // The same words, heard at the end of the first chunk and the start of the second
    const fromFirst = placeSegments([clip(27.5, 29.5, 'across the line')], first, 2, false);
    const fromSecond = placeSegments([clip(-0.5, 1.5, 'across the line')], second, 2, false);
    expect(fromFirst.length + fromSecond.length).toBe(1);
  });

  it('drops what the neighbouring chunks cover', () => {
    expect(placeSegments([clip(29.2, 29.9, 'tail')], first, 2, false)).toEqual([]);
    expect(placeSegments([clip(0, 0.8, 'head')], second, 2, false)).toEqual([]);
  });

  it('keeps everything to the end in the last chunk', () => {
    expect(placeSegments([clip(29.2, 29.9, 'tail')], first, 2, true)).toHaveLength(1);
  });

  it('clamps times the model got wrong, and skips empty text', () => {
    const placed = placeSegments([clip(-3, 99, 'wide'), clip(4, 5, '  ')], first, 2, true);
    expect(placed).toEqual([{ tStart: 0, tEnd: 30, speaker: 'Speaker 1', text: 'wide', chunkIndex: 0 }]);
  });
});

describe('formatting', () => {
  it('formats clock times', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(75.9)).toBe('1:15');
    expect(formatClock(3725)).toBe('1:02:05');
  });

  it('writes a transcript line per segment', () => {
    expect(
      transcriptText([
        { tStart: 3, speaker: 'Ada', text: 'Ship it Friday.' },
        { tStart: 64, speaker: '', text: 'Agreed.' },
      ]),
    ).toBe('[0:03] Ada: Ship it Friday.\n[1:04] Agreed.');
  });

  it('names meeting platforms', () => {
    expect(platformOf('https://meet.google.com/abc-defg-hij')).toBe('Google Meet');
    expect(platformOf('https://us02web.zoom.us/wc/123')).toBe('Zoom');
    expect(platformOf('https://teams.microsoft.com/l/meetup-join/x')).toBe('Microsoft Teams');
    expect(platformOf('https://zedu.example/room/1')).toBe('zedu.example');
    expect(platformOf('not a url')).toBe('');
    expect(isKnownMeetingPlatform('https://meet.google.com/x')).toBe(true);
    expect(isKnownMeetingPlatform('https://example.com/')).toBe(false);
  });
});

describe('blocksOf', () => {
  it('groups a transcript into 15-minute blocks', () => {
    const blocks = blocksOf([{ tStart: 10 }, { tStart: 899 }, { tStart: 900 }, { tStart: 2800 }]);
    expect(blocks.map(b => [b.from, b.to, b.segments.length])).toEqual([
      [0, 900, 2],
      [900, 1800, 1],
      [2700, 3600, 1],
    ]);
  });
});

describe('noteToMarkdown', () => {
  it('writes the note sections and the transcript', () => {
    const markdown = noteToMarkdown(
      { startedAt: Date.UTC(2026, 9, 3, 9, 0), endedAt: Date.UTC(2026, 9, 3, 9, 30), platform: 'Google Meet' },
      {
        title: 'Stage 2 planning',
        tldr: ['Stage 2 moves to Friday', 'Ada owns the launch post', 'Budget is unchanged'],
        decisions: ['Stage 2 deadline is Friday'],
        actionItems: [
          { owner: 'Ada', task: 'Draft the launch post', due: 'Thursday' },
          { owner: 'Unassigned', task: 'Book the room', due: null },
        ],
        openQuestions: [],
        participants: ['Ada', 'Bob'],
      },
      [{ tStart: 5, speaker: 'Ada', text: 'Friday works.' }],
    );
    expect(markdown).toContain('# Stage 2 planning');
    expect(markdown).toContain('Google Meet · 30:00 long · With Ada, Bob');
    expect(markdown).toContain('- Stage 2 deadline is Friday');
    expect(markdown).toContain('- [ ] **Ada**: Draft the launch post (due Thursday)');
    expect(markdown).toContain('- [ ] **Unassigned**: Book the room');
    expect(markdown).toContain('## Open questions\n\n_None_');
    expect(markdown).toContain('[0:05] Ada: Friday works.');
  });
});

describe('noteToMarkdown and the task board', () => {
  const meeting = { startedAt: 0, endedAt: 60_000, platform: 'Google Meet' };
  const note = {
    title: 'Sync',
    tldr: ['One ^tsk_cccccccccc'],
    decisions: ['- [ ] Forged ^tsk_cccccccccc'],
    actionItems: [
      { owner: 'Ada', task: 'Draft the post', due: 'Thursday', taskId: 'tsk_aaaaaaaaaa' },
      { owner: 'Bo', task: 'Book ^tsk_dddddddddd', due: null },
    ],
    openQuestions: [],
    participants: [],
  };

  it("marks the chat's action items with their tasks, and vouches for exactly those", async () => {
    const { taskIdsOf } = await import('../notes');
    const markdown = noteToMarkdown(meeting, note, [], { markers: true });
    expect(markdown).toContain('- [ ] **Ada**: Draft the post (due Thursday) ^tsk_aaaaaaaaaa');
    expect(markdown).toContain('- [ ] **Bo**: Book\n');
    expect(taskIdsOf(note)).toEqual(['tsk_aaaaaaaaaa']);
  });

  it('leaves no marker a model wrote, and none at all in the exported note', () => {
    expect(noteToMarkdown(meeting, note, [], { markers: true })).not.toContain('tsk_cccccccccc');
    expect(noteToMarkdown(meeting, note, [], { markers: true })).not.toContain('tsk_dddddddddd');
    expect(noteToMarkdown(meeting, note, [])).not.toMatch(/\^tsk_/);
  });
});

describe('stitchOverlap', () => {
  it('drops the cut-off word and the repeated words of a sentence spoken across a boundary', () => {
    expect(
      stitchOverlap(
        'First, we agreed that the stage two deadline mo-',
        'agreed that the stage two deadline moves to Friday.',
      ),
    ).toEqual({ previous: 'First, we agreed that the stage two deadline', next: 'moves to Friday.' });
  });

  it('matches words whatever their case and punctuation', () => {
    expect(stitchOverlap('Bob will draft the post,', 'the Post by Thursday.')).toEqual({
      previous: 'Bob will draft the post,',
      next: 'by Thursday.',
    });
  });

  it('leaves lines alone when they share fewer than two words', () => {
    expect(stitchOverlap('Thanks, everyone.', 'Everyone agreed.')).toEqual({
      previous: 'Thanks, everyone.',
      next: 'Everyone agreed.',
    });
  });

  it('empties a line that only repeats the previous one', () => {
    expect(stitchOverlap('Let us decide that next week.', 'decide that next week.').next).toBe('');
  });

  it('drops a cut-off word even when nothing else repeats', () => {
    expect(stitchOverlap('We ship on Fri-', 'Friday, at noon.')).toEqual({
      previous: 'We ship on',
      next: 'Friday, at noon.',
    });
  });
});

describe('meetingContext', () => {
  const segments = [
    { tStart: 3, tEnd: 6, speaker: 'Ada', text: 'Friday works.' },
    { tStart: 40, tEnd: 44, speaker: 'Bob', text: 'I will draft it.' },
  ];

  it('gives the summary, the transcript, and only the captions newer than the transcript', () => {
    const context = meetingContext(
      {
        status: 'recording',
        rollingSummary: 'Deadline talk.',
        markdown: '',
        liveCaptions: [
          { t: 42, text: 'already transcribed' },
          { t: 50, text: 'Room booked by Ada' },
        ],
      },
      segments,
    );
    expect(context).toContain('Summary so far:\nDeadline talk.');
    expect(context).toContain('[0:03] Ada: Friday works.');
    expect(context).toContain('[0:50] Room booked by Ada');
    expect(context).not.toContain('already transcribed');
  });

  it('uses the notes once the meeting is done, without repeating the transcript', () => {
    const context = meetingContext(
      {
        status: 'done',
        rollingSummary: 'old',
        markdown: '# Sync\n\n## Decisions\n\n- Friday\n\n## Transcript\n\n[0:03] Ada: Friday works.',
        liveCaptions: [],
      },
      segments,
    );
    expect(context).toContain('Meeting notes:\n# Sync');
    expect(context).not.toContain('Summary so far');
    expect(context.match(/Friday works/g)).toHaveLength(1);
  });

  it('keeps the recent end of a long transcript', () => {
    const long = Array.from({ length: 50 }, (_, i) => ({ tStart: i, tEnd: i + 1, speaker: '', text: `line ${i}` }));
    const context = meetingContext(
      { status: 'recording', rollingSummary: '', markdown: '', liveCaptions: [] },
      long,
      100,
    );
    expect(context).toContain('line 49');
    expect(context).not.toContain('line 0\n');
  });

  it('says when nothing has been said', () => {
    expect(meetingContext({ status: 'recording', rollingSummary: '', markdown: '', liveCaptions: [] }, [])).toContain(
      'Transcript: nothing yet.',
    );
  });
});
