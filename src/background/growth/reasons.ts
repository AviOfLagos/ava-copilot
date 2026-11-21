import { t } from '@extension/i18n';
import type { NoReadingReason } from '@extension/storage';

const REASON_KEYS: Record<NoReadingReason, string> = {
  not_set: 'growth_reason_not_set',
  no_token: 'growth_reason_no_token',
  agent_api_off: 'growth_reason_agent_api_off',
  unauthorized: 'growth_reason_unauthorized',
  unreachable: 'growth_reason_unreachable',
  unexpected_shape: 'growth_reason_unexpected_shape',
  not_available: 'growth_reason_not_available',
  failed: 'growth_reason_failed',
  no_collector: 'growth_reason_no_collector',
};

/** Why a product's numbers are not there, in the user's language. */
export const reasonText = (reason: NoReadingReason | null): string =>
  t((reason ? REASON_KEYS[reason] : 'growth_reason_failed') as Parameters<typeof t>[0]);
