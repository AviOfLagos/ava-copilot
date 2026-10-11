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
  // The meeting this thread holds the notes of
  meetingId: string | null;
  // The workspace it belongs to: its context and accounts guide the agent, and its knowledge stays there
  workspaceId?: string | null;
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

export type MeetingStatus = 'recording' | 'finishing' | 'done' | 'failed';

// Where the words come from: the tab's audio, or the meeting's own live captions
export type MeetingSource = 'audio' | 'captions';

// Things the user should know while recording
export type MeetingWarning = 'silence' | 'quota' | 'no_mic' | 'tab_closed' | 'cap' | 'transcription' | 'interrupted';

export interface ActionItem {
  owner: string;
  task: string;
  due: string | null;
}

// The structured note made when a meeting ends
export interface MeetingNote {
  title: string;
  tldr: string[];
  decisions: string[];
  actionItems: ActionItem[];
  openQuestions: string[];
  participants: string[];
}

export interface MeetingRecord {
  id: string;
  // The thread that holds the note, so the user can ask about the meeting later
  threadId: string | null;
  tabId: number | null;
  title: string;
  platform: string;
  url: string;
  startedAt: number;
  endedAt: number | null;
  status: MeetingStatus;
  source: MeetingSource;
  withMic: boolean;
  // A summary of the meeting so far, refreshed every few minutes while recording
  rollingSummary: string;
  // When the rolling summary was last refreshed, and the transcript time it covers up to
  summaryAt: number;
  summaryUpTo: number;
  // Summaries of 15-minute blocks, for meetings too long to summarize in one pass
  blockSummaries: { from: number; to: number; summary: string }[];
  note: MeetingNote | null;
  markdown: string;
  warnings: MeetingWarning[];
  // Live captions: the latest remarks, seconds from the start, and how the connection is doing
  liveCaptions: { t: number; text: string }[];
  live: 'off' | 'connecting' | 'on' | 'reconnecting';
  chunksTotal: number;
  chunksDone: number;
  error: string | null;
  // What the call is about, in the user's words or from the calendar; it guides the summary and notes
  topic?: string;
  // Who said what it is about: the user, or a calendar invite, which anyone can send
  topicSource?: 'user' | 'calendar';
  // Started on its own when the user joined a call, rather than by the user
  auto?: boolean;
  // The workspace the call belongs to
  workspaceId?: string | null;
}

export interface AudioChunk {
  id: string;
  meetingId: string;
  index: number;
  // Seconds from the start of the recording
  tStart: number;
  tEnd: number;
  mimeType: string;
  // Base64 audio; cleared once transcribed unless the user keeps audio
  data: string | null;
  status: 'pending' | 'done' | 'failed';
  attempts: number;
  createdAt: number;
  // Written when the recording stopped: nothing follows it
  final: boolean;
}

export interface TranscriptSegment {
  id: string;
  meetingId: string;
  // Seconds from the start of the recording
  tStart: number;
  tEnd: number;
  speaker: string;
  text: string;
  chunkIndex: number;
}

export type KnowledgeSourceType = 'thread' | 'meeting' | 'page' | 'note';

// Where a passage came from, precise enough to open it again
export type KnowledgeAnchor =
  | { kind: 'thread'; threadId: string; seq: number }
  // Seconds from the start of the recording; -1 is the meeting note
  | { kind: 'meeting'; meetingId: string; t: number }
  | { kind: 'page'; url: string }
  // Something the user asked to remember, by voice or in a task
  | { kind: 'note'; itemId: string };

export interface KnowledgeItem {
  id: string;
  sourceType: KnowledgeSourceType;
  // The thread or meeting id, or the page URL
  sourceId: string;
  title: string;
  url: string;
  // When the chat, meeting or saved page happened, for dates in answers and retention
  sourceDate: number;
  // The source's own updatedAt when it was last indexed, to know when it changed
  sourceUpdatedAt: number;
  createdAt: number;
  updatedAt: number;
  chunkCount: number;
  // Chunks still waiting for an embedding; keyword search works without one
  unembedded: number;
  // The workspace of the chat or meeting it came from; a search in one workspace never sees another's
  workspaceId?: string | null;
}

export interface KnowledgeChunk {
  id: string;
  itemId: string;
  index: number;
  text: string;
  // Short place name for a citation, e.g. "12:04" or "message 7"
  label: string;
  anchor: KnowledgeAnchor;
  // A hash of the text, so an unchanged chunk keeps its embedding when its source is indexed again
  hash: string;
  // Unit-length embedding, or null until embedded
  vector: number[] | null;
  embedModel: string | null;
}

export class AviCopilotDb extends Dexie {
  threads!: Table<ThreadRecord, string>;
  messages!: Table<ThreadMessage, string>;
  meetings!: Table<MeetingRecord, string>;
  audioChunks!: Table<AudioChunk, string>;
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
    this.version(2).stores({
      meetings: 'id, threadId, startedAt, status',
      audioChunks: 'id, meetingId, [meetingId+index], status',
    });
    this.version(3).stores({
      kbItems: 'id, sourceType, [sourceType+sourceId], updatedAt, sourceDate',
      kbChunks: 'id, itemId',
    });
  }
}

// One database per extension origin, shared by the background and every panel
export const db = new AviCopilotDb();
