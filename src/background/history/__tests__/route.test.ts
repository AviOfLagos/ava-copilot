import { describe, expect, it } from 'vitest';
import type { Workspace } from '@extension/storage';
import { mappedWorkspace, routeConversation } from '../route';

const workspace = (id: string, name: string, keywords: string[] = []): Workspace => ({
  id,
  name,
  about: '',
  keywords,
  accounts: {},
  createdAt: 0,
});
const workspaces = [workspace('acme', 'Acme', ['rocket']), workspace('fest', 'Tech Fest', ['speakers'])];
const conversation = (project: string | null, title = 'Some work', ask = 'Please help') => ({
  project,
  title,
  turns: [{ role: 'user' as const, text: ask, at: null }],
});

describe('routeConversation', () => {
  it('uses the folder the user mapped, or a parent folder of it, first', () => {
    const mappings = { '/Users/me/code': 'fest', '/Users/me/code/acme-site': 'acme' };
    expect(routeConversation(conversation('/Users/me/code/acme-site/web'), workspaces, mappings)).toEqual({
      workspaceId: 'acme',
      reason: 'mapped',
    });
    expect(routeConversation(conversation('/Users/me/code/other'), workspaces, mappings).workspaceId).toBe('fest');
  });

  it('keeps a folder mapped to none out of every workspace, even when its words name one', () => {
    const result = routeConversation(conversation('/Users/me/scratch', 'Acme rocket'), workspaces, {
      '/Users/me/scratch': null,
    });
    expect(result).toEqual({ workspaceId: null, reason: 'none' });
  });

  it('routes by a workspace the folder path names, but not by the home folder name', () => {
    expect(routeConversation(conversation('/Users/me/Desktop/26/Acme/desk'), workspaces, {}).workspaceId).toBe('acme');
    // A user named after a workspace does not put every session in it
    expect(routeConversation(conversation('/Users/acme/code/x'), workspaces, {}).workspaceId).toBeNull();
  });

  it('falls back to the title and first request, and stays general when two workspaces match', () => {
    expect(routeConversation(conversation(null, 'Speakers list'), workspaces, {}).workspaceId).toBe('fest');
    expect(routeConversation(conversation(null, 'Acme', 'invite the speakers'), workspaces, {}).workspaceId).toBeNull();
    expect(routeConversation(conversation(null), workspaces, {}).reason).toBe('none');
  });

  it('ignores a mapping to a workspace that was removed', () => {
    expect(routeConversation(conversation('/Users/me/acme'), workspaces, { '/Users/me/acme': 'gone' }).reason).toBe(
      'folder',
    );
  });
});

describe('mappedWorkspace', () => {
  it('finds the nearest mapped folder', () => {
    expect(mappedWorkspace('/a/b/c/', { '/a': 'x', '/a/b': 'y' })).toEqual({ found: true, workspaceId: 'y' });
    expect(mappedWorkspace('/z', { '/a': 'x' })).toEqual({ found: false, workspaceId: null });
  });
});
