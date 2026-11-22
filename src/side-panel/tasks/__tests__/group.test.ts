import { describe, expect, it } from 'vitest';
import type { Task } from '@extension/storage';
import { groupTasks } from '../group';

const task = (id: string, workspaceId: string | null, ownerName: string | null = null, ownerId: string | null = null) =>
  ({ id, title: id, workspaceId, ownerName, ownerId, status: 'open' }) as Task;

const NAMES = { noWorkspace: 'No workspace', noOwner: 'No owner' };
const WORKSPACES = [
  { id: 'ws-2', name: 'Globex' },
  { id: 'ws-1', name: 'Acme' },
];

describe('groupTasks', () => {
  it("by workspace: the workspace list's order, then No workspace with tasks of deleted ones", () => {
    const groups = groupTasks(
      [task('a', 'ws-1'), task('b', null), task('c', 'ws-2'), task('d', 'ws-gone'), task('e', 'ws-1')],
      'workspace',
      WORKSPACES,
      NAMES,
    );
    expect(groups.map(group => [group.name, group.tasks.map(item => item.id)])).toEqual([
      ['Globex', ['c']],
      ['Acme', ['a', 'e']],
      ['No workspace', ['b', 'd']],
    ]);
  });

  it('by person: one group per person however the name is written, A to Z, then No owner', () => {
    const groups = groupTasks(
      [task('a', 'ws-1', 'Lee'), task('b', 'ws-1', 'dana'), task('c', null), task('d', 'ws-2', 'Dana')],
      'person',
      WORKSPACES,
      NAMES,
    );
    expect(groups.map(group => [group.name, group.tasks.map(item => item.id)])).toEqual([
      ['dana', ['b', 'd']],
      ['Lee', ['a']],
      ['No owner', ['c']],
    ]);
  });

  it('a linked person groups by their id', () => {
    const groups = groupTasks(
      [task('a', 'ws-1', 'Dana', 'person-1'), task('b', 'ws-1', 'Dana R.', 'person-1')],
      'person',
      WORKSPACES,
      NAMES,
    );
    expect(groups).toHaveLength(1);
    expect(groups[0].tasks.map(item => item.id)).toEqual(['a', 'b']);
  });
});
