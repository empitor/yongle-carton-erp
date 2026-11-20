import { z } from 'zod';
import { quantityString, quantityUnits } from '../../shared/core/index.js';
import { purchaseLineAmount } from '../../shared/business/index.js';
import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { many, rows } from '../core/index.js';
import { financeActor } from './core.js';
import { theoreticalMoney } from './amounts.js';
import { purchaseLineItem, purchaseLinesOf, sourceReversed } from './business-source.js';
import { allocationSum } from './obligation-sql.js';
import { pageSql, type FinancePage } from './query.js';
import { redReleasedByObligation } from './red-invoices.js';
import { isReversed } from './reversal-pairs.js';
import { readSnapshot } from './source-snapshot.js';

/** 发票匹配一行：往来一行，加上还欠多少、已开票（确认过的发票，没开过是空）、来源事件快照（JSON 文字） */
const matchingRow = rows.fin_obligations.extend({
  outstanding: z.number(),
  invoiced: z.number().nullable(),
  source: z.string().nullable(),
});
type MatchingRow = z.output<typeof matchingRow>;
const invoice = rows.fin_invoices.shape;
/** 应付关联的一张发票：关联一行，加发票号、日期、状态 */
const linkedInvoice = rows.fin_invoice_links.extend({
  number: invoice.number,
  date: invoice.date,
  status: invoice.status,
});
type LinkedInvoice = z.output<typeof linkedInvoice>;
type PurchaseLine = ReturnType<typeof purchaseLinesOf>[number];
/** 应付的发票匹配一行：加上三单匹配 */
type PayableMatchingRow = MatchingRow & { matching: ReturnType<typeof threeWay> };

/** 按单位合计数量（千分位整数），没有单位的不算 */
function sumByUnit(items: { unit: string | null | undefined; quantity: number }[]) {
  const result = new Map<string, number>();
  for (const item of items)
    if (item.unit) result.set(item.unit, (result.get(item.unit) ?? 0) + item.quantity);
  return result;
}
/** 两边按单位的数量有没有不一样；有一边没有数量时说不上（null） */
const qtyDiff = (a: Map<string, number>, b: Map<string, number>) =>
  a.size && b.size
    ? [...new Set([...a.keys(), ...b.keys()])].some((unit) => a.get(unit) !== b.get(unit))
    : null;

/** 采购明细按单价算出的价税合计（没有计价方式的算不出，是空） */
function purchaseLineView(l: PurchaseLine) {
  const item = purchaseLineItem(l);
  const exact = item.priceBasis ? purchaseLineAmount({ ...item, quantity: quantityString(l.quantity_units) }) : null;
  const amount = exact == null ? null : theoreticalMoney([{ exact }]).gross;
  return { ...l, unit: item.unit, quantity_units: l.quantity_units, amount };
}

/** 应付一行的三单匹配：采购、到货（事件快照）、发票的数量和金额，各自对比；released 扣掉红票冲掉的部分 */
function threeWay(
  o: MatchingRow,
  orders: PurchaseLine[],
  invoices: LinkedInvoice[],
  released: (value: number) => number,
) {
  const purchases = orders.filter((l) => l.obligation_id === o.id).map(purchaseLineView);
  const source =
    o.source === null || o.event_id === null ? null : readSnapshot({ id: o.event_id, snapshot: o.source });
  const lines = source?.doc?.lines ?? [];
  const orderedQty = sumByUnit(purchases.map((p) => ({ unit: p.unit, quantity: p.quantity_units })));
  const stockedQty = sumByUnit(
    lines.flatMap((l) =>
      typeof l.stockedQuantity === 'string'
        ? [{ unit: l.item?.unit, quantity: quantityUnits(l.stockedQuantity) }]
        : [],
    ),
  );
  const invoiceQty = sumByUnit(
    invoices.flatMap((l) => (l.quantity_units == null ? [] : [{ unit: l.unit, quantity: l.quantity_units }])),
  );
  const arrived = source?.theoretical?.gross ?? null;
  const ordered =
    purchases.length && purchases.every((p) => p.amount != null)
      ? purchases.reduce((n, p) => n + Number(p.amount), 0)
      : null;
  const invoiced = invoices.length ? released(invoices.reduce((n, r) => n + r.amount_cents, 0)) : null;
  return {
    purchases,
    invoices,
    orderedQty: Object.fromEntries(orderedQty),
    stockedQty: Object.fromEntries(stockedQty),
    invoiceQty: Object.fromEntries(invoiceQty),
    ordered,
    arrived,
    invoiced,
    orderQuantityDiff: qtyDiff(orderedQty, stockedQty),
    invoiceQuantityDiff: qtyDiff(stockedQty, invoiceQty),
    orderAmountDiff: ordered == null || arrived == null ? null : arrived - ordered,
    invoiceAmountDiff: invoiced == null || arrived == null ? null : invoiced - arrived,
  };
}

/**
 * 发票匹配页：还没开完票的应收应付，已开票按确认过的发票扣掉红票冲掉的部分；
 * 应付另列采购、到货、发票三方的数量和金额对比（三单匹配）。
 */
export class FinanceInvoiceMatching {
  constructor(private readonly store: Store) {}
  private get db() {
    return this.store.db;
  }

  /** 应付：每行带三单匹配 matching */
  list(actor: Actor | null, raw: { kind: 'payable' }): FinancePage<PayableMatchingRow>;
  /** 应收：只有往来一行和已开票 */
  list(actor: Actor | null, raw: { kind: 'receivable' }): FinancePage<MatchingRow>;
  /** 地址上的查询参数：哪一种由 kind 定 */
  list(actor: Actor | null, raw: unknown): FinancePage<MatchingRow> | FinancePage<PayableMatchingRow>;
  list(actor: Actor | null, raw: unknown): FinancePage<MatchingRow> | FinancePage<PayableMatchingRow> {
    financeActor(actor);
    const q = z.object({ kind: z.enum(['receivable', 'payable']) }).parse(raw);
    const list = pageSql(
      this.db,
      {
        schema: matchingRow,
        sql: `SELECT o.*,o.amount_cents-${allocationSum('a.obligation_id=o.id', true)} AS outstanding,
      (SELECT sum(l.amount_cents) FROM fin_invoice_links l JOIN fin_invoices i ON i.id=l.invoice_id
        WHERE l.obligation_id=o.id AND i.status NOT IN ('draft','void')) AS invoiced,e.snapshot AS source
      FROM fin_obligations o LEFT JOIN fin_events e ON e.id=o.event_id LEFT JOIN fin_vouchers v ON v.id=o.voucher_id
      WHERE o.kind=? AND o.tax_status<>'superseded' AND (o.voucher_id IS NULL OR v.status<>'void')
      AND o.reversal_of IS NULL AND NOT ${isReversed('o')}
      -- 已撤销、被更正替代的到货不能再关联发票（invoice-rules.ts），红冲以前也不列
      AND NOT coalesce(e.source_kind='arrival' AND ${sourceReversed('e', 'arrival')},0)
      AND (o.amount_cents>0 OR EXISTS(SELECT 1 FROM fin_invoice_links rl JOIN fin_invoices b ON b.id=rl.invoice_id
        JOIN fin_invoices r ON r.original_id=b.id WHERE rl.obligation_id=o.id AND r.status='red'))`,
        values: [q.kind],
        order: 'date,id',
      },
      raw,
    );
    const released = redReleasedByObligation(this.db, list.rows.map((r) => r.id));
    const net = (id: number, value: number) => value - (released.get(id) || 0);
    // 已开票：只算确认过的发票（不含待确认和作废），扣掉红票冲掉的部分，应收应付两边和往来页口径一致。
    const invoicedRows = list.rows.map((o) =>
      o.invoiced == null ? o : { ...o, invoiced: net(o.id, o.invoiced) },
    );
    if (q.kind === 'receivable') return { ...list, rows: invoicedRows };
    const ids = JSON.stringify(list.rows.map((r) => r.id));
    const linked = many(
      this.db,
      linkedInvoice,
      `SELECT l.*,i.number,i.date,i.status FROM fin_invoice_links l JOIN fin_invoices i ON i.id=l.invoice_id
      WHERE l.obligation_id IN (SELECT value FROM json_each(?)) AND i.status<>'void'`,
      ids,
    );
    const orders = purchaseLinesOf(this.db, ids);
    return {
      ...list,
      rows: invoicedRows.map((o) => {
        const invoices = linked.filter((l) => l.obligation_id === o.id);
        return { ...o, matching: threeWay(o, orders, invoices, (value) => net(o.id, value)) };
      }),
    };
  }
}
