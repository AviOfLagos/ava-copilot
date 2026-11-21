import { getSecret, productApiTokenRef } from '@extension/storage';
import type { ProductProfile } from '@extension/storage';
import { createSutureClient } from '../growth/suture';
import type { BetaRule, RemoteGrants } from './ledger';

/**
 * What the product itself says about beta places: the rule it enforces and how many are left in its own rolling
 * week (the Suture agent API's `GET /`). The product's count is the truth; when it cannot be asked, the ledger's
 * own count stands alone. Read-only: nothing is granted from here.
 */
export async function remoteBeta(
  profile: ProductProfile,
  fetcher: typeof fetch = fetch,
): Promise<(RemoteGrants & { rule: BetaRule | null }) | null> {
  const baseUrl = profile.agentApi?.baseUrl;
  if (!baseUrl) return null;
  const token = await getSecret(productApiTokenRef(profile.workspaceId, baseUrl)).catch(() => null);
  if (!token) return null;
  const read = await createSutureClient(baseUrl, token, fetcher).grants();
  return read.ok ? { remaining: read.value.remaining, rule: read.value.rule } : null;
}
