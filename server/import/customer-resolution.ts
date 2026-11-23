import { sales } from '../sales/index.js';
import type { Store } from '../core/index.js';
import { resolveCustomerCandidates } from '../../shared/import/index.js';
import { historyCustomerIds } from './order-lookup.js';

/**
 * 按名字对应客户：名字一样、只差公司后缀、以前的订单用过这个名字，或者本批里已确认是同一家，才算同一家。
 * 相近的只列候选。要和全部客户比相似度，所以读一次全部客户（含归档，归档的标出来）。
 */
export function resolveImportCustomer(store: Store, name: string, confirmedCustomerIds: number[] = []) {
  const archived = store.archivedIds('customers');
  return resolveCustomerCandidates(
    sales(store).customers(true).map((c) => ({ ...c, archived: archived.has(c.id) })),
    name,
    historyCustomerIds(store, name),
    confirmedCustomerIds,
  );
}
