import { Dexie } from 'dexie';
import type { AgentProfile, BusMessage } from '../agents/types';
import type { AmbientSession, AmbientUtterance } from '../ambient/types';
import type { ArtifactRecord } from '../artifacts/types';
import type { InboxItem } from '../inbox/types';
import type { ConnectorRecord, ToolFingerprint } from '../integrations/types';
import type { JobRecord } from '../jobs/types';
import type { ModelCatalogEntry, UsageEvent } from '../models/types';
import type { LogEntry } from '../observability/types';
import type { OnceRecord } from '../once/types';
import type { VocabEntry } from '../vocabulary/types';
import type { NameCandidate, Person } from '../people/types';
import type { WorkspaceSetBy } from '../tasks/types';
import type { GrowthLink, GrowthMetric, GrowthReading, GrowthSourceState } from '../growth/types';
import type {
  FeedbackRecord,
  LedgerEntry,
  SuppressedAddress,
  TeamChannel,
  TeamContact,
  TeamItem,
} from '../growth-team/types';
import type { RunRecord, RunStep, WorkflowRecord } from '../workflows/types';
import type { TaskListRecord } from '../tasks/lists';
import type { Task } from '../tasks/types';
import type { Table } from 'dexie';
import type { ModelConfig } from '../settings/agentModels';
import type { ThreadVoice } from '../settings/voiceEngineSettings';
import type { ConfirmRequest } from '../settings/gateSettings';

export type ThreadStatus = 'idle' | 'running' | 'waiting_confirm' | 'error';

// Why a thread stopped with an error: its tab closed, the background restarted, or the task failed
export type ThreadErrorKind = 'tab_closed' | 'interrupted' | 'failed';

/**
 * Whether trying again can help a run that ended with an error (docs/growth-team.md, Part 2):
 * - 'temporary': the tab closed, the network dropped, the model was overloaded, the background restarted, the
 *   page did not load. Tried again by itself after 1, 5 and 15 minutes.
 * - 'needs_user': a key, a sign-in or a step only the user can do. No retry; one Inbox item saying which step.
 * - 'cannot': the site blocks it, or what was asked for cannot be done. No retry; one Inbox item saying why.
 */
export type FailureClass = 'temporary' | 'needs_user' | 'cannot';

export interface ThreadFailure {
  cls: FailureClass;
  // When the next automatic try is due; null when none is queued
  retryAt: number | null;
  // The Inbox item (and the WhatsApp line) saying the task is stuck is out: there is never a second one
  reported: boolean;
}

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
  // The window that page was in, so it is reopened there (an agent's own window) and not in the user's
  boundWindowId?: number | null;
  status: ThreadStatus;
  error: { kind: ThreadErrorKind; message: string } | null;
  // With an error: its class, and whether another try is queued or the user has been told
  failure?: ThreadFailure | null;
  // How many times the current task was tried again by itself; a new request starts at 0
  autoTries?: number;
  // How often the user started the current task again themself (Retry, Continue): each round may get stuck, and
  // be reported, once
  retryRound?: number;
  // What the agent is doing right now, e.g. "Planning", while it runs
  activity: string;
  // The task of the current or interrupted run, kept so it can be resumed
  activeTask: string | null;
  // The id of that task: the same when it is resumed or retried, new for every new request. Do-once keys start
  // with it (../once), so a retry finds what the task already sent. Absent on chats from before it existed.
  taskRunId?: string | null;
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
  // Who set it: Avi's own pick always wins over a rule's or Ava's, and only things Avi did not place are ever moved
  // for him (docs/pm-desk.md, Part 3). Absent: not known, which counts as not his
  workspaceSetBy?: WorkspaceSetBy;
  // The agent it runs as, when an agent or routine started it
  agentId?: string | null;
  // Who started it: the user typing or talking, an agent, a routine, the morning brief, or the user on WhatsApp
  // (his own words, but he is not at the computer: every commit waits for the panel click)
  origin?: 'user' | 'voice' | 'agent' | 'workflow' | 'brief' | 'whatsapp';
  // A task Ava started in a voice conversation: the voice thread it belongs to, so that thread can link to it
  voiceThreadId?: string | null;
  // How this chat hears and speaks, over Settings
  voice?: ThreadVoice | null;
}

export interface ThreadMessage {
  id: string;
  threadId: string;
  // Position in the thread, from 1
  seq: number;
  actor: MessageActor;
  content: string;
  ts: number;
  // Images and videos the user attached to this message (see ./attachments.ts)
  attachments?: MessageAttachment[];
  // The tasks the code that built this message wrote into it (the brief, a meeting note). Only a task marker whose
  // id is here gets a live checkbox; a marker a model wrote is plain text (src/storage/lib/tasks/markers.ts)
  taskIds?: string[];
  // The code that built this message wrote workspace lines into it (the brief's "Make a workspace" button and the
  // Undo of a rule move); only then are they drawn as buttons (src/storage/lib/workspaces/markers.ts)
  workspaceLines?: boolean;
}

/**
 * A picture or a short video attached to a message, kept with it in IndexedDB. An image is kept whole (it is at
 * most 10 MB); a video keeps only what was sent to the model: its sampled frames and what its audio said.
 */
export interface MessageAttachment {
  id: string;
  kind: 'image' | 'video';
  name: string;
  mediaType: string;
  // Size of the file the user picked, in bytes
  size: number;
  // A small JPEG for the thread
  thumb: Blob;
  // The image itself
  blob?: Blob;
  // A video's frames, as JPEGs, each with its time in seconds
  frames?: { t: number; blob: Blob }[];
  durationSec?: number;
  // What a video's audio said, when a speech model wrote it down
  transcript?: string;
}

export type MeetingStatus = 'recording' | 'finishing' | 'done' | 'failed';

// Where the words come from: the tab's audio, or the meeting's own live captions
export type MeetingSource = 'audio' | 'captions';

// Things the user should know while recording
export type MeetingWarning =
  | 'silence'
  | 'quota'
  | 'no_mic'
  | 'tab_closed'
  | 'cap'
  | 'transcription'
  | 'interrupted'
  // Notes started on captions only, and none arrived: nothing is being taken down
  | 'nothing_captured'
  // The call's captions are off and could not be turned on
  | 'captions_off'
  // The tab's audio stopped mid-call (a reload, a device change): notes went on from the captions
  | 'audio_lost'
  // The note could not be written; Retry tries again
  | 'note_failed';

export interface ActionItem {
  owner: string;
  task: string;
  due: string | null;
  // The task on the board this item is (src/storage/lib/tasks), written by code once the note is saved
  taskId?: string;
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
  // Who set it (see ThreadRecord.workspaceSetBy)
  workspaceSetBy?: WorkspaceSetBy;
  // The agent that took the notes, when one did
  agentId?: string | null;
  // Whether the call shows its captions, as last read from the page (null: no captions button found)
  captionsOn?: boolean | null;
  // Who was on the call: display names read from the page (tiles, and the People panel while it was open).
  // Kept on this computer only (docs/pm-desk.md, rule 5)
  roster?: string[];
  // When notes come from audio: who spoke when, from the call's captions, to name the audio's speakers
  speakerMarks?: SpeakerMark[];
}

// Seconds from the start, and the caption's speaker
export interface SpeakerMark {
  t0: number;
  t1: number;
  speaker: string;
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
  // What the recogniser wrote, kept when the vocabulary changed the text (docs/pm-desk.md, Part 4)
  textRaw?: string;
  chunkIndex: number;
}

// 'ai-session': a conversation brought in from another AI tool's history (Claude Code, Codex, ChatGPT…)
// 'ambient': a session of what Ava heard while only listening (src/background/ambient)
export type KnowledgeSourceType = 'thread' | 'meeting' | 'page' | 'note' | 'ai-session' | 'ambient';

// Where a passage came from, precise enough to open it again
export type KnowledgeAnchor =
  | { kind: 'thread'; threadId: string; seq: number }
  // Seconds from the start of the recording; -1 is the meeting note
  | { kind: 'meeting'; meetingId: string; t: number }
  | { kind: 'page'; url: string }
  // Something the user asked to remember, by voice or in a task
  | { kind: 'note'; itemId: string }
  // When it was said (epoch ms) in an ambient session
  | { kind: 'ambient'; sessionId: string; at: number };

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
  // Who set it (see ThreadRecord.workspaceSetBy); a chat's or meeting's item follows its source and has none
  workspaceSetBy?: WorkspaceSetBy;
  // The agent whose work it came from, for knowledge filtered by agent
  agentId?: string | null;
  // Who may read it (src/background/kb/scope.ts): 'private' to its agent (and Ava and the user), or the whole
  // 'team'. Absent: private when an agent's work made it, else the user's own, which every agent reads.
  scope?: 'private' | 'team';
  // An imported AI session: which tool, which project folder, and which import brought it in
  origin?: { tool: string; project: string | null; importId: string } | null;
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

// What the knowledge graph holds: the sources themselves, and what they talk about
export type GraphNodeType =
  | 'thread'
  | 'meeting'
  | 'page'
  | 'note'
  | 'ai-session'
  | 'ambient'
  | 'person'
  | 'organization'
  | 'project'
  | 'decision'
  | 'action';

export interface GraphNode {
  // A source's node has its knowledge item's id; an entity's id comes from its type, workspace and name,
  // so the same project named in two chats of one workspace is one node
  id: string;
  type: GraphNodeType;
  label: string;
  workspaceId: string | null;
  // The knowledge items that mention it; a node no source mentions any more is removed
  sourceItemIds: string[];
  // For a source: a hash of what was read, so an unchanged source is not read again
  hash?: string;
  // When it happened: a source's date, or the date of the first source that named it
  date: number;
  updatedAt: number;
  // An action's task on the board (src/storage/lib/tasks)
  taskId?: string;
  // A person node's person (../people), once one is known
  personId?: string | null;
}

export type GraphEdgeKind = 'mentions' | 'attended' | 'decided_in' | 'raised_in' | 'assigned_to' | 'part_of';

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  kind: GraphEdgeKind;
  // The source whose reading made this link
  sourceItemId: string;
}

export class AviCopilotDb extends Dexie {
  threads!: Table<ThreadRecord, string>;
  messages!: Table<ThreadMessage, string>;
  meetings!: Table<MeetingRecord, string>;
  audioChunks!: Table<AudioChunk, string>;
  segments!: Table<TranscriptSegment, string>;
  kbItems!: Table<KnowledgeItem, string>;
  kbChunks!: Table<KnowledgeChunk, string>;
  graphNodes!: Table<GraphNode, string>;
  graphEdges!: Table<GraphEdge, string>;
  agents!: Table<AgentProfile, string>;
  bus!: Table<BusMessage, string>;
  workflows!: Table<WorkflowRecord, string>;
  runs!: Table<RunRecord, string>;
  runSteps!: Table<RunStep, string>;
  jobs!: Table<JobRecord, string>;
  inbox!: Table<InboxItem, string>;
  connectors!: Table<ConnectorRecord, string>;
  toolFingerprints!: Table<ToolFingerprint, string>;
  artifacts!: Table<ArtifactRecord, string>;
  modelCatalog!: Table<ModelCatalogEntry, string>;
  usageEvents!: Table<UsageEvent, string>;
  logs!: Table<LogEntry, string>;
  ambientSessions!: Table<AmbientSession, string>;
  ambientUtterances!: Table<AmbientUtterance, string>;
  // Words the recogniser mishears and how to write them (../vocabulary)
  vocabulary!: Table<VocabEntry, string>;
  doOnce!: Table<OnceRecord, string>;
  // The growth numbers (../growth): what was read, whether each day was read, each source's state, links made
  growthMetrics!: Table<GrowthMetric, string>;
  growthReadings!: Table<GrowthReading, string>;
  growthSources!: Table<GrowthSourceState, string>;
  growthLinks!: Table<GrowthLink, string>;
  // The growth team (../growth-team): what its agents proposed, and the ledger of money and beta places
  teamItems!: Table<TeamItem, string>;
  teamLedger!: Table<LedgerEntry, string>;
  // How the Growth Lead sorted each piece of customer feedback (one issue per feedback, three asks open one)
  teamFeedback!: Table<FeedbackRecord, string>;
  teamContacts!: Table<TeamContact, string>;
  teamSuppressed!: Table<SuppressedAddress, string>;
  teamChannels!: Table<TeamChannel, string>;
  tasks!: Table<Task, string>;
  // The task lists Ava sent on WhatsApp, by message id: which tasks each carried (ids only)
  taskLists!: Table<TaskListRecord, string>;
  // People (../people, docs/pm-desk.md Part 5): who is who, and the names not settled yet
  people!: Table<Person, string>;
  peopleNames!: Table<NameCandidate, string>;

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
    this.version(4).stores({
      graphNodes: 'id, type, workspaceId, *sourceItemIds',
      graphEdges: 'id, from, to, sourceItemId',
    });
    // Wave 2: agents, routines, the job runner, the inbox, connectors and usage per agent. Tables are only
    // added (and an agentId index on threads and knowledge), so nothing already stored is rewritten.
    this.version(5).stores({
      threads: 'id, updatedAt, status, agentId',
      kbItems: 'id, sourceType, [sourceType+sourceId], updatedAt, sourceDate, agentId',
      agents: 'id, workspaceId, enabled',
      bus: 'id, topic, createdAt',
      workflows: 'id, workspaceId, status, agentId',
      runs: 'id, kind, workflowId, agentId, status, startedAt',
      runSteps: 'id, runId, [runId+index]',
      jobs: 'id, kind, &key, runAt, status',
      inbox: 'id, &[source+externalId], status, createdAt, workspaceId, agentId',
      connectors: 'id, kind, status',
      toolFingerprints: 'id, connectorId',
      artifacts: 'id, createdAt, agentId',
      modelCatalog: 'id, providerId, local',
      usageEvents: 'id, day, model, agentId, workflowId, workspaceId',
      logs: 'id, at, level, runId',
    });
    // Ambient listening (docs/ambient-plan.md): only added, nothing stored is rewritten
    this.version(6).stores({
      ambientSessions: 'id, startedAt',
      ambientUtterances: 'id, sessionId, [sessionId+startedAt], endedAt',
    });
    // Do-once keys (docs/growth-team.md, Part 2): only added, nothing stored is rewritten
    this.version(7).stores({
      doOnce: 'key, taskId, threadId, startedAt',
    });
    this.version(8).stores({
      growthMetrics: 'id, productId, [productId+metric+date]',
      growthReadings: 'id, productId, [productId+metric+date]',
      growthSources: 'id, productId',
      growthLinks: 'id, productId',
    });
    // The growth team's approvals and ledger (docs/growth-team.md, Part 9): only added
    this.version(9).stores({
      teamItems: 'id, workspaceId, agentId, status, batchId',
      teamLedger: 'id, workspaceId, itemId',
    });
    // v10: the Growth Lead's sorted feedback (#74). Additive
    this.version(10).stores({
      teamFeedback: 'id, workspaceId, topic',
    });
    // v11: the Product Marketing Manager's contacts, the shared suppression list and its channels (#75). Additive
    this.version(11).stores({
      teamContacts: 'id, workspaceId, firstAt',
      teamSuppressed: 'email',
      teamChannels: 'id, workspaceId',
    });
    // v12: the vocabulary (docs/pm-desk.md, Part 4). Additive. Parts 2 and 5 add tables too: whoever merges second
    // takes the next free number
    this.version(12).stores({
      vocabulary: 'id, workspaceId, learnedFrom',
    });
    // v13: the task board (docs/pm-desk.md, Part 2). Additive
    this.version(13).stores({
      tasks: 'id, status, workspaceId, ownerId, [status+workspaceId], updatedAt, *mergedIds',
    });
    // v14: people and the names not settled yet (#107). Additive
    this.version(14).stores({
      people: 'id, nameKey, *aliasKeys, *emails, *phones, *handleKeys, *workspaceIds, updatedAt',
      peopleNames: 'id, &key, status, askedOn, *emails, *phones, *handleKeys, *meetingIds, lastAt',
    });
    // v15: the task lists Ava sent on WhatsApp (docs/pm-desk.md, Part 8). Additive. Parts 3 and 7 add tables too:
    // whoever merges second takes the next free number
    this.version(15).stores({
      taskLists: 'messageId, sentAt',
    });
  }
}

// One database per extension origin, shared by the background and every panel
export const db = new AviCopilotDb();
