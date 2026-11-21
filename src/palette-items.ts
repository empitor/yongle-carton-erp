import { operationalSearchText, purchaseState } from '../shared/business/index';
import { readCatalog } from './recordkit/index';
import { orderDisplayStatus } from '../shared/core/index';

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
      group: '订单',
      label: o.number,
      hint: o.customerName + ' · ' + orderDisplayStatus(o),
      target: 'orders?order=' + o.id,
      keywords: [
        o.number,
        o.customerName,
        o.externalPurchaseOrder,
        ...o.lines.map((l) => l.productName + ' ' + (l.customerProductCode || '')),
      ].join(' '),
    })),
    ...purchases.map((p) => ({
      group: '采购单',
      label: p.number,
      hint: p.supplierName + ' · ' + purchaseState(p),
      target: 'purchases?record=' + p.id,
      keywords: [p.number, p.supplierName, ...p.lines.map((l) => l.name)].join(' '),
    })),
    ...customers.map((c) => ({
      group: '客户',
      label: c.name,
      hint: c.contact || c.phone,
      target: 'customers?q=' + encodeURIComponent(c.name),
      keywords: operationalSearchText(c),
    })),
    ...products.map((p) => ({
      group: '产品',
      label: p.name,
      hint: [p.material, p.flute].filter(Boolean).join(' / '),
      target: 'products?q=' + encodeURIComponent(p.name),
      keywords: [p.name, p.material, p.flute, p.customerProductCode].join(' '),
    })),
    ...suppliers.map((s) => ({
      group: '供应商',
      label: s.name,
      hint: s.contact || s.phone,
      target: 'suppliers?q=' + encodeURIComponent(s.name),
      keywords: operationalSearchText(s),
    })),
  ];
}
