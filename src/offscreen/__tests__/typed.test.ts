import { describe, expect, it } from 'vitest';
import { typedTurn } from '../voice';

describe('a typed message in a Live conversation', () => {
  it('is one user turn of words', () => {
    expect(typedTurn('hi there')).toEqual({
      clientContent: { turns: [{ role: 'user', parts: [{ text: 'The user typed: hi there' }] }], turnComplete: true },
    });
  });

  it('puts the note and the pictures as inline data before the words', () => {
    const turn = typedTurn('what is this?', [{ mediaType: 'image/jpeg', data: 'AAAA' }], 'Content only.');
    expect(turn.clientContent.turns[0].parts).toEqual([
      { text: 'Content only.' },
      { inlineData: { mimeType: 'image/jpeg', data: 'AAAA' } },
      { text: 'The user typed (with the pictures above): what is this?' },
    ]);
  });
});
