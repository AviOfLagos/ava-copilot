import { t } from '@extension/i18n';
import { productStore, STALE_START_MS, standupStore } from '@extension/storage';
import type { StandupRecord } from '@extension/storage';
import type { BriefExtraSection } from '../../brief/extras';
import {
  briefShouldWait,
  fitWords,
  localDay,
  minuteOfDay,
  STANDUP_LAST_MINUTE,
  STANDUP_MINUTE,
  SUMMARY_WORDS,
} from './plan';
import { standupWorkspaces } from './run';

/**
 * The Team section of the morning brief (docs/growth-team.md, Part 5b): the Growth Lead's standup summary, at most
 * 200 words, or "Standup did not run: <reason>". The brief waits for a running standup until 07:58 (or a while
 * after a late one started); a standup that ends after the brief adds its section to the brief's chat.
 */

const clock = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** What the section says, from today's record, when the standup started, and the time. */
export function teamSectionText(record: StandupRecord | null, started: number | null, now: number): string {
  if (record?.status === 'done') return fitWords(record.summary, SUMMARY_WORDS);
  if (record) return t('brief_team_notRun', [record.reason ?? t('brief_team_noReason')]);
  // A start the background lost says nothing about now
  if (started !== null && now - started >= STALE_START_MS) started = null;
  if (started !== null) return t('brief_team_notRun', [t('brief_team_running', [clock(now)])]);
  const minute = minuteOfDay(now);
  if (minute < STANDUP_MINUTE) return t('brief_team_notRun', [t('brief_team_later')]);
  if (minute < STANDUP_LAST_MINUTE) return t('brief_team_notRun', [t('brief_team_notOpen')]);
  return t('brief_team_notRun', [t('brief_team_skipped')]);
}

async function titleOf(workspaceId: string): Promise<string> {
  const profile = await productStore.forWorkspace(workspaceId).catch(() => undefined);
  return t('brief_team_title', [profile?.name ?? workspaceId]);
}

/** The brief's Team sections: one per workspace whose Growth Lead is switched on. */
export async function teamSections(now: number): Promise<BriefExtraSection[]> {
  const day = localDay(now);
  const sections: BriefExtraSection[] = [];
  for (const workspaceId of await standupWorkspaces()) {
    const [record, started] = await Promise.all([
      standupStore.day(workspaceId, day),
      standupStore.startedAt(workspaceId, day),
    ]);
    sections.push({ title: await titleOf(workspaceId), markdown: teamSectionText(record, started, now), workspaceId });
  }
  return sections;
}

/** Whether the brief should wait for a standup that is running or about to start. */
export async function teamPending(now: number): Promise<boolean> {
  const day = localDay(now);
  for (const workspaceId of await standupWorkspaces()) {
    const [record, started] = await Promise.all([
      standupStore.day(workspaceId, day),
      standupStore.startedAt(workspaceId, day),
    ]);
    if (briefShouldWait(record, started, now)) return true;
  }
  return false;
}

/** The section of a standup that just ended, for a brief that was made before it. */
export async function teamSectionOf(record: StandupRecord): Promise<BriefExtraSection> {
  return {
    title: await titleOf(record.workspaceId),
    markdown: teamSectionText(record, null, record.at),
    workspaceId: record.workspaceId,
  };
}
