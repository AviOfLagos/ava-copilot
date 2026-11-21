// The task board (docs/pm-desk.md, Part 2): one record per thing to be done, however many times it was mentioned

export type TaskStatus = 'open' | 'done' | 'dropped';

// Who set a task's workspace: Avi's own choice always wins over a rule's or Ava's (rule 8)
export type WorkspaceSetBy = 'avi' | 'rule' | 'ava';

export type TaskSourceKind = 'meeting' | 'chat' | 'note' | 'voice' | 'whatsapp' | 'manual' | 'summary';

export interface TaskSource {
  kind: TaskSourceKind;
  // Meeting id, thread id, knowledge item id
  id?: string;
  // The sentence it came from, at most 300 chars
  quote?: string;
}

export interface Task {
  // 'tsk_' + 10 random base32 chars
  id: string;
  // What is to be done, one line
  title: string;
  // More words, if the source had them
  detail?: string;
  workspaceId: string | null;
  workspaceSetBy: WorkspaceSetBy;
  // A Person id (Part 5); null until resolved
  ownerId: string | null;
  // The name as it was said or written
  ownerName: string | null;
  status: TaskStatus;
  doneAt?: number;
  // 'ava' only when a source says it was done
  doneBy?: 'avi' | 'ava';
  // ISO date (YYYY-MM-DD, local), when one could be worked out
  due?: string;
  // The words used ("by Friday")
  dueText?: string;
  source: TaskSource;
  // Every source item id that mentioned it
  seenIn: string[];
  // A recording, a doc
  links: { label: string; url: string }[];
  followUp?: { askedAt?: number; nextAt?: number; count: number };
  // For Sheets/Notion/Linear later
  externalRefs: { system: string; id: string }[];
  // The ids of tasks merged into this one: a marker written with one of them still finds this task
  mergedIds?: string[];
  createdAt: number;
  updatedAt: number;
}

/** A mention of something to be done, from any source, before it is matched to a task. */
export interface TaskCandidate {
  title: string;
  detail?: string;
  workspaceId: string | null;
  // Defaults to 'rule': a source's workspace was set by the keyword rules or by the user on the source
  workspaceSetBy?: WorkspaceSetBy;
  ownerName?: string | null;
  ownerId?: string | null;
  // An ISO date already worked out; otherwise worked out from dueText and `at`
  due?: string;
  dueText?: string | null;
  source: TaskSource;
  // When it was mentioned (the meeting's start, the source's date); defaults to now
  at?: number;
}

export interface TaskListQuery {
  status?: TaskStatus | TaskStatus[];
  // undefined: every workspace; null: the tasks in none
  workspaceId?: string | null;
  ownerId?: string | null;
  // ISO date: only tasks with a due date before it
  dueBefore?: string;
}

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** 'tsk_' + 10 random base32 chars. */
export function newTaskId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return `tsk_${[...bytes].map(byte => BASE32[byte % 32]).join('')}`;
}

export const TASK_ID_PATTERN = /^tsk_[a-z2-7]{10}$/;

export const isTaskId = (value: unknown): value is string => typeof value === 'string' && TASK_ID_PATTERN.test(value);
