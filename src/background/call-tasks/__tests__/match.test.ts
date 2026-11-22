import { describe, expect, it } from 'vitest';
import { additionOf, findCommands, sentencesOf } from '../match';

const one = (text: string) => {
  const found = findCommands(text);
  expect(found).toHaveLength(1);
  return { name: found[0].name, words: found[0].words };
};

describe('findCommands', () => {
  it('hears every form of the phrase', () => {
    expect(one('Ava, note a task for Ada: send the deck.')).toEqual({ name: 'Ada', words: 'send the deck' });
    expect(one('hey ava please add task for Ada, send the deck')).toEqual({ name: 'Ada', words: 'send the deck' });
    expect(one('Ava log a task for Ada send the deck')).toEqual({ name: 'Ada', words: 'send the deck' });
    expect(one('Ava create a task for Ada to send the deck')).toEqual({ name: 'Ada', words: 'send the deck' });
    expect(one('Ava, can you note down a task for Ada: send the deck')).toEqual({
      name: 'Ada',
      words: 'send the deck',
    });
  });

  it('hears what recognisers write for "Ava"', () => {
    for (const call of ['Eva', 'Avah', 'Ayva']) {
      expect(one(`${call}, note a task for Ada: send the deck`).name).toBe('Ada');
    }
  });

  it('takes a name of up to three capitalised words before ":" or ",", else one word', () => {
    expect(one('Ava, note a task for Ada Obi: send the deck').name).toBe('Ada Obi');
    expect(one('Ava, note a task for Ada send it, now').name).toBe('Ada');
    expect(one('Ava note a task for ada obi send the deck').name).toBe('ada');
  });

  it('reads "for me" as a task for Avi himself', () => {
    expect(one('Ava, note a task for me: call the bank')).toEqual({ name: null, words: 'call the bank' });
  });

  it('needs her name, a verb, "task" and "for"', () => {
    for (const text of [
      'note a task for Ada: send the deck',
      'Ava, there is a task for Ada',
      'Ava, note the time for Ada',
      'Ava, note a task: send the deck',
      'Ben said he would note a task for Ada',
    ]) {
      expect(findCommands(text)).toEqual([]);
    }
  });

  it('splits two commands said in one breath, each with its own words', () => {
    const found = findCommands('Ava note a task for Ada: the deck. Ava, note a task for Ben: the venue');
    expect(found.map(command => [command.name, command.words])).toEqual([
      ['Ada', 'the deck'],
      ['Ben', 'the venue'],
    ]);
  });

  it('keeps the words empty when they are still to come', () => {
    expect(one('Ava, note a task for Ada.')).toEqual({ name: 'Ada', words: '' });
  });
});

describe('additionOf', () => {
  it('takes "also", "and", "add to that" and "Ava," as additions', () => {
    expect(additionOf('Also add the pricing slide.')).toBe('add the pricing slide');
    expect(additionOf('And confirm catering')).toBe('confirm catering');
    expect(additionOf('Add to that the logo files.')).toBe('the logo files');
    expect(additionOf('Ava, make it by Friday.')).toBe('make it by Friday');
  });

  it('takes nothing else', () => {
    expect(additionOf('Okay, next topic.')).toBeNull();
    expect(additionOf('Ben, make it by Friday.')).toBeNull();
    expect(additionOf('Android is fine')).toBeNull();
  });
});

describe('sentencesOf', () => {
  it('splits on full stops, questions and semicolons, and says which ones ended', () => {
    expect(sentencesOf('One thing. Two things? Three')).toEqual([
      { text: 'One thing.', ended: true },
      { text: 'Two things?', ended: true },
      { text: 'Three', ended: false },
    ]);
  });
});
