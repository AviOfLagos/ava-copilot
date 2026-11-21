import { normaliseTitle } from '@extension/storage';
import type { Task, Workspace } from '@extension/storage';

export type Grouping = 'workspace' | 'person';

export interface TaskGroup {
  key: string;
  name: string;
  tasks: Task[];
}

/**
 * Tasks in groups for the Tasks page, keeping their order inside each group. By workspace: in the workspace
 * list's order, then "No workspace". By person: by the person's id, else their name as said, A to Z, then "No
 * owner". Empty groups are left out.
 */
export function groupTasks(
  tasks: Task[],
  grouping: Grouping,
  workspaces: Pick<Workspace, 'id' | 'name'>[],
  names: { noWorkspace: string; noOwner: string },
): TaskGroup[] {
  if (grouping === 'workspace') {
    const known = new Set(workspaces.map(workspace => workspace.id));
    const groups = [
      ...workspaces.map(workspace => ({ key: workspace.id, name: workspace.name })),
      { key: '', name: names.noWorkspace },
    ];
    return groups
      .map(group => ({
        ...group,
        tasks: tasks.filter(task =>
          group.key ? task.workspaceId === group.key : !task.workspaceId || !known.has(task.workspaceId),
        ),
      }))
      .filter(group => group.tasks.length > 0);
  }
  const byPerson = new Map<string, TaskGroup>();
  const nobody: Task[] = [];
  for (const task of tasks) {
    const key = task.ownerId ?? (task.ownerName ? `name:${normaliseTitle(task.ownerName)}` : '');
    if (!key) {
      nobody.push(task);
      continue;
    }
    if (!byPerson.has(key)) byPerson.set(key, { key, name: task.ownerName ?? key, tasks: [] });
    byPerson.get(key)!.tasks.push(task);
  }
  const people = [...byPerson.values()].sort((a, b) => a.name.localeCompare(b.name));
  return nobody.length ? [...people, { key: '', name: names.noOwner, tasks: nobody }] : people;
}
