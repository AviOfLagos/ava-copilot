import { useEffect, useState } from 'react';
import { t } from '@extension/i18n';
import { followUpDayStorage } from '@extension/storage';
import type { FollowUpDayState } from '@extension/storage';
import { isoDayShort } from './client';
import { FollowUpCard } from './FollowUpCard';

/** The day's picks, kept current as the background changes them (a manual subscribe: no Suspense wraps the Inbox). */
function useDayPicks(): FollowUpDayState | null {
  const [state, setState] = useState<FollowUpDayState | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => void followUpDayStorage.get().then(value => live && setState(value));
    load();
    const unsubscribe = followUpDayStorage.subscribe(load);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  return state;
}

/** What an Inbox item from "followups" holds: a card per follow-up picked for its day, or a line when that day is past. */
export function FollowUpInboxCard({ externalId }: { externalId: string }) {
  const state = useDayPicks();
  const day = /^day:(\d{4}-\d{2}-\d{2})$/.exec(externalId)?.[1];
  if (!day || !state) return null;
  if (state.day !== day) {
    return <p className="text-muted-foreground text-[12.5px]">{t('followups_inbox_other', [isoDayShort(day)])}</p>;
  }
  return (
    <div className="flex flex-col gap-2" data-testid="followup-inbox">
      {state.taskIds.map(id => (
        <FollowUpCard key={id} taskId={id} />
      ))}
    </div>
  );
}
