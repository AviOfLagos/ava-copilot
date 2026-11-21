import { describe, expect, it } from 'vitest';
import {
  addMarks,
  isGenericSpeaker,
  MAX_SPEAKER_MARKS,
  mergeRoster,
  nameSegments,
  speakerFor,
  speakerMarks,
} from '../speakers';

describe('who said what', () => {
  // Captions read at 10 s and 20 s: Adaeze spoke from about 7 s, Kunle from about 17 s
  const marks = [
    ...speakerMarks([{ speaker: 'Adaeze O.', text: 'We ship the beta on Friday after review' }], 10, 15),
    ...speakerMarks([{ speaker: 'dev.kunle (Presenting)', text: 'I will fix the login bug first' }], 20, 15),
  ];

  it('places a caption line where the caption watcher places it, with a clean name', () => {
    expect(marks[0]).toMatchObject({ t1: 10, speaker: 'Adaeze O.' });
    expect(marks[0].t0).toBeCloseTo(10 - 39 / 15);
    expect(marks[1].speaker).toBe('dev.kunle');
  });

  it('gives each audio segment the speaker it overlaps most', () => {
    const segments = [
      { id: 's1', tStart: 6, tEnd: 11, speaker: 'Speaker 1', chunkIndex: 0 },
      { id: 's2', tStart: 16, tEnd: 21, speaker: 'Speaker 2', chunkIndex: 0 },
      // Nothing was captioned at 40 s: it keeps what the audio said
      { id: 's3', tStart: 40, tEnd: 45, speaker: 'Speaker 1', chunkIndex: 1 },
      // A caption line itself is left alone
      { id: 'c1', tStart: 7, tEnd: 10, speaker: 'Adaeze O.', chunkIndex: -1 },
    ];
    expect(nameSegments(segments, marks)).toEqual([
      { id: 's1', speaker: 'Adaeze O.' },
      { id: 's2', speaker: 'dev.kunle' },
    ]);
  });

  it('picks the longer overlap when two speakers share a segment', () => {
    expect(speakerFor(8, 18, marks)).toBe('Adaeze O.');
    expect(speakerFor(14, 22, marks)).toBe('dev.kunle');
    expect(speakerFor(100, 110, marks)).toBeNull();
  });

  it('keeps only the newest marks of a very long call', () => {
    const many = Array.from({ length: MAX_SPEAKER_MARKS }, (_, i) => ({ t0: i, t1: i + 1, speaker: 'A' }));
    const next = addMarks(many, [{ t0: 1e6, t1: 1e6 + 1, speaker: 'B' }]);
    expect(next).toHaveLength(MAX_SPEAKER_MARKS);
    expect(next.at(-1)?.speaker).toBe('B');
  });

  it('knows a made-up speaker label from a name', () => {
    expect(isGenericSpeaker('Speaker 3')).toBe(true);
    expect(isGenericSpeaker('')).toBe(true);
    expect(isGenericSpeaker('Adaeze O.')).toBe(false);
  });
});

describe('roster', () => {
  it('adds each name once, whatever its case, accents or "(You)"', () => {
    expect(mergeRoster(['Adaeze O.'], ['adaeze o.', 'Adaéze O.', 'dev.kunle', 'Tolu (Presenting)'])).toEqual([
      'Adaeze O.',
      'dev.kunle',
      'Tolu',
    ]);
  });
});
