import type { AgentProfile, InboxItem, MeetingRecord } from '@extension/storage';
import { isDraftAgent } from './profile';
import { matchesUrlPattern, tabPatternIssue } from './patterns';

/**
 * When agents wake on their own: pages the user opens (watched address patterns, quieted so a page that
 * loads in several steps or keeps changing wakes an agent once), Inbox items, and topics on the bus. Pure,
 * with time passed in, so it is tested without a browser.
 */

// A page must stay quiet this long after its last change before agents hear of it
export const TAB_DEBOUNCE_MS = 2500;
// The same page wakes the same agent at most once in this time
export const TAB_COOLDOWN_MS = 10 * 60_000;
// And an agent wakes for pages at most this often, whatever the page
export const TAB_MIN_GAP_MS = 60_000;

/** Created, switched on, browser agents: the ones whose triggers may fire. */
export function isAwake(agent: AgentProfile): boolean {
  return !isDraftAgent(agent) && agent.enabled && agent.executor === 'browser';
}

/** The agents watching a page with this address. */
export function agentsWatching(agents: readonly AgentProfile[], url: string): AgentProfile[] {
  return agents.filter(
    agent =>
      isAwake(agent) &&
      agent.triggers.some(
        trigger =>
          trigger.type === 'tab' && !tabPatternIssue(trigger.urlPattern) && matchesUrlPattern(trigger.urlPattern, url),
      ),
  );
}

/** The agents an Inbox item wakes. Items agents or routines left never wake one, so they cannot loop. */
export function agentsForInboxItem(
  agents: readonly AgentProfile[],
  item: Pick<InboxItem, 'source' | 'kind' | 'workspaceId'>,
): AgentProfile[] {
  if (item.source.startsWith('agent:') || item.source.startsWith('workflow:') || item.source === 'system') return [];
  // Approvals and alerts are the copilot's own questions, not news
  if (item.kind === 'approval' || item.kind === 'alert') return [];
  return agents.filter(
    agent =>
      isAwake(agent) &&
      // Workspaces never mix: an agent of one workspace hears only its items (and those of none)
      (!agent.workspaceId || !item.workspaceId || agent.workspaceId === item.workspaceId) &&
      agent.triggers.some(
        trigger =>
          trigger.type === 'inbox' && (!trigger.source || trigger.source.toLowerCase() === item.source.toLowerCase()),
      ),
  );
}

/**
 * The agents a meeting that ended wakes: those with a meeting_ended trigger, in its workspace or in none. An agent
 * in a workspace never hears of a meeting outside it, and an agent that took the notes itself is not woken by them.
 */
export function agentsForMeeting(
  agents: readonly AgentProfile[],
  meeting: Pick<MeetingRecord, 'workspaceId' | 'agentId'>,
): AgentProfile[] {
  return agents.filter(
    agent =>
      isAwake(agent) &&
      agent.id !== meeting.agentId &&
      (!agent.workspaceId || agent.workspaceId === (meeting.workspaceId ?? null)) &&
      agent.triggers.some(trigger => trigger.type === 'meeting_ended'),
  );
}

// The most of a meeting's notes a run is given
const MEETING_DATA_CHARS = 8000;

/** A meeting's notes as a run's data: what was said came from the call, so it is data, never instructions. */
export function meetingData(
  meeting: Pick<MeetingRecord, 'title' | 'note' | 'markdown' | 'startedAt' | 'endedAt' | 'url'>,
): string {
  const note = meeting.note;
  const when = new Date(meeting.startedAt).toISOString().slice(0, 16).replace('T', ' ');
  const lines = [`A meeting ended: "${note?.title || meeting.title}" (${when}).`];
  if (note) {
    if (note.participants.length) lines.push(`Participants: ${note.participants.join(', ')}`);
    if (note.tldr.length) lines.push(`Summary:\n${note.tldr.map(line => `- ${line}`).join('\n')}`);
    if (note.decisions.length) lines.push(`Decisions:\n${note.decisions.map(line => `- ${line}`).join('\n')}`);
    if (note.actionItems.length) {
      lines.push(
        `Action items:\n${note.actionItems
          .map(item => `- ${item.task} (owner: ${item.owner || 'unassigned'}${item.due ? `, due ${item.due}` : ''})`)
          .join('\n')}`,
      );
    }
    if (note.openQuestions.length) {
      lines.push(`Open questions:\n${note.openQuestions.map(line => `- ${line}`).join('\n')}`);
    }
  } else if (meeting.markdown.trim()) {
    lines.push(meeting.markdown.trim());
  }
  return lines.join('\n').slice(0, MEETING_DATA_CHARS);
}

export interface TabEvent {
  tabId: number;
  url: string;
  title: string;
}

interface Timers {
  set: (callback: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
  now: () => number;
}

const realTimers: Timers = {
  set: (callback, ms) => setTimeout(callback, ms),
  clear: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/**
 * Quiets page changes: a tab's updates are held until it has been still for TAB_DEBOUNCE_MS, then the last one
 * is passed on once. A tab closed in the meantime is dropped.
 */
export class TabDebouncer {
  private readonly pending = new Map<number, { event: TabEvent; handle: unknown }>();

  constructor(
    private readonly onSettled: (event: TabEvent) => void,
    private readonly timers: Timers = realTimers,
    private readonly delayMs = TAB_DEBOUNCE_MS,
  ) {}

  observe(event: TabEvent): void {
    const previous = this.pending.get(event.tabId);
    if (previous) this.timers.clear(previous.handle);
    const handle = this.timers.set(() => {
      const settled = this.pending.get(event.tabId);
      this.pending.delete(event.tabId);
      if (settled) this.onSettled(settled.event);
    }, this.delayMs);
    this.pending.set(event.tabId, { event, handle });
  }

  forget(tabId: number): void {
    const previous = this.pending.get(tabId);
    if (previous) this.timers.clear(previous.handle);
    this.pending.delete(tabId);
  }

  get size(): number {
    return this.pending.size;
  }
}

/**
 * Remembers when pages last woke each agent, so the same page wakes it once in TAB_COOLDOWN_MS and pages in
 * general at most every TAB_MIN_GAP_MS.
 */
export class TabCooldown {
  private readonly lastByPage = new Map<string, number>();
  private readonly lastByAgent = new Map<string, number>();

  constructor(
    private readonly cooldownMs = TAB_COOLDOWN_MS,
    private readonly minGapMs = TAB_MIN_GAP_MS,
  ) {}

  /** Whether the page may wake the agent now; if so, it is counted. */
  take(agentId: string, url: string, now: number): boolean {
    const page = `${agentId}|${pageKey(url)}`;
    const lastPage = this.lastByPage.get(page);
    const lastAgent = this.lastByAgent.get(agentId);
    if (lastPage !== undefined && now - lastPage < this.cooldownMs) return false;
    if (lastAgent !== undefined && now - lastAgent < this.minGapMs) return false;
    this.lastByPage.set(page, now);
    this.lastByAgent.set(agentId, now);
    // Old entries are let go, so the map stays small
    for (const [key, at] of this.lastByPage) if (now - at > this.cooldownMs) this.lastByPage.delete(key);
    return true;
  }
}

/** A page's address without its fragment, which changes as a page scrolls or switches views. */
export function pageKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}
