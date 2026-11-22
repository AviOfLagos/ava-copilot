import { useEffect, useState } from 'react';
import { t } from '@extension/i18n';

/**
 * A product's budget and beta places as the ledger has them (docs/growth-team.md, Part 9), in the workspace
 * editor. Read-only: the numbers change only when the user answers a request in the Inbox.
 */

interface Ledger {
  budget: { totalUsd: number; spentUsd: number; leftUsd: number } | null;
  betaRule: { testersPerWeek: number; days: number; plan: string } | null;
  betaUsed: number;
  waiting: number;
  held: number;
}

const usd = (value: number) => '$' + value.toFixed(2);

export default function ProductLedger({ workspaceId }: { workspaceId: string }) {
  const [ledger, setLedger] = useState<Ledger | null>(null);

  useEffect(() => {
    let live = true;
    chrome.runtime
      .sendMessage({ type: 'gteam_ledger', workspaceId, requestId: crypto.randomUUID() })
      .then((reply: { type?: string; result?: Ledger } | undefined) => {
        if (live && reply?.type === 'gteam_ok' && reply.result) setLedger(reply.result);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [workspaceId]);

  if (!ledger) return null;
  return (
    <fieldset className="flex flex-col gap-1" data-testid="product-ledger">
      <legend className="text-muted-foreground mb-1 text-[12px]">{t('team_ledger_title')}</legend>
      <p className="text-[12px] leading-snug" data-testid="ledger-budget">
        {ledger.budget
          ? t('team_ledger_budget', [
              usd(ledger.budget.spentUsd),
              usd(ledger.budget.totalUsd),
              usd(ledger.budget.leftUsd),
            ])
          : t('team_ledger_noBudget')}
      </p>
      <p className="text-[12px] leading-snug" data-testid="ledger-beta">
        {ledger.betaRule
          ? t('team_ledger_beta', [String(ledger.betaUsed), String(ledger.betaRule.testersPerWeek)])
          : t('team_ledger_noBeta')}
      </p>
      {ledger.waiting + ledger.held > 0 && (
        <p className="text-muted-foreground text-[11.5px]" data-testid="ledger-waiting">
          {t('team_ledger_waiting', [String(ledger.waiting), String(ledger.held)])}
        </p>
      )}
    </fieldset>
  );
}
