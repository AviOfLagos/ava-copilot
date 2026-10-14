import { describe, expect, it } from 'vitest';
import whatsappSkill from '../../../storage/lib/skills/builtin/whatsapp-web.md?raw';
import { mergeSelectors, parseSelectors } from '../selectors';

describe('WhatsApp selectors from the skill', () => {
  it('reads the selectors block of the built-in skill, every key the feature uses', () => {
    const sel = parseSelectors(whatsappSkill);
    for (const key of [
      'chatList',
      'chatRow',
      'rowTitle',
      'rowPreview',
      'rowUnread',
      'searchBox',
      'chatHeader',
      'message',
      'messageText',
      'outgoing',
      'composer',
      'sendButton',
      'invalidNumber',
      'loggedOut',
      'mediaCaption',
      'mediaSend',
    ]) {
      expect(sel[key]?.length, key).toBeGreaterThan(0);
    }
    expect(sel.composer[0]).toBe('footer [contenteditable="true"][role="textbox"]');
  });

  it('splits alternatives on ||, ignores other lines and a missing block', () => {
    const body = 'Tips\n```selectors\ncomposer: a || b\nnot a line\n  sendButton:  c  \n```\n';
    expect(parseSelectors(body)).toEqual({ composer: ['a', 'b'], sendButton: ['c'] });
    expect(parseSelectors('no block')).toEqual({});
  });

  it("lets the user's copy override keys and keeps the rest built in", () => {
    expect(mergeSelectors({ composer: ['x'] }, { composer: ['a'], sendButton: ['b'] })).toEqual({
      composer: ['x'],
      sendButton: ['b'],
    });
  });
});
