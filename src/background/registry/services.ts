import type { MorningBrief } from '../brief/manager';
import type { CalendarWatcher } from '../calendar/watcher';
import type { KnowledgeBase } from '../kb/manager';
import type { MeetingManager } from '../meetings/manager';
import type { ThreadManager } from '../threads/manager';
import type { VoiceManager } from '../voice/manager';

/**
 * The background's core services, for features that register handlers. Set once at startup; read
 * only inside handlers (never at import time, before startup has made them).
 */
export interface Services {
  threads: ThreadManager;
  meetings: MeetingManager;
  kb: KnowledgeBase;
  voice: VoiceManager;
  calendar: CalendarWatcher;
  brief: MorningBrief;
}

let current: Services | null = null;

export function setServices(services: Services): void {
  current = services;
}

export function services(): Services {
  if (!current) throw new Error('The background has not started yet');
  return current;
}
