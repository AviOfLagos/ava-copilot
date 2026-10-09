import { useEffect, useState } from 'react';
import { t } from '@extension/i18n';
import { cn } from '@extension/ui';
import { db, generalSettingsStore, localDay, usageStore } from '@extension/storage';
import { useLive } from '../hooks/useLive';
import { summarizeToday, topSites } from './today';
import type { Today } from './today';

function startOfDay(now = new Date()): number {
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/** Today's numbers, read live from the database. */
export function useToday(): Today | null {
  const [cost, setCost] = useState(0);
  useEffect(() => {
    const read = () => void usageStore.getDay(localDay()).then(day => setCost(day.costUsd));
    read();
    return usageStore.subscribe(read);
  }, []);

  return useLive(
    async () => {
      const dayStart = startOfDay();
      const threads = await db.threads.where('updatedAt').aboveOrEqual(dayStart).toArray();
      const messages = (
        await Promise.all(threads.map(thread => db.messages.where('threadId').equals(thread.id).toArray()))
      ).flat();
      const meetings = await db.meetings
        .where('startedAt')
        .aboveOrEqual(dayStart - 24 * 3_600_000)
        .toArray();
      const segments = (
        await Promise.all(meetings.map(meeting => db.segments.where('meetingId').equals(meeting.id).toArray()))
      ).flat();
      const prefix = (key: 'gate_approved' | 'gate_declinedByUser') => t(key, ['\u0000']).split('\u0000')[0];
      return summarizeToday({
        messages,
        threads,
        meetings,
        segments,
        costUsd: cost,
        approvedPrefix: prefix('gate_approved'),
        declinedPrefix: prefix('gate_declinedByUser'),
        dayStart,
        now: Date.now(),
      });
    },
    [cost],
    null,
  );
}

/** The day as 24 marks: tasks in mint, a click it waited for in amber, calls in periwinkle. */
export function DayStrip({ today, compact = false }: { today: Today; compact?: boolean }) {
  const peak = Math.max(1, ...today.hours.map(hour => hour.tasks + hour.held));
  const nowHour = new Date().getHours();
  return (
    <div>
      <div
        className={cn('grid grid-cols-[repeat(24,minmax(0,1fr))] items-end gap-[3px]', compact ? 'h-8' : 'h-12')}
        role="img"
        aria-label={t('today_strip_label', [String(today.hours.reduce((sum, hour) => sum + hour.tasks, 0))])}>
        {today.hours.map((hour, index) => {
          const total = hour.tasks + hour.held;
          const height = total > 0 ? Math.max(18, (total / peak) * 100) : hour.call ? 100 : 9;
          const heldShare = total > 0 ? (hour.held / total) * 100 : 0;
          return (
            <span
              key={index}
              className={cn('w-full rounded-[2px]', index === nowHour && 'outline outline-1 outline-foreground/60')}
              style={{
                height: `${height}%`,
                background:
                  total > 0
                    ? `linear-gradient(rgb(var(--hold-rgb)) 0 ${heldShare}%, rgb(var(--primary-rgb)) ${heldShare}%)`
                    : hour.call
                      ? 'rgb(var(--call-rgb) / 0.75)'
                      : 'var(--color-muted)',
              }}
            />
          );
        })}
      </div>
      {!compact && (
        <div className="text-muted-foreground mt-1.5 flex justify-between font-mono text-[10px]">
          <span>00</span>
          <span>06</span>
          <span>12</span>
          <span>18</span>
          <span>24</span>
        </div>
      )}
    </div>
  );
}

const usd = (amount: number) => (amount > 0 && amount < 0.01 ? '<$0.01' : `$${amount.toFixed(2)}`);

/**
 * Today: what the copilot did for you, in numbers it really has. Every tile counts something the
 * extension recorded; none is an estimate.
 */
export default function TodayView() {
  const today = useToday();
  const [cap, setCap] = useState(5);
  useEffect(() => {
    void generalSettingsStore.getSettings().then(settings => setCap(settings.dailyCostCapUsd));
  }, []);
  if (!today) return null;

  const tile = 'glass rounded-2xl p-3.5';
  const big = 'font-mono text-[28px] font-medium leading-none tracking-[-0.04em]';
  const heldTotal = today.heldSent + today.heldStopped;
  const sites = topSites(today.sites);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3">
      <div className="flex items-baseline justify-between px-1">
        <h2 className="text-[22px] font-medium tracking-[-0.03em]">{t('today_title')}</h2>
        <span className="text-muted-foreground font-mono text-[11px]">
          {new Date().toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}
        </span>
      </div>

      <section aria-label={t('today_strip')} className={tile}>
        <div className="mb-2.5 flex justify-between">
          <span className="label-mono">{t('today_strip')}</span>
          <span className="text-muted-foreground font-mono text-[10.5px]">{t('today_strip_hint')}</span>
        </div>
        <DayStrip today={today} />
        <div className="text-muted-foreground mt-2 flex gap-3 text-[11px]">
          <span className="flex items-center gap-1.5">
            <span className="bg-primary size-2 rounded-[2px]" />
            {t('today_legend_tasks')}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="bg-hold size-2 rounded-[2px]" />
            {t('today_legend_held')}
          </span>
          <span className="flex items-center gap-1.5">
            <span className="bg-call/75 size-2 rounded-[2px]" />
            {t('today_legend_calls')}
          </span>
        </div>
      </section>

      <section aria-label={t('today_steps')} className={tile}>
        <div className="label-mono">{t('today_steps')}</div>
        <div className="mt-2 flex items-baseline gap-2.5">
          <span className={big}>{today.stepsTaken}</span>
          <span className="text-muted-foreground text-[12px]">{t('today_steps_hint')}</span>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-2.5">
        <section
          aria-label={t('today_held')}
          className="border-hold/35 from-hold/10 to-hold/[0.03] rounded-2xl border bg-gradient-to-b p-3.5">
          <div className="label-mono !text-hold-foreground/80">{t('today_held')}</div>
          <div className={cn(big, 'mt-2 text-hold-foreground')}>{heldTotal}</div>
          <div className="mt-2.5 flex h-[5px] gap-0.5">
            <span className="bg-hold rounded" style={{ flex: today.heldSent || 0.0001 }} />
            <span className="bg-foreground/25 rounded" style={{ flex: today.heldStopped || 0.0001 }} />
          </div>
          <div className="text-muted-foreground mt-1.5 text-[11.5px]">
            {t('today_held_split', [String(today.heldSent), String(today.heldStopped)])}
          </div>
        </section>
        <section aria-label={t('today_words')} className={tile}>
          <div className="label-mono">{t('today_words')}</div>
          <div className={cn(big, 'mt-2')}>{today.wordsCaught.toLocaleString()}</div>
          <div className="text-muted-foreground mt-[18px] text-[11.5px]">
            {t('today_words_hint', [String(today.calls), String(today.callMinutes)])}
          </div>
        </section>
        <section aria-label={t('today_perTask')} className={tile}>
          <div className="label-mono">{t('today_perTask')}</div>
          <div className={cn(big, 'mt-2')}>
            {today.finishedTasks > 0 ? usd(today.costUsd / today.finishedTasks) : '—'}
          </div>
          <div className="text-muted-foreground mt-2 text-[11.5px]">
            {t('today_cap', [usd(today.costUsd), usd(cap)])}
          </div>
          <div className="bg-muted mt-1.5 h-1 rounded">
            <div
              className="bg-primary h-1 rounded"
              style={{ width: `${Math.min(100, (today.costUsd / Math.max(cap, 0.01)) * 100)}%` }}
            />
          </div>
        </section>
        <section aria-label={t('today_finished')} className={tile}>
          <div className="label-mono">{t('today_finished')}</div>
          <div className={cn(big, 'mt-2')}>{today.finishedTasks}</div>
          <div className="text-muted-foreground mt-[18px] text-[11.5px]">{t('today_finished_hint')}</div>
        </section>
      </div>

      {sites.length > 0 && (
        <section aria-label={t('today_sites')} className={tile}>
          <div className="label-mono">{t('today_sites')}</div>
          <div className="mt-3 flex h-2.5 gap-0.5 overflow-hidden rounded-md">
            {sites.map((site, index) => (
              <span
                key={site.host}
                style={{ flex: site.share, background: `rgb(var(--primary-rgb) / ${Math.max(0.2, 1 - index * 0.28)})` }}
              />
            ))}
          </div>
          <div className="text-muted-foreground mt-2.5 grid grid-cols-2 gap-y-1 font-mono text-[11px]">
            {sites.map(site => (
              <span key={site.host} className="truncate">
                {site.host === 'other' ? t('today_sites_other') : site.host} {Math.round(site.share * 100)}%
              </span>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
