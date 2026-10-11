import { describe, expect, it } from 'vitest';
import { routeWorkspace, workspaceForAccount, workspaceId } from '../workspaces';
import type { Workspace } from '../workspaces';

const ws = (id: string, name: string, keywords: string[], google?: string): Workspace => ({
  id,
  name,
  about: '',
  keywords,
  accounts: google ? { google } : {},
  createdAt: 0,
});
const all = [
  ws('nexprove', 'Nexprove', ['nexprove'], 'avi@nexprove.com'),
  ws('tef', 'Tech Ember Fest', ['tech ember', 'techember']),
  ws('ellum', 'Ellum AI', ['ellum']),
];

describe('routeWorkspace', () => {
  it('finds the workspace a request names, by name, keyword or email domain', () => {
    expect(routeWorkspace('Draft the Tech Ember Fest sponsor email', all)?.id).toBe('tef');
    expect(routeWorkspace('post this on the techember page', all)?.id).toBe('tef');
    expect(routeWorkspace('reply to the client from nexprove', all)?.id).toBe('nexprove');
    expect(routeWorkspace('forward it to sam@nexprove.com', all)?.id).toBe('nexprove');
    expect(routeWorkspace('Ellum investor update', all)?.id).toBe('ellum');
  });

  it('leaves it to the user when nothing or two things match', () => {
    expect(routeWorkspace('what is the weather', all)).toBeNull();
    expect(routeWorkspace('compare nexprove and ellum', all)).toBeNull();
    // Part of a word is not a mention
    expect(routeWorkspace('the bellum war', all)).toBeNull();
  });
});

describe('workspaceId', () => {
  it('makes a short unique id from a name', () => {
    expect(workspaceId('Tech Ember Fest!')).toBe('tech-ember-fest');
    expect(workspaceId('Nexprove', ['nexprove'])).toBe('nexprove-2');
  });
});

describe('workspaceForAccount', () => {
  it('finds the workspace of a Google account, by address or company domain', () => {
    const list = [
      ws('nexprove', 'Nexprove', [], 'avi@nexprove.com'),
      ws('personal', 'Personal', [], 'avi@gmail.com'),
      ws('tef', 'Tech Ember Fest', []),
    ];
    expect(workspaceForAccount('AVI@nexprove.com', list)?.id).toBe('nexprove');
    expect(workspaceForAccount('sam@nexprove.com', list)?.id).toBe('nexprove');
    expect(workspaceForAccount('avi@gmail.com', list)?.id).toBe('personal');
    // A public domain says nothing
    expect(workspaceForAccount('someone@gmail.com', list)).toBeNull();
    expect(workspaceForAccount('x@unknown.org', list)).toBeNull();
  });
});
