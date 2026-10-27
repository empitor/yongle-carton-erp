import type { Store } from '../db.js';
import type { ImportWorkspaceView } from '../../shared/order-draft.js';
import { normalizedDimensions, normalizeDimensionUnit } from '../../shared/product-details.js';
const key = (v: string) =>
  v
    .replace(/[\s·（）()]/g, '')
    .replace(/有限责任公司|有限公司|宁波市|宁波|浙江省|浙江/g, '')
    .toLowerCase();
// 仅本机读取档案、返回候选；不外发档案，不自动确认或创建。
export function matchDraft(store: Store, w: ImportWorkspaceView) {
  const d = w.draft,
    customers = store.customers(),
    products = store.products();
  return {
    customers,
    products,
    customerCandidates: d
      ? customers
          .filter(
            (c) =>
              key(c.name).includes(key(d.header.buyerName.value || '!')) ||
              key(d.header.buyerName.value || '!').includes(key(c.name)),
          )
          .map((c) => ({ id: c.id, name: c.name, reason: '名称相近，必须人工核对身份' }))
      : [],
    productCandidates: d
      ? Object.fromEntries(
          d.lines.map((l) => [
            l.id,
            products
              .map((p) => {
                const reasons: string[] = [];
                if (key(p.name) === key(l.fields.productName.value || '')) reasons.push('名称一致');
                if (p.customerProductCode && p.customerProductCode === l.fields.productCode.value)
                  reasons.push('物料编码相同，需核对客户归属');
                if (
                  normalizeDimensionUnit(p.dimensionUnit) &&
                  normalizeDimensionUnit(l.fields.dimensionUnit.value) &&
                  normalizedDimensions(p).every(
                    (n, i) =>
                      n !== null &&
                      n ===
                        normalizedDimensions({
                          length: l.fields.length.value ? Number(l.fields.length.value) : null,
                          width: l.fields.width.value ? Number(l.fields.width.value) : null,
                          height: l.fields.height.value ? Number(l.fields.height.value) : null,
                          dimensionUnit: l.fields.dimensionUnit.value,
                        })[i],
                  )
                )
                  reasons.push('尺寸一致');
                if (
                  p.material &&
                  p.flute &&
                  p.material === l.fields.material.value &&
                  p.flute === l.fields.flute.value
                )
                  reasons.push('配纸和楞型一致');
                return { id: p.id, name: p.name, reasons };
              })
              .filter((p) => p.reasons.length),
          ]),
        )
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
