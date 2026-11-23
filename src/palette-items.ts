import { operationalSearchText, purchaseState } from '../shared/business/index';
import { readCatalog } from './recordkit/index';
import { orderDisplayStatus, pageHref, pageTitle } from '../shared/core/index';

/** 顶栏搜索（CommandPalette）里的一条：分组、标题、提示、去哪、能搜的字 */
export type PaletteItem = { group: string; label: string; hint?: string; target: string; keywords: string };

/** 搜索面板要读的几份档案 */
export const searched = ['orders', 'customers', 'products', 'purchases', 'suppliers'] as const;
type Searched = Awaited<ReturnType<typeof readCatalog<(typeof searched)[number]>>>;

/**
 * 档案变成搜索条目：单号、名称是标题，客户、状态、联系人这些写在后面，关键词里带上能搜的字。
 * 客户、供应商按什么搜和各自的页面同一份（shared/business 的 operationalSearchText）。
 */
export function catalogItems({ orders, customers, products, purchases, suppliers }: Searched): PaletteItem[] {
  return [
    ...orders.map((o) => ({
      group: pageTitle('orders'),
      label: o.number,
      hint: o.customerName + ' · ' + orderDisplayStatus(o),
      target: pageHref('orders', { order: o.id }),
      keywords: [
        o.number,
        o.customerName,
        o.externalPurchaseOrder,
        ...o.lines.map((l) => l.productName + ' ' + (l.customerProductCode || '')),
      ].join(' '),
    })),
    ...purchases.map((p) => ({
      group: pageTitle('purchases'),
      label: p.number,
      hint: p.supplierName + ' · ' + purchaseState(p),
      target: pageHref('purchases', { record: p.id }),
      keywords: [p.number, p.supplierName, ...p.lines.map((l) => l.name)].join(' '),
    })),
    ...customers.map((c) => ({
      group: pageTitle('customers'),
      label: c.name,
      hint: c.contact || c.phone,
      target: pageHref('customers', { q: c.name }),
      keywords: operationalSearchText(c),
    })),
    ...products.map((p) => ({
      group: pageTitle('products'),
      label: p.name,
      hint: [p.material, p.flute].filter(Boolean).join(' / '),
      target: pageHref('products', { q: p.name }),
      keywords: [p.name, p.material, p.flute, p.customerProductCode].join(' '),
    })),
    ...suppliers.map((s) => ({
      group: pageTitle('suppliers'),
      label: s.name,
      hint: s.contact || s.phone,
      target: pageHref('suppliers', { q: s.name }),
      keywords: operationalSearchText(s),
    })),
  ];
}
