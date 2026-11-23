import { sales } from '../sales/index.js';
import type { Store } from '../core/index.js';
import type { ImportWorkspaceView } from '../../shared/import/index.js';
import { productCandidatesForLine } from '../../shared/import/index.js';
import { resolveImportCustomer } from './customer-resolution.js';
import { ordersWithPurchaseOrder } from './order-lookup.js';
/** 识别结果页和助手共用的“候选”：客户、产品候选和同采购单号的订单。只读。 */
export function matchDraft(store: Store, w: ImportWorkspaceView) {
  const d = w.draft,
    customers = sales(store).customers(),
    products = sales(store).products();
  const customerResolution = resolveImportCustomer(store, d?.header.buyerName.value || '');
  // 已选的客户优先，没选的用按名字唯一对上的那位；新客户只看没定客户的通用产品
  const resolved = customerResolution.state === 'resolved' ? customerResolution.customer.id : null,
    customerId =
      w.mapping?.customer.mode === 'existing'
        ? w.mapping.customer.id
        : w.mapping?.customer.mode === 'new'
          ? null
          : resolved;
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
      ? Object.fromEntries(d.lines.map((l) => [l.id, productCandidatesForLine(l, products, customerId)]))
      : {},
    duplicateOrders: d?.header.purchaseOrderNumber.value
      ? ordersWithPurchaseOrder(store, d.header.purchaseOrderNumber.value)
          .map((o) => ({
            id: o.id,
            number: o.number,
            customerName: o.customerName,
            externalPurchaseOrder: o.externalPurchaseOrder,
          }))
      : [],
  };
}
