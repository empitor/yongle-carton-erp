/**
 * 蓝票确认的凭证和往来：按关联累计分摊不含税额；采购发票冲回原暂估（部分到票留下余量暂估），
 * 开票确认收入的销售发票、整张红冲后重开的把往来加回；最后按发票金额更新各笔往来。
 */
import type { z } from 'zod';
import type { Actor } from '../core/index.js';
import type { Store } from '../core/index.js';
import { one, rows } from '../core/index.js';
import { financeAudit, financeError } from './core.js';
import { proportion } from './amounts.js';
import { hasConfirmedReturn } from './business-source.js';
import type { FinanceEvent } from './event-shared.js';
import { sumOf } from './finance-rows.js';
import { reissueCapacity, type InvoiceDetail } from './invoice-rules.js';
import type { FinanceLedger } from './ledger.js';
import { entry, row } from './query.js';
import { redReleasedByObligation } from './red-invoices.js';
import { rescaleInstallments } from './terms.js';

/** 确认发票时红票、蓝票做凭证共用的内容 */
export type ConfirmContext = {
  user: Actor;
  key: number;
  counterAccount?: string;
  links: InvoiceDetail['links'];
  i: InvoiceDetail['invoice'];
  date: string;
  purchase: boolean;
  auxiliary: { kind: 'supplier' | 'customer'; id: string; name: string };
  net: number;
  tax: number;
  gross: number;
  create: (entries: ReturnType<typeof entry>[]) => ReturnType<FinanceLedger['createLinked']>;
};

/** 一笔往来这次到票要调的：冲回的暂估、剩下的暂估和它的凭证、分到的不含税额、销售重开加回的金额 */
type Adjustment = {
  cleared: number;
  remaining: number;
  estimateVoucher: number | null;
  invoiceNet: number;
  // 销售重开：整张红冲把应收冲到 0 后重开的蓝票，往来金额要加回这么多
  reissued: number;
};

/** 发票的一笔关联：往来、关联、往来的来源事件（没有是 undefined）、这笔分到的不含税额 */
type LinkedAmount = {
  o: z.output<typeof rows.fin_obligations>;
  l: InvoiceDetail['links'][number];
  event: FinanceEvent | undefined;
  invoiceNet: number;
};

/** 销售发票（开票确认收入）的一笔关联：只核对开票额度，整张红冲后重开的整笔加回 */
function saleAdjustment(store: Store, c: ConfirmContext, link: LinkedAmount): Adjustment {
  const db = store.db;
  const { o, l, event, invoiceNet } = link;
  if (event?.revenue_recognition !== 'invoice' || event.status === 'info_pending')
    financeError('开票确认收入只适用于已补齐资料、开票时确认收入的送货单。');
  const prior =
    sumOf(
      db,
      `SELECT coalesce(sum(l.amount_cents),0) AS n FROM fin_invoice_links l
          JOIN fin_invoices i ON i.id=l.invoice_id WHERE l.obligation_id=? AND i.status='normal'`,
      o.id,
      // 被红冲掉的部分不再占开票额度，否则全额红冲后没法重新开票。
    ) - (redReleasedByObligation(db, [o.id], true).get(o.id) || 0);
  // 红票会冲减应收，整张红冲后应收为 0；这时重开的蓝票只能用整张红冲释放的额度，
  // 整笔算重开并把应收加回，和采购重开一样在关联上记对应暂估 0 以示区分。折让红票不释放额度。
  const room = o.amount_cents - prior;
  let reissued = 0;
  if (l.amount_cents > room) {
    const capacity = reissueCapacity(db, o.id, c.key);
    if (room < 0 || l.amount_cents > capacity) financeError('累计开票超过送货价税金额。');
    reissued = l.amount_cents;
  }
  return { cleared: 0, remaining: 0, estimateVoucher: null, invoiceNet, reissued };
}

/** 暂估已经转回：只有原发票整张红冲释放了额度（开错重开）才能再开，按发票直接记账，不再冲暂估。 */
function reissuedPurchase(store: Store, c: ConfirmContext, link: LinkedAmount): Adjustment {
  const { o, l, invoiceNet } = link;
  const capacity = reissueCapacity(store.db, o.id, c.key);
  if (capacity <= 0)
    financeError('该到货单暂估已全部转回，不能再开蓝票；折让红票不释放额度，只有原发票整张红冲后才能重开。');
  if (l.amount_cents > capacity) financeError('重开的发票超过整张红冲释放的额度。');
  return {
    cleared: 0,
    remaining: o.estimate_remaining ?? 0,
    estimateVoucher: o.estimate_voucher_id,
    invoiceNet,
    reissued: 0,
  };
}

/** 采购发票的一笔关联：红冲原暂估凭证，部分到票的剩下部分另做一张余量暂估；暂估已全部转回的只能按整张红冲释放的额度重开 */
function purchaseAdjustment(
  store: Store,
  ledger: FinanceLedger,
  c: ConfirmContext,
  link: LinkedAmount,
): Adjustment {
  const { user, key, i, date, auxiliary, create } = c;
  const { o, l, event, invoiceNet } = link;
  if (!event || event.source_kind !== 'arrival' || event.status !== 'generated')
    financeError('请先补齐到货资料并记账暂估凭证。');
  const estimate = o.estimate_remaining ?? o.amount_cents;
  const estimateVoucher = o.estimate_remaining == null ? o.voucher_id : o.estimate_voucher_id;
  if (!estimate || !estimateVoucher) return reissuedPurchase(store, c, link);
  // 到货退过货：供应商按退货后的数量开票，默认把这批到货的暂估全部转回，差额进到票调差。
  const returned = hasConfirmedReturn(store.db, Number(event.source_id));
  // 暂估是不含税金额，要拿这张发票分到这笔的不含税额来比，不能拿价税合计比，
  // 否则 13% 税率下开到九成左右就会被当成全部到票，把整批暂估都转回。
  if (l.estimate_cents == null && invoiceNet < estimate && !returned)
    financeError('部分到票须填写本次对应的原暂估金额。');
  const cleared = l.estimate_cents ?? estimate;
  if (cleared > estimate) financeError('对应暂估金额超过未调差金额。');
  const original = ledger.get(user, estimateVoucher);
  ledger.reverse(
    user,
    original.header.id,
    {
      version: original.header.version,
      requestId: 'invoice-estimate:' + key + ':' + o.id,
      date,
      description: '到票红冲暂估 ' + i.number,
    },
    { linked: true },
  );
  const remaining = estimate - cleared;
  let replacement: number | null = null;
  if (remaining) {
    const originalMaterial = original.entries.find((e) => e.debit > 0);
    const originalParty = original.entries.find((e) => e.auxiliary_kind === 'supplier');
    if (!originalMaterial || !originalParty) financeError('原暂估凭证科目不明确。');
    replacement = create([
      entry(originalMaterial.account_code, remaining, 0),
      entry(originalParty.account_code, 0, remaining, auxiliary),
    ]).header.id;
  }
  return { cleared, remaining, estimateVoucher: replacement, invoiceNet, reissued: 0 };
}

/** 一笔关联要调的往来：关联和算好的调整 */
type Planned = { l: InvoiceDetail['links'][number]; adjusted: Adjustment };

/** 按发票金额更新各笔往来、分期和关联，待开票的送货事件记成已生成凭证 */
function applyAdjustments(store: Store, c: ConfirmContext, voucher: number, planned: Planned[]) {
  const db = store.db;
  const { user, key, purchase } = c;
  for (const { l, adjusted } of planned) {
    const o = row(db, 'fin_obligations', l.obligation_id);
    const amount = purchase
      ? o.amount_cents - adjusted.cleared + l.amount_cents
      : o.amount_cents + adjusted.reissued;
    db.prepare(
      `UPDATE fin_obligations SET amount_cents=?,voucher_id=?,tax_status='known',
            estimate_voucher_id=?,estimate_remaining=?,version=version+1 WHERE id=?`,
    ).run(amount, voucher, adjusted.estimateVoucher, purchase ? adjusted.remaining : null, o.id);
    // 分期付款按新金额、原比例重算，否则到期提醒、收付计划还按暂估金额算。
    rescaleInstallments(db, o.id, amount);
    db.prepare(
      'UPDATE fin_invoice_links SET estimate_cents=?,net_cents=? WHERE invoice_id=? AND obligation_id=?',
    ).run(purchase ? adjusted.cleared : adjusted.reissued ? 0 : null, adjusted.invoiceNet, key, o.id);
    if (o.event_id)
      db.prepare(
        "UPDATE fin_events SET status='generated',version=version+1 WHERE id=? AND status='waiting_invoice'",
      ).run(o.event_id);
    const after = row(db, 'fin_obligations', o.id);
    financeAudit(store, user, { action: 'invoice', entity: 'fin_obligations', id: o.id, before: o, after });
  }
}

/**
 * 蓝票的凭证（采购发票、开票确认收入的销售发票，或填了对方科目的）：按关联累计分摊不含税额，
 * 采购冲回原暂估（部分到票留下余量暂估），销售整张红冲后重开的把往来加回，最后按发票金额更新各笔往来。
 */
export function blueInvoiceVoucher(store: Store, ledger: FinanceLedger, c: ConfirmContext): number {
  const db = store.db;
  const { counterAccount, links, purchase, auxiliary, net, tax, gross, create } = c;
  const counter = counterAccount ?? (purchase ? '1403' : '5001');
  const entries = purchase
    ? [entry(counter, net, 0), ...(tax ? [entry('22210101', tax, 0)] : []), entry('2202', 0, gross, auxiliary)]
    : [entry('1122', gross, 0, auxiliary), entry(counter, 0, net), ...(tax ? [entry('22210102', 0, tax)] : [])];
  if (links.length && links.reduce((n, l) => n + l.amount_cents, 0) !== gross)
    financeError('生成发票凭证前须明确关联全部价税金额。');
  let cumulative = 0,
    netUsed = 0;
  const planned: Planned[] = [];
  for (const l of links) {
    const o = row(db, 'fin_obligations', l.obligation_id);
    const event = o.event_id
      ? one(db, rows.fin_events, 'SELECT * FROM fin_events WHERE id=?', o.event_id)
      : undefined;
    cumulative += l.amount_cents;
    const apportioned = proportion(net, cumulative, gross),
      invoiceNet = apportioned - netUsed;
    netUsed = apportioned;
    const link = { o, l, event, invoiceNet };
    const adjusted = purchase ? purchaseAdjustment(store, ledger, c, link) : saleAdjustment(store, c, link);
    planned.push({ l, adjusted });
  }
  const voucher = create(entries).header.id;
  applyAdjustments(store, c, voucher, planned);
  return voucher;
}
