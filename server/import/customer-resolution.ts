import type { Store } from '../db.js';
import { importNameKey, resolveCustomerCandidates } from '../../shared/import-matching.js';
export const customerNameKey = importNameKey;
/** Only exact names, real historical identity or an explicit current-batch receipt prove identity. */
export function resolveImportCustomer(
  store: Store,
  name: string,
  confirmedCustomerIds: number[] = [],
) {
  const active = new Set(store.customers().map((c) => c.id));
  const historyIds = store
    .orders(true)
    .filter((o) => customerNameKey(o.customerName) === customerNameKey(name))
    .map((o) => o.customerId);
  return resolveCustomerCandidates(
    store.customers(true).map((c) => ({ ...c, archived: !active.has(c.id) })),
    name,
    historyIds,
    confirmedCustomerIds,
  );
}
