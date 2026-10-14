/**
 * WhatsApp Web bulk messages: a batch the user pasted or imported, approved once as a whole, and sent from
 * their own open WhatsApp Web tab with random pauses between messages. The background owns every write.
 */

export interface BulkSettings {
  // A random pause between two messages, in seconds
  delayMinSec: number;
  delayMaxSec: number;
  // A longer pause after every this many messages sent
  cooldownEvery: number;
  cooldownMinSec: number;
  cooldownMaxSec: number;
  // At most this many bulk messages a day (hard maximum BULK_HARD_DAILY_CAP)
  dailyCap: number;
}

export const BULK_HARD_DAILY_CAP = 200;
// The shortest pause the user may set between two messages
export const BULK_MIN_DELAY_SEC = 1;
// The most recipients in one batch
export const BULK_MAX_RECIPIENTS = 500;
// The largest attachment a batch may carry
export const BULK_MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
// The longest message after rendering
export const BULK_MAX_MESSAGE_CHARS = 4000;

export const DEFAULT_BULK_SETTINGS: BulkSettings = {
  delayMinSec: 8,
  delayMaxSec: 20,
  cooldownEvery: 10,
  cooldownMinSec: 120,
  cooldownMaxSec: 300,
  dailyCap: 50,
};

export type BulkRecipientStatus = 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';

export interface BulkRecipient {
  // Digits only, with the country code, as WhatsApp's send link wants it
  phone: string;
  name: string;
  // The row as imported, for the report
  fields: Record<string, string>;
  // The template rendered for this row
  message: string;
  status: BulkRecipientStatus;
  // Why it failed or was skipped, in plain words
  reason: string;
  at: number | null;
}

export type BulkRunStatus =
  // Shown to the user with every recipient and message; nothing sends before their click
  | 'awaiting_approval'
  | 'running'
  | 'paused'
  // Paused because the WhatsApp Web tab is closed or signed out; resumes when the user says so
  | 'waiting_tab'
  | 'done'
  | 'stopped'
  | 'declined';

export interface BulkAttachment {
  name: string;
  type: string;
  size: number;
}

export interface BulkRun {
  id: string;
  workspaceId: string | null;
  template: string;
  attachment: BulkAttachment | null;
  settings: BulkSettings;
  recipients: BulkRecipient[];
  status: BulkRunStatus;
  // The batch approval: the id the panel must answer with, and when the user answered
  approvalId: string;
  approvedAt: number | null;
  // Messages sent since the last cooldown
  sinceCooldown: number;
  // When the next message may go; null while nothing is scheduled
  nextAt: number | null;
  // A note for the user, e.g. why the run paused
  note: string;
  createdAt: number;
  updatedAt: number;
}

export interface BulkDailyCount {
  // The local day, "YYYY-MM-DD"
  day: string;
  sent: number;
}
