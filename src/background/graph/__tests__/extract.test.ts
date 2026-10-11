import { describe, expect, it } from 'vitest';
import type { KnowledgeItem } from '@extension/storage';
import { mergeReadings, readingFromNote, sliceFrom } from '../extract';

const item = (fields: Partial<KnowledgeItem> = {}): KnowledgeItem => ({
  id: 'meeting:m1',
  sourceType: 'meeting',
  sourceId: 'm1',
  title: 'Sponsor sync',
  url: '',
  sourceDate: 100,
  sourceUpdatedAt: 100,
  createdAt: 100,
  updatedAt: 100,
  chunkCount: 1,
  unembedded: 0,
  workspaceId: 'tef',
  ...fields,
});

describe('sliceFrom', () => {
  it('links who came, what was decided and who does what, inside the workspace', () => {
    const reading = mergeReadings(
      readingFromNote({
        title: 'Sponsor sync',
        tldr: [],
        decisions: ['Sponsor deck goes out Friday'],
        actionItems: [{ owner: 'Ada', task: 'Finish the sponsor deck', due: null }],
        openQuestions: [],
        participants: ['Ada', 'Grace', 'the user'],
      }),
      { people: ['Ada'], organizations: ['Acme'], projects: ['Sponsor deck'], decisions: [], actions: [] },
    );
    const slice = sliceFrom(item(), reading, 'h1');
    const ids = slice.entities.map(node => node.id);
    expect(ids).toContain('person:tef:ada');
    expect(ids).toContain('person:tef:grace');
    expect(ids).toContain('project:tef:sponsor deck');
    expect(ids).toContain('organization:tef:acme');
    expect(ids.some(id => id.includes('the user'))).toBe(false);

    const kinds = slice.edges.map(edge => `${edge.kind}:${edge.to}`);
    expect(kinds).toContain('attended:person:tef:ada');
    expect(kinds).toContain('decided_in:meeting:m1');
    expect(kinds).toContain('assigned_to:person:tef:ada');
    // The decision and the action both name the project
    expect(slice.edges.filter(edge => edge.kind === 'part_of' && edge.to === 'project:tef:sponsor deck')).toHaveLength(
      2,
    );
    expect(slice.source).toMatchObject({ id: 'meeting:m1', type: 'meeting', hash: 'h1', workspaceId: 'tef' });
  });

  it('skips nameless, overlong and repeated entries', () => {
    const slice = sliceFrom(
      item({ sourceType: 'thread', id: 'thread:t1' }),
      { people: ['Ada', 'ada ', 'I', 'x'.repeat(200)], organizations: [], projects: [], decisions: [], actions: [] },
      'h',
    );
    expect(slice.entities.map(node => node.label)).toEqual(['Ada']);
    expect(slice.edges[0].kind).toBe('mentions');
  });
});
