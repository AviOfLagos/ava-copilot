import { describe, expect, it } from 'vitest';
import { commandOf } from '../commands';

describe('WhatsApp commands about Ava’s own messages', () => {
  it('reads "delete that" however he puts it', () => {
    for (const text of [
      'delete that',
      'Delete that.',
      'please delete your last message',
      'unsend it',
      'Ava, remove that one',
    ]) {
      expect(commandOf(text)).toEqual({ kind: 'delete' });
    }
  });

  it('reads a reaction, typed as an emoji or said as its name', () => {
    expect(commandOf('react 🔥 to that')).toEqual({ kind: 'react', emoji: '🔥' });
    expect(commandOf('React fire to that.')).toEqual({ kind: 'react', emoji: '🔥' });
    expect(commandOf('react with 👍🏽')).toEqual({ kind: 'react', emoji: '👍🏽' });
    expect(commandOf('react to that with a heart')).toEqual({ kind: 'react', emoji: '❤️' });
    expect(commandOf('react 🇳🇬')).toEqual({ kind: 'react', emoji: '🇳🇬' });
  });

  it('reads an edit with the new words', () => {
    expect(commandOf('change that to: Meeting at 4')).toEqual({ kind: 'edit', text: 'Meeting at 4' });
    expect(commandOf('Edit it to "hello there"')).toEqual({ kind: 'edit', text: 'hello there' });
  });

  it('leaves everything else to the chat', () => {
    for (const text of [
      'delete that file from my drive',
      'delete the calendar event',
      'react to the email',
      'can you change that to Friday in the doc',
      'thanks',
      '',
    ]) {
      expect(commandOf(text)).toBeNull();
    }
  });
});
