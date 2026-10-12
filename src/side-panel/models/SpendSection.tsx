import { useEffect, useState } from 'react';
import { t } from '@extension/i18n';
import {
  DEFAULT_MODEL_SETTINGS,
  EMPTY_USAGE,
  generalSettingsStore,
  localDay,
  modelSettingsStore,
  usageStore,
} from '@extension/storage';
import type { UsageTotals } from '@extension/storage';
import { formatTokens, formatUsd, Section } from './ui';

function Meter({ value, cap }: { value: number; cap: number }) {
  const share = cap > 0 ? Math.min(100, (value / cap) * 100) : 0;
  return (
    <div className="bg-muted mt-2 h-1.5 rounded" aria-hidden="true">
      <div
        className={`h-1.5 rounded ${share >= 100 ? 'bg-destructive' : 'bg-primary'}`}
        style={{ width: `${share}%` }}
      />
    </div>
  );
}

/** Today's spend against the daily caps: dollars for models with a price, tokens for those without. */
export default function SpendSection() {
  const [today, setToday] = useState<UsageTotals>(EMPTY_USAGE);
  const [costCap, setCostCap] = useState(5);
  const [tokenCap, setTokenCap] = useState(DEFAULT_MODEL_SETTINGS.unpricedDailyTokenCap);

  useEffect(() => {
    let alive = true;
    const read = () => void usageStore.getDay(localDay()).then(day => alive && setToday(day));
    read();
    void generalSettingsStore.getSettings().then(settings => alive && setCostCap(settings.dailyCostCapUsd));
    void modelSettingsStore.getSettings().then(settings => alive && setTokenCap(settings.unpricedDailyTokenCap));
    const unsubscribe = usageStore.subscribe(read);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, []);

  const unpriced = today.unpricedTokens ?? 0;
  return (
    <Section label={t('models_spend')}>
      <div className="px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="models-cost-cap" className="text-[13px]">
            {t('models_spend_cost')}
          </label>
          <div className="flex items-center gap-1 font-mono text-[12.5px]">
            <span className="text-muted-foreground" data-spent-today={today.costUsd}>
              {formatUsd(today.costUsd)} /
            </span>
            <span>$</span>
            <input
              id="models-cost-cap"
              type="number"
              min={0}
              step={0.5}
              value={costCap}
              onChange={event => {
                const value = Number.parseFloat(event.target.value);
                if (Number.isFinite(value) && value >= 0) {
                  setCostCap(value);
                  void generalSettingsStore.updateSettings({ dailyCostCapUsd: value });
                }
              }}
              className="bg-card focus:border-primary/50 w-16 rounded-md border px-1.5 py-0.5 text-right outline-none"
            />
          </div>
        </div>
        <Meter value={today.costUsd} cap={costCap} />
        <p className="text-muted-foreground mt-1.5 text-[11px]">{t('models_spend_costHint')}</p>
      </div>
      <div className="px-3 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="models-token-cap" className="text-[13px]">
            {t('models_spend_tokens')}
          </label>
          <div className="flex items-center gap-1 font-mono text-[12.5px]">
            <span className="text-muted-foreground" data-unpriced-today={unpriced}>
              {formatTokens(unpriced)} /
            </span>
            <input
              id="models-token-cap"
              type="number"
              min={0}
              step={100_000}
              value={tokenCap}
              onChange={event => {
                const value = Number.parseInt(event.target.value, 10);
                if (Number.isFinite(value) && value >= 0) {
                  setTokenCap(value);
                  void modelSettingsStore.updateSettings({ unpricedDailyTokenCap: value });
                }
              }}
              className="bg-card focus:border-primary/50 w-24 rounded-md border px-1.5 py-0.5 text-right outline-none"
            />
          </div>
        </div>
        <Meter value={unpriced} cap={tokenCap} />
        <p className="text-muted-foreground mt-1.5 text-[11px]">{t('models_spend_tokensHint')}</p>
      </div>
    </Section>
  );
}
