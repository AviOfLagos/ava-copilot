import { describe, expect, it } from 'vitest';
import MessageManager from '../service';
import { systemMessage } from '@src/background/llm/messages';

const media = { images: [{ mediaType: 'image/png', data: 'AAAA' }], note: 'The user attached a picture.' };

describe('a task with attached pictures', () => {
  it('gives the task words, the note and the image parts in one user message', () => {
    const manager = new MessageManager();
    manager.initTaskMessages(systemMessage('system'), 'what is in this?', undefined, media);
    const task = manager.getMessages()[1];
    expect(Array.isArray(task.content)).toBe(true);
    const parts = task.content as { type: string; text?: string; mediaType?: string; data?: string }[];
    expect(parts[0].text).toContain('what is in this?');
    expect(parts[1]).toEqual({ type: 'text', text: 'The user attached a picture.' });
    expect(parts[2]).toEqual({ type: 'file', mediaType: 'image/png', data: 'AAAA' });
  });

  it('adds a follow-up with pictures, and keeps it through a compaction', () => {
    const manager = new MessageManager();
    manager.initTaskMessages(systemMessage('system'), 'first');
    manager.addNewTask('and this one?', media);
    manager.addModelOutput({ step: 1 });
    manager.addModelOutput({ step: 2 });
    const plan = manager.compactableMessages(0);
    expect(plan).not.toBeNull();
    manager.compactHistory('summary', plan!.cut);
    const kept = manager
      .getMessages()
      .find(message => Array.isArray(message.content) && message.content.some(part => part.type === 'file'));
    expect(kept).toBeDefined();
  });

  it('gives content that came with the task (a document, a link preview) after the words, with no pictures', () => {
    const manager = new MessageManager();
    manager.initTaskMessages(systemMessage('system'), 'how many panels?', undefined, {
      images: [],
      note: 'A document he sent, content only.',
    });
    const parts = manager.getMessages()[1].content as { type: string; text?: string }[];
    expect(parts).toHaveLength(2);
    expect(parts[0].text).toContain('how many panels?');
    expect(parts[1]).toEqual({ type: 'text', text: 'A document he sent, content only.' });
  });

  it('stays plain text without pictures', () => {
    const manager = new MessageManager();
    manager.initTaskMessages(systemMessage('system'), 'plain', undefined, null);
    expect(typeof manager.getMessages()[1].content).toBe('string');
  });
});
