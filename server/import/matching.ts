import type { Store } from '../db.js';
import type { ImportWorkspaceView } from '../../shared/order-draft.js';
import { productCandidatesForLine } from '../../shared/import-matching.js';
import { resolveImportCustomer } from './customer-resolution.js';
// Original read-only matching entry point, shared by the manual page and assistant tools.
export function matchDraft(store: Store, w: ImportWorkspaceView) {
  const d = w.draft,
    customers = store.customers(),
    products = store.products();
  const customerResolution = resolveImportCustomer(store, d?.header.buyerName.value || '');
  return {
    revision: w.revision,
    customers,
    products,
    customerRecords: [
      ...customers.map(({ id, name, version, contact, phone, address }) => ({
        id,
        name,
        version,
        contact,
        phone,
        address,
        archived: false,
      })),
      ...customerResolution.candidates.filter((c) => c.archived),
    ],
    customerResolution,
    customerCandidates: customerResolution.candidates,
    productCandidates: d
      ? Object.fromEntries(d.lines.map((l) => [l.id, productCandidatesForLine(l, products)]))
      : {},
    duplicateOrders: d
      ? store
          .orders()
          .filter(
            (o) =>
              !!d.header.purchaseOrderNumber.value &&
              o.externalPurchaseOrder === d.header.purchaseOrderNumber.value,
          )
          .map((o) => ({
            id: o.id,
            number: o.number,
            customerName: o.customerName,
            externalPurchaseOrder: o.externalPurchaseOrder,
          }))
      : [],
  };
}
