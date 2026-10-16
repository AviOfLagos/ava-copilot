import { useEffect, useMemo, useState } from 'react';
import { t } from '@extension/i18n';
import {
  db,
  getDefaultDisplayNameFromProviderId,
  lastDays,
  lightSavings,
  summarizeUsage,
  totalUsage,
  workspaceStore,
} from '@extension/storage';
import type { UsageDimension, UsageEvent } from '@extension/storage';
import { useLive } from '../hooks/useLive';
import { DayBars, measureOf, RankBars } from './UsageCharts';
import { formatTokens, formatUsd, Section, Segmented } from './ui';
import type { ProvidersState } from './useProviders';

type MessageKey = Parameters<typeof t>[0];
type Range = '7' | '30' | '90';

const DIMENSIONS: { value: UsageDimension; label: MessageKey; none: MessageKey }[] = [
  { value: 'day', label: 'models_usage_byDay', none: 'models_usage_none' },
  { value: 'model', label: 'models_usage_byModel', none: 'models_usage_none' },
  { value: 'agent', label: 'models_usage_byAgent', none: 'models_usage_noAgent' },
  { value: 'workflow', label: 'models_usage_byWorkflow', none: 'models_usage_noWorkflow' },
  { value: 'workspace', label: 'models_usage_byWorkspace', none: 'models_usage_noWorkspace' },
];

/** Usage by day, model, agent, routine or workspace, from the usage events of the last weeks. */
export default function UsageSection({ state }: { state: ProvidersState }) {
  const [range, setRange] = useState<Range>('30');
  const [by, setBy] = useState<UsageDimension>('day');
  const [workspaces, setWorkspaces] = useState<Record<string, string>>({});
  const days = useMemo(() => lastDays(Number(range)), [range]);
  const events = useLive(
    () => db.usageEvents.where('day').aboveOrEqual(days[0]).toArray(),
    [days[0]],
    [] as UsageEvent[],
  );
  const agents = useLive(() => db.agents.toArray(), [], []);
  const workflows = useLive(() => db.workflows.toArray(), [], []);

  useEffect(() => {
    void workspaceStore
      .list()
      .then(list => setWorkspaces(Object.fromEntries(list.map(item => [item.id, item.name]))))
      .catch(() => {});
  }, []);

  const total = useMemo(() => totalUsage(events), [events]);
  const saved = useMemo(() => lightSavings(events), [events]);
  const rows = useMemo(() => summarizeUsage(events, by, by === 'day' ? days : undefined), [events, by, days]);
  const measure = measureOf(by === 'day' ? rows : summarizeUsage(events, 'day', days));
  const dimension = DIMENSIONS.find(item => item.value === by)!;

  const nameOf = (key: string): string => {
    if (!key) return t(dimension.none);
    switch (by) {
      case 'model': {
        const at = key.indexOf(':');
        const providerId = key.slice(0, at);
        const provider = state.saved[providerId]?.name || getDefaultDisplayNameFromProviderId(providerId || '?');
        return `${key.slice(at + 1)} · ${provider}`;
      }
      case 'agent':
        return agents.find(agent => agent.id === key)?.name ?? key;
      case 'workflow':
        return workflows.find(workflow => workflow.id === key)?.name ?? key;
      case 'workspace':
        return workspaces[key] ?? key;
      default:
        return key;
    }
  };

  const chartLabel = t('models_usage_chart', [t(dimension.label), range]);
  return (
    <Section
      label={t('models_usage')}
      action={
        <Segmented
          label={t('models_usage_range')}
          value={range}
          onChange={setRange}
          options={(['7', '30', '90'] as Range[]).map(value => ({ value, label: t('models_usage_days', [value]) }))}
        />
      }>
      <div className="space-y-3 px-3 py-2.5" data-usage-total={total.calls}>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div>
            <div className="font-mono text-[15px]">{formatUsd(total.costUsd)}</div>
            <div className="text-muted-foreground text-[10.5px]">{t('models_usage_cost')}</div>
          </div>
          <div>
            <div className="font-mono text-[15px]">{formatTokens(total.inputTokens + total.outputTokens)}</div>
            <div className="text-muted-foreground text-[10.5px]">{t('models_usage_tokens')}</div>
          </div>
          <div>
            <div className="font-mono text-[15px]">{total.calls}</div>
            <div className="text-muted-foreground text-[10.5px]">{t('models_usage_calls')}</div>
          </div>
        </div>
        {saved.calls > 0 && (
          <p className="text-[11.5px]" data-light-saved={saved.savedUsd}>
            {t('models_usage_lightSaved', [String(saved.calls), formatUsd(saved.savedUsd)])}
          </p>
        )}
        {total.unpricedTokens > 0 && (
          <p className="text-muted-foreground text-[11px]">
            {t('models_usage_unpriced', [formatTokens(total.unpricedTokens)])}
          </p>
        )}
        <Segmented
          label={t('models_usage_by')}
          value={by}
          onChange={setBy}
          options={DIMENSIONS.map(item => ({ value: item.value, label: t(item.label) }))}
        />
        {total.calls === 0 ? (
          <p className="text-muted-foreground text-[12px]">{t('models_usage_none')}</p>
        ) : by === 'day' ? (
          <DayBars rows={rows} label={chartLabel} measure={measure} />
        ) : (
          <RankBars
            rows={rows}
            label={chartLabel}
            measure={measure}
            nameOf={nameOf}
            otherLabel={t('models_usage_other')}
          />
        )}
      </div>
    </Section>
  );
}
