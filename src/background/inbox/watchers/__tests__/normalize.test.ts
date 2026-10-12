import { describe, expect, it } from 'vitest';
import { toInboxDrafts } from '../normalize';

describe('toInboxDrafts', () => {
  it('turns a probe row into a message draft, sender as the title', () => {
    const [draft] = toInboxDrafts('whatsapp-web', [{ externalId: 'c1', sender: 'Priya', snippet: 'See you at 3?' }]);
    expect(draft).toMatchObject({
      source: 'whatsapp-web',
      externalId: 'c1',
      kind: 'message',
      title: 'Priya',
      body: 'See you at 3?',
      priority: 'normal',
    });
  });

  it('drops a row with no sender or no id: a probe that misread the page leaves no trace', () => {
    const drafts = toInboxDrafts('whatsapp-web', [
      { externalId: '', sender: 'Priya', snippet: 'hi' },
      { externalId: 'c2', sender: '  ', snippet: 'hi' },
      { externalId: 'c3', sender: 'Ok', snippet: 'hi' },
    ]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].externalId).toBe('c3');
  });

  it('trims whitespace and gives a placeholder for an empty snippet', () => {
    const [draft] = toInboxDrafts('slack-web', [{ externalId: 'c1', sender: '  Ada  ', snippet: '   ' }]);
    expect(draft.title).toBe('Ada');
    expect(draft.body).toBe('(no preview)');
  });

  it('caps very long sender names and snippets', () => {
    const [draft] = toInboxDrafts('gmail-web', [
      { externalId: 'c1', sender: 'A'.repeat(500), snippet: 'B'.repeat(5000) },
    ]);
    expect(draft.title.length).toBeLessThanOrEqual(120);
    expect(draft.body.length).toBeLessThanOrEqual(2000);
  });
});
