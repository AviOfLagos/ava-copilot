import { useEffect, useState } from 'react';
import { t } from '@extension/i18n';
import {
  DEFAULT_BULK_SETTINGS,
  localDay,
  remainingToday,
  toCsv,
  whatsappBulkDailyStore,
  whatsappBulkRunsStore,
  whatsappBulkSettingsStore,
} from '@extension/storage';
import type { BaseStorage, BulkRecipient, BulkRun, BulkSettings } from '@extension/storage';

/** A storage value kept current as the background changes it. Never suspends: `initial` until the first read. */
function useStored<T>(storage: BaseStorage<T>, read: () => Promise<T>, initial: T): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    let live = true;
    const load = () =>
      void read().then(next => {
        if (live) setValue(next);
      });
    load();
    const unsubscribe = storage.subscribe(load);
    return () => {
      live = false;
      unsubscribe();
    };
    // The storage objects are module singletons
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return value;
}

export function useBulkRuns(): BulkRun[] {
  return useStored(whatsappBulkRunsStore, async () => (await whatsappBulkRunsStore.get()) ?? [], []);
}

export function useBulkSettings(): BulkSettings {
  return useStored(whatsappBulkSettingsStore, () => whatsappBulkSettingsStore.getSettings(), DEFAULT_BULK_SETTINGS);
}

/** How many more bulk messages may go today under `cap`. */
export function useRemainingToday(cap: number): number {
  const daily = useStored(
    whatsappBulkDailyStore,
    async () => (await whatsappBulkDailyStore.get()) ?? { day: '', sent: 0 },
    {
      day: '',
      sent: 0,
    },
  );
  return remainingToday(daily, localDay(), cap);
}

export function reasonText(reason: string): string {
  switch (reason) {
    case 'duplicate':
      return t('inbox_wa_reason_duplicate');
    case 'opted_out':
      return t('inbox_wa_reason_optedOut');
    case 'invalid_number':
      return t('inbox_wa_reason_invalidNumber');
    case 'empty_message':
      return t('inbox_wa_reason_emptyMessage');
    case 'too_long':
      return t('inbox_wa_reason_tooLong');
    case 'not_on_whatsapp':
      return t('inbox_wa_reason_notOnWhatsapp');
    case 'stopped':
      return t('inbox_wa_reason_stopped');
    case 'unknown_outcome':
      return t('inbox_wa_reason_unknownOutcome');
    case 'not_loaded':
      return t('inbox_wa_reason_notLoaded');
    default:
      return t('inbox_wa_reason_sendFailed');
  }
}

export function statusText(status: BulkRecipient['status']): string {
  switch (status) {
    case 'sent':
      return t('inbox_wa_status_sent');
    case 'failed':
      return t('inbox_wa_status_failed');
    case 'skipped':
      return t('inbox_wa_status_skipped');
    case 'sending':
      return t('inbox_wa_status_sending');
    default:
      return t('inbox_wa_status_pending');
  }
}

/** The run report as CSV: one row per recipient, with the reason in the user's language. */
export function reportCsv(run: BulkRun): string {
  return toCsv(
    ['phone', 'name', 'status', 'reason', 'time', 'message'],
    run.recipients.map(recipient => [
      recipient.phone,
      recipient.name,
      recipient.status,
      recipient.reason ? reasonText(recipient.reason) : '',
      recipient.at ? new Date(recipient.at).toISOString() : '',
      recipient.message,
    ]),
  );
}

export function counts(run: BulkRun): Record<BulkRecipient['status'], number> {
  const out: Record<BulkRecipient['status'], number> = { pending: 0, sending: 0, sent: 0, failed: 0, skipped: 0 };
  for (const recipient of run.recipients) out[recipient.status] += 1;
  return out;
}
