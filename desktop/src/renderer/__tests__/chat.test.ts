import { describe, expect, it } from 'vitest';
import type { DesktopReply } from '@protocol';
import { LINES_MAX, addSent, applyReplies, emptyChat, markFailed, newChatId, restoreChat } from '../chat';

const CHAT = 'dc_abcdefgh12';
const reply = (seq: number, kind: DesktopReply['kind'], text = '', chatId = CHAT): DesktopReply => ({
  seq,
  chatId,
  kind,
  text,
  at: seq,
});

describe('desktop chat', () => {
  it('makes ids Ava Brain takes', () => {
    expect(newChatId()).toMatch(/^dc_[a-z0-9]{16}$/);
  });

  it('shows the words at once, then "working", then the answer', () => {
    let state = addSent(emptyChat(CHAT), 'hello', 1, 'm1');
    expect(state.working).toBe(true);
    state = applyReplies(state, [reply(1, 'working'), reply(2, 'answer', 'Hi!')]);
    expect(state.working).toBe(false);
    expect(state.lines.map(line => [line.role, line.text])).toEqual([
      ['you', 'hello'],
      ['ava', 'Hi!'],
    ]);
    expect(state.seq).toBe(2);
  });

  it('notes a wait for a click and an error, skips other windows and answers already read', () => {
    let state = emptyChat(CHAT, 5);
    state = applyReplies(state, [
      reply(4, 'answer', 'old'),
      reply(6, 'needs_click', 'send: Reply to Ada'),
      reply(7, 'answer', 'not mine', 'dc_otherchat1'),
      reply(8, 'error', ''),
    ]);
    expect(state.lines).toMatchObject([
      { role: 'note', tone: 'hold', text: "Waiting for your click in the browser's Ava panel: send: Reply to Ada." },
      { role: 'note', tone: 'error', text: 'The chat stopped.' },
    ]);
    expect(state.seq).toBe(8);
  });

  it('starts its place over when Ava Brain restarted', () => {
    const state = applyReplies(emptyChat(CHAT, 57), [reply(1, 'answer', 'after the restart')], true);
    expect(state.seq).toBe(1);
    expect(state.lines.map(line => line.text)).toEqual(['after the restart']);
  });

  it('marks a message Ava Brain did not take', () => {
    const state = markFailed(addSent(emptyChat(CHAT), 'hi', 1, 'm1'), 'm1', 'Ava Brain is not running on this Mac.');
    expect(state.lines[0]).toMatchObject({ failed: 'Ava Brain is not running on this Mac.' });
    expect(state.working).toBe(false);
  });

  it('keeps a bounded history and repairs what it restores', () => {
    let state = emptyChat(CHAT);
    for (let i = 0; i < LINES_MAX + 10; i++) state = addSent(state, `m${i}`, i, `m${i}`);
    expect(state.lines).toHaveLength(LINES_MAX);
    expect(
      restoreChat({ chatId: 'bad id', lines: [{ id: 1 }, { id: 'a', role: 'you', text: 'x', at: 1 }] }, CHAT),
    ).toEqual({ chatId: CHAT, lines: [{ id: 'a', role: 'you', text: 'x', at: 1 }], working: false, seq: 0 });
    expect(restoreChat(null, CHAT).chatId).toBe(CHAT);
  });
});
