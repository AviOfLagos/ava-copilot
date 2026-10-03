import { Dexie } from 'dexie';
import type { Table } from 'dexie';
import type { ModelConfig } from '../settings/agentModels';
import type { ConfirmRequest } from '../settings/gateSettings';

export type ThreadStatus = 'idle' | 'running' | 'waiting_confirm' | 'error';

// Why a thread stopped with an error: its tab closed, the background restarted, or the task failed
export type ThreadErrorKind = 'tab_closed' | 'interrupted' | 'failed';

export type MessageActor = 'user' | 'system' | 'planner' | 'navigator';

export interface ThreadRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  // The model this thread uses for both agents; null uses the agent models from settings
  model: ModelConfig | null;
  // The tabs the agent may act on, and the tab group holding them when there is more than one
  boundTabIds: number[];
  boundGroupId: number | null;
  // The page the thread was working on, to reopen it when the tab is gone
  boundUrl: string | null;
  status: ThreadStatus;
  error: { kind: ThreadErrorKind; message: string } | null;
  // What the agent is doing right now, e.g. "Planning", while it runs
  activity: string;
  // The task of the current or interrupted run, kept so it can be resumed
  activeTask: string | null;
  runStartedAt: number | null;
  // The request waiting for the user's decision, shown by any panel that opens the thread
  pendingRequest: ConfirmRequest | null;
  pinned: boolean;
  archived: boolean;
  tags: string[];
  // A summary of older turns, so a long thread stays within the model's window
  memory: string;
  // Messages up to this seq are covered by memory
  memoryUpToSeq: number;
  forkedFrom: { threadId: string; seq: number } | null;
}

export interface ThreadMessage {
  id: string;
  threadId: string;
  // Position in the thread, from 1
  seq: number;
  actor: MessageActor;
  content: string;
  ts: number;
}

// Placeholders for M3 and M4, declared now so the schema does not churn
export interface MeetingRecord {
  id: string;
  threadId: string | null;
  startedAt: number;
}

export interface TranscriptSegment {
  id: string;
  meetingId: string;
  tStart: number;
}

export interface KnowledgeItem {
  id: string;
  sourceType: string;
  sourceId: string;
  updatedAt: number;
}

export interface KnowledgeChunk {
  id: string;
  itemId: string;
}

export class AviCopilotDb extends Dexie {
  threads!: Table<ThreadRecord, string>;
  messages!: Table<ThreadMessage, string>;
  meetings!: Table<MeetingRecord, string>;
  segments!: Table<TranscriptSegment, string>;
  kbItems!: Table<KnowledgeItem, string>;
  kbChunks!: Table<KnowledgeChunk, string>;

  constructor(name = 'avi-copilot') {
    super(name);
    // Booleans are not valid IndexedDB keys, so pinned and archived are filtered in memory
    this.version(1).stores({
      threads: 'id, updatedAt, status',
      messages: 'id, threadId, [threadId+seq]',
      meetings: 'id, threadId, startedAt',
      segments: 'id, meetingId, [meetingId+tStart]',
      kbItems: 'id, sourceType, sourceId, updatedAt',
      kbChunks: 'id, itemId',
    });
  }
}

// One database per extension origin, shared by the background and every panel
export const db = new AviCopilotDb();
