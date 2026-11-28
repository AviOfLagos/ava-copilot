import { describe, expect, it } from 'vitest';
import { answersInVoice, replyModeOf } from '../reply-mode';

describe('replyModeOf (#203)', () => {
  it.each([
    ['Reply with voice notes from now on', 'voice'],
    ['please answer me in voice notes', 'voice'],
    ['Send me voice notes', 'voice'],
    ['use voice messages', 'voice'],
    ['voice notes from now on.', 'voice'],
    ['Answer in text', 'text'],
    ['reply in text from now on please', 'text'],
    ['just text me', 'text'],
    ['No more voice notes', 'text'],
    ['stop sending voice notes!', 'text'],
    ['type your replies', 'text'],
    ['Can you reply with voice notes?', 'voice'],
    ['Switch to voice notes', 'voice'],
    ['I prefer text', 'text'],
    ['Reply with text, not voice notes', 'text'],
  ])('"%s" sets %s', (text, mode) => {
    expect(replyModeOf(text)).toEqual({ mode, rest: '' });
  });

  it('ignores requests that only mention a voice note or texting', () => {
    for (const words of [
      "Send me a voice note about today's plan",
      'Send a voice note',
      'How do I send a voice note',
      'Remind me to send a voice note',
      'Remind me to send Ada and Bob a voice note',
      'Text me the address of the venue',
      'text me when the build finishes',
      'Remember to text me',
    ]) {
      expect(replyModeOf(words), words).toBeNull();
    }
  });

  it('keeps the rest of a longer message for the chat', () => {
    expect(replyModeOf("Answer in text: what's on my calendar today?")).toEqual({
      mode: 'text',
      rest: "what's on my calendar today?",
    });
    expect(replyModeOf('What did Ada say? Reply with a voice note.')).toEqual({
      mode: 'voice',
      rest: 'What did Ada say?',
    });
  });

  it.each([
    'Send Ada a voice note saying I am late',
    'Can you send voice notes?',
    'I left you a voice note yesterday',
    'what is a text message',
    'text Tunde that the meeting moved',
    'reply to the email in text form when you can and also tell me about voice notes',
  ])('"%s" sets nothing', text => {
    expect(replyModeOf(text)).toBeNull();
  });
});

describe('answersInVoice', () => {
  const defaults = { voiceReplies: true, voiceForText: false };
  it('covers the four cases: text→voice, voice→text, text→text, voice→voice', () => {
    // He asked for voice notes, then typed: a voice note
    expect(answersInVoice('voice', defaults, false)).toBe(true);
    // He asked for text, then sent a voice note: text
    expect(answersInVoice('text', defaults, true)).toBe(false);
    // Nothing asked: typed gets text, a voice note gets a voice note (the settings, as before)
    expect(answersInVoice(null, defaults, false)).toBe(false);
    expect(answersInVoice(null, defaults, true)).toBe(true);
  });

  it('lets his words override the settings switch', () => {
    expect(answersInVoice('voice', { voiceReplies: false, voiceForText: false }, false)).toBe(true);
    expect(answersInVoice(null, { voiceReplies: false, voiceForText: true }, true)).toBe(false);
  });
});
