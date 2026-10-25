import { describe, expect, it } from 'vitest';
import { chunkAmbient } from '../chunker';

const T0 = new Date(2026, 9, 25, 14, 5).getTime();
const MIN = 60_000;

describe('chunkAmbient', () => {
  it('groups a session into windows of a couple of minutes, each citing when it was said', () => {
    const chunks = chunkAmbient('s1', [
      { startedAt: T0 + 5 * MIN, speaker: 'unknown', text: 'later point' },
      { startedAt: T0, speaker: 'unknown', text: 'We ship Friday.' },
      { startedAt: T0 + MIN, speaker: 'unknown', text: '  ' },
      { startedAt: T0 + MIN, speaker: 'me', text: 'Agreed.' },
    ]);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEqual({
      text: '[14:05] We ship Friday.\n[14:06] me: Agreed.',
      label: '14:05',
      anchor: { kind: 'ambient', sessionId: 's1', at: T0 },
    });
    expect(chunks[1].label).toBe('14:10');
  });

  it('makes nothing of a session with no words', () => {
    expect(chunkAmbient('s1', [{ startedAt: T0, speaker: 'unknown', text: '' }])).toEqual([]);
  });
});
