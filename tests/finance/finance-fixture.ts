// 财务测试共用的搭建（只用内存库、虚构数据）：账号、启用财务、记账、直接插单据、找事件和往来、收付款、发票、红冲重做
import type { FlowKind } from '../../shared/core/index.js';
import { pageActor } from '../support/actor-fixture.js';
import { Store, count, one, rows } from '../../server/core/index.js';
import { FinanceSettings } from '../../server/finance/base/settings.js';
import { FinanceEvents } from '../../server/finance/events/events.js';
import { FinanceParties } from '../../server/finance/parties/parties.js';
import { FinanceLedger } from '../../server/finance/ledger/ledger.js';
import { financePermissions } from '../../shared/core/accounts.js';
import { businessBase } from '../support/business-base-fixture.js';
import { FinanceSettlements } from '../../server/finance/cash/settlements.js';
import { FinanceReports } from '../../server/finance/reports/reports.js';
import { FinanceClosing } from '../../server/finance/reports/closing.js';
import { businessChanges, type MirroredFields } from '../support/business-changes-fixture.js';
import { FinanceDue } from '../../server/finance/parties/due.js';
import { FinanceEventHandling } from '../../server/finance/events/event-handling.js';
import { FinanceEventVouchers } from '../../server/finance/events/event-voucher.js';
import { FinanceAllocations } from '../../server/finance/cash/allocations.js';
import { FinanceCashAccounts } from '../../server/finance/cash/cash-accounts.js';
import { FinanceInvoices } from '../../server/finance/cash/invoices.js';
import { FinanceInvoiceConfirm } from '../../server/finance/cash/invoice-confirm.js';
import { FinanceAssets } from '../../server/finance/expenses/assets.js';
import { FinancePayroll } from '../../server/finance/expenses/payroll.js';
import { FinanceCosting } from '../../server/finance/costing/costing.js';
import { must } from '../support/read-result.js';

/** 财务账号：最高管理员带全部财务权限和业务编辑 */
export const maker = pageActor({
  id: 'maker',
  name: '虚构制单员',
  role: 'super_admin' as const,
  permissions: [...financePermissions, 'business:edit'],
});
export const approver = { ...maker, id: 'reviewer', name: '虚构审核员' };
/** 进了超级管理员模式的财务账号（冲销单据、改流水要用） */
export const supervisor = { ...maker, superAdminMode: true, superAdminUntil: Date.now() + 3600000 };

type OpeningRow = { accountCode: string; debit: number; credit: number; yearDebit: number; yearCredit: number };

/**
 * 启用财务（默认 2026-01、一般纳税人、附加税和所得税率填 0），建虚构客户、供应商和银行账户（编号都是 1）；
 * opening 是期初银行存款（分，对实收资本），或直接给期初行。返回收付款服务。
 */
export function newSettings(s: Store, period = '2026-01', opening: number | OpeningRow[] = 0) {
  const settings = new FinanceSettings(s);
  settings.enable(maker, {
    period,
    taxpayer: 'general',
    version: 1,
    requestId: 'enable',
    rows: Array.isArray(opening)
      ? opening
      : opening
        ? [
            { accountCode: '1002', debit: opening, credit: 0, yearDebit: 0, yearCredit: 0 },
            { accountCode: '3001', debit: 0, credit: opening, yearDebit: 0, yearCredit: 0 },
          ]
        : [],
  });
  settings.update(maker, {
    version: 2,
    requestId: 'rates',
    taxRates: { smallVat: null, urban: 0, education: 0, localEducation: 0, income: 0 },
  });
  const base = businessBase(maker, s);
  base.customer();
  base.supplier();
  new FinanceCashAccounts(s).saveAccount(maker, {
    kind: 'bank',
    name: '虚构资金账户',
    accountCode: '1002',
    lastFour: '0001',
    requestId: 'bank',
  });
  return new FinanceSettlements(s);
}

/** 一张凭证提交、审核、记账（制单人是审核员时换人审核） */
export function post(s: Store, key: unknown) {
  const ledger = new FinanceLedger(s),
    id = Number(key);
  const auditor = ledger.get(maker, id).header.maker_id === approver.id ? maker : approver;
  ledger.transition(maker, id, 'submit', { version: 1, requestId: 'submit-' + id });
  ledger.transition(auditor, id, 'approve', { version: 2, requestId: 'approve-' + id });
  ledger.transition(auditor, id, 'post', { version: 3, requestId: 'post-' + id });
}

export function postDrafts(s: Store) {
  for (const r of s.db.prepare("SELECT id FROM fin_vouchers WHERE status='draft' ORDER BY id").all()) post(s, r.id);
}

/**
 * 直接插一张已确认的单据（单号 FICT-编号），单据表的镜像列和 document 同写；单据日期写进内容（和单据日期列一样）。
 * 内容按库里的单据结构写（单据流转、财务都按这个结构读）。送货明细没给订单、订单明细、库存品的，按 1 号订单第几行、2 号库存品补上。
 * 到货明细没有税率字段（到货的税率口径只按供应商的账期设置）：
 * 给的到货明细带了税率口径的，从明细里拿掉，记成这个供应商的默认税率口径（已经设过的不改）。
 * 确认时间 doc.confirmedAt 不给就是单据日期 09:00（UTC）。
 */
export function physical(s: Store, id: number, kind: FlowKind, date: string, doc: PhysicalDoc) {
  const at = date + 'T09:00:00.000Z',
    confirmedAt = doc.confirmedAt ?? at;
  // 生产任务、送货单库里一定有计划日（保存时没写按单据日期补）
  const content =
    kind === 'task'
      ? { plannedDate: date, ...doc }
      : kind === 'delivery'
        ? { plannedDate: date, ...doc, ...deliveryRefs(doc) }
        : kind === 'arrival'
          ? supplierTax(s, doc)
          : doc;
  // 按库里的单据结构核对后写（tests/business-changes-fixture.ts）：造出来的必须是程序自己也会存的样子
  businessChanges(s, maker).confirmed(kind, date, { ...content, confirmedAt }, { id, at });
}

type PhysicalDoc = MirroredFields &{ confirmedAt?: string } & Record<string, unknown>;

/** 送货明细没给的订单、订单明细、库存品补上（1 号订单第几行、2 号库存品）；没有明细的不动 */
function deliveryRefs(doc: Record<string, unknown>) {
  if (!Array.isArray(doc.lines)) return {};
  const lines: unknown[] = doc.lines;
  return {
    lines: lines.map((l, i) => (typeof l === 'object' && l !== null ? { orderId: 1, orderLineId: i + 1, stockId: 2, ...l } : l)),
  };
}

/** 到货明细上的税率口径拿掉，记成供应商的默认税率口径（供应商已经有的不改），返回拿掉以后的单据内容 */
function supplierTax<T extends Record<string, unknown>>(s: Store, doc: T) {
  if (!Array.isArray(doc.lines)) return doc;
  const lines: unknown[] = doc.lines;
  const taxed = lines.find(
    (l): l is { taxRate: string; taxMode: string } =>
      typeof l === 'object' && l !== null && 'taxRate' in l && 'taxMode' in l && !!l.taxRate && !!l.taxMode,
  );
  if (taxed)
    s.db
      .prepare(
        `INSERT INTO fin_party_terms(kind,party_id,party_name,term_days,tax_rate,tax_mode,term_type) VALUES('supplier',?,?,0,?,?,'none')
        ON CONFLICT(kind,party_id) DO UPDATE SET tax_rate=coalesce(tax_rate,excluded.tax_rate),tax_mode=coalesce(tax_mode,excluded.tax_mode)`,
      )
      .run(String(doc.supplierId), '虚构供应商', taxed.taxRate, taxed.taxMode);
  const untaxed = lines.map((l) =>
    typeof l === 'object' && l !== null ? Object.fromEntries(Object.entries(l).filter(([k]) => k !== 'taxRate' && k !== 'taxMode')) : l,
  );
  return { ...doc, lines: untaxed };
}

/**
 * 单据内容：price 是单价，taxed 为 false 时明细不写税率和口径（按往来单位默认或待补），
 * line 并进那一行明细，其余键并进表头（比如更正关系）。
 */
type DocOptions = { price?: string; taxed?: boolean; line?: Record<string, unknown> } & Record<string, unknown>;
const tax = (taxed: boolean): { taxMode?: string; taxRate?: string } => (taxed ? { taxMode: '未税', taxRate: '0' } : {});

/** 送货单：虚构客户 1（订单 1 第 1 行、成品库存品 2），一行 qty 个，默认每个 100 元、未税 0 */
export const deliveryDoc = (qty = '1', { price = '100.0000', taxed = true, line = {}, ...top }: DocOptions = {}) => ({
  customerId: 1,
  customerName: '虚构客户',
  ...top,
  lines: [
    { unit: '个', quantity: qty, unitPriceExact: price, stockId: 2, orderId: 1, orderLineId: 1, productId: 1, ...tax(taxed), ...line },
  ],
});

/** 到货单：虚构供应商 1，一行 qty 张，默认每张 10 元、未税 0，按实际入库计价 */
export const arrivalDoc = (qty = '10', { price = '10.00', taxed = true, line = {}, ...top }: DocOptions = {}) => ({
  supplierId: 1,
  supplierName: '虚构供应商',
  ...top,
  lines: [
    {
      stockId: 1,
      item: { name: '虚构纸板', unit: '张' },
      quantity: qty,
      stockedQuantity: qty,
      unitPrice: price,
      priceBasis: 'quantity',
      ...tax(taxed),
      ...line,
    },
  ],
});

/** 某张单据当前的财务事件（kind 不给时按编号找，同号多种单据取最后建的那条） */
export function event(s: Store, source: number | string, kind?: string) {
  const row = one(
    s.db,
    rows.fin_events,
    `SELECT e.* FROM fin_events e JOIN fin_source_observations x ON e.id=x.event_id
      WHERE x.source_id=? AND (? IS NULL OR x.source_kind=?) ORDER BY e.id DESC LIMIT 1`,
    String(source),
    kind ?? null,
    kind ?? null,
  );
  return must(row, '单据 ' + source + ' 的财务事件');
}

/** 单据当前事件名下最新的一笔正数往来 */
export function obligation(s: Store, source: number, kind?: string) {
  const e = event(s, source, kind);
  const row = one(s.db, rows.fin_obligations, 'SELECT * FROM fin_obligations WHERE event_id=? AND amount_cents>0 ORDER BY id DESC LIMIT 1', e.id);
  return must(row, '财务事件 ' + e.id + ' 的正数往来');
}

/** 按编号读一笔往来（id 可以直接给库里读出来的列值，按数字认） */
export const obligationRow = (s: Store, id: unknown) =>
  must(one(s.db, rows.fin_obligations, 'SELECT * FROM fin_obligations WHERE id=?', Number(id)), '往来 ' + String(id));

/** 直接记一笔虚构客户 1 的应收往来（没有凭证），返回编号 */
export const rawObligation = (s: Store, cents: number, date = '2026-02-10') =>
  Number(
    s.db
      .prepare(
        "INSERT INTO fin_obligations(kind,party_id,party_name,date,amount_cents,description) VALUES('receivable','1','虚构客户',?,?,'虚构送货')",
      )
      .run(date, cents).lastInsertRowid,
  );

/** 同步、给单据当前事件生成凭证并记账，返回事件 */
export function booked(s: Store, source: number, kind?: string) {
  new FinanceEvents(s).sync(maker);
  const e = event(s, source, kind);
  new FinanceEventVouchers(s).generate(maker, e.id, { version: Number(e.version), requestId: 'generate-' + e.id });
  postDrafts(s);
  return event(s, source, kind);
}

/** 到货 10 张、每张 10 元、未税，暂估 100 元记账后返回应付往来编号 */
export function arrived(s: Store, date = '2026-02-05') {
  physical(s, 1, 'arrival', date, arrivalDoc('10'));
  booked(s, 1, 'arrival');
  return Number(obligation(s, 1, 'arrival').id);
}

/** 到货 10 张、每张 10 元暂估记账，再开一张 100 元的采购蓝票关联并记账；返回应付往来编号和发票 */
export function invoicedPayable(s: Store, source: number, date: string, number: string) {
  physical(s, source, 'arrival', date, arrivalDoc('10'));
  booked(s, source, 'arrival');
  const id = Number(obligation(s, source, 'arrival').id);
  const blue = confirmBlue(s, { direction: 'purchase', number, date }, [{ obligationId: id, amount: 10000 }]);
  return { id, blue };
}

/** 一张收付款：收款还是付款、日期、金额（分） */
type CashHead = { kind: 'receipt' | 'payment'; date: string; amount: number };
/** 一张发票：销项还是进项、发票号、开票日期 */
type InvoiceHead = { direction: 'sale' | 'purchase'; number: string; date: string };

/** 确认一张收付款（核销到给的往来，allocations 原样交给确认）并记账，返回资金单编号 */
export function funds(s: Store, service: FinanceSettlements, { kind, date, amount }: CashHead, obligations: unknown[] = []) {
  const saved = service.saveCash(maker, {
    requestId: 'cash-' + kind + date + amount,
    kind,
    accountId: 1,
    partyId: 1,
    date,
    amount,
    method: '银行',
    description: '虚构收付款',
  });
  service.confirm(maker, saved.id, {
    version: 1,
    requestId: 'confirm-cash-' + saved.id,
    allocations: obligations,
  });
  postDrafts(s);
  return Number(saved.id);
}

/** 发票草稿：往来单位 1、默认 2026-01-15、100 元、未税 0；opts 覆盖日期、金额（gross 同时作不含税额）和别的字段 */
export const bill = (
  direction: 'sale' | 'purchase',
  number: string,
  { date = '2026-01-15', gross = 10000, ...extra }: { date?: string; gross?: number } & Record<string, unknown> = {},
) => ({
  requestId: 'invoice-' + number,
  direction,
  type: '虚构数电票',
  number,
  date,
  partyId: 1,
  net: gross,
  rate: '0',
  tax: 0,
  gross,
  ...extra,
});

/** 建蓝票、关联往来、确认并记账；gross 不给是关联金额之和，extra 并进发票（见 bill） */
export function confirmBlue(
  s: Store,
  { direction, number, date, gross, extra = {} }: InvoiceHead & { gross?: number; extra?: Record<string, unknown> },
  links: { obligationId: number; amount: number; estimateAmount?: number }[],
) {
  const invoices = new FinanceInvoices(s);
  const total = gross ?? links.reduce((n, l) => n + l.amount, 0);
  const created = invoices.create(maker, bill(direction, number, { date, gross: total, ...extra }));
  invoices.link(maker, created.id, { version: 1, requestId: 'link-' + number, links });
  new FinanceInvoiceConfirm(s).confirm(maker, created.id, { version: 2, requestId: 'confirm-' + number });
  postDrafts(s);
  return created;
}

/** 按原蓝票开红票（gross 填正数）、确认并记账 */
export function confirmRed(s: Store, { direction, number, date }: InvoiceHead, originalId: number, gross: number, counterAccount?: string) {
  const invoices = new FinanceInvoices(s);
  const red = invoices.create(maker, bill(direction, number, { date, gross: -gross, originalId }));
  new FinanceInvoiceConfirm(s).confirm(maker, red.id, {
    version: 1,
    requestId: 'confirm-' + number,
    ...(counterAccount ? { counterAccount } : {}),
  });
  postDrafts(s);
  return red;
}

/** 总账某科目期末借方净额 */
export const ledgerBalance = (s: Store, code: string, period = '2026-01') =>
  new FinanceReports(s)
    .balances(maker, period)
    .filter((r) => r.account_code.startsWith(code))
    .reduce((n, r) => n + Number(r.ending), 0);

/** 一个月的月末各步：折旧、工资、成本、税费计提，凭证都记账 */
export function monthEndJobs(s: Store, period: string) {
  new FinanceAssets(s).depreciate(maker, { period, requestId: 'depr-' + period });
  new FinancePayroll(s).confirm(maker, { period, requestId: 'payroll-' + period });
  postDrafts(s);
  new FinanceCosting(s).run(maker, { period, requestId: 'cost-' + period });
  postDrafts(s);
  new FinanceClosing(s).accrueTax(maker, { period, requestId: 'tax-' + period });
  postDrafts(s);
}

/** 月末损益结转并记账，结账检查要全部通过，然后结账 */
export function closeMonth(s: Store, period: string) {
  const closing = new FinanceClosing(s);
  closing.settleProfit(maker, { period, requestId: 'profit-' + period });
  postDrafts(s);
  const check = closing.check(maker, { period });
  if (!check.canClose) throw new Error('结账检查没通过：' + JSON.stringify(check.steps));
  const record = must(check.record ?? undefined, period + ' 的结账记录');
  closing.close(maker, { period, version: Number(record.version), requestId: 'close-' + period });
}

/** 借贷不相等的凭证有几张（应该一直是 0） */
export const unbalancedVouchers = (s: Store) =>
  count(s.db, 'SELECT count(*) FROM (SELECT voucher_id FROM fin_entries GROUP BY voucher_id HAVING sum(debit)<>sum(credit))');

/** 往来明细余额合计（正数为对方欠我们 / 我们欠对方） */
export const subledger = (s: Store, kind: 'receivable' | 'payable') =>
  new FinanceParties(s).obligations(maker, { kind, pageSize: 200 }).rows.reduce((n, r) => n + Number(r.balance), 0);

export const eventsStep = (s: Store, period = '2026-01') =>
  must(
    new FinanceClosing(s).check(maker, { period }).steps.find((x) => x.key === 'events'),
    period + ' 结账检查的“业务单据”一步',
  );

/** 逐笔、按单位、到期提醒、收付计划、账龄这些读取里，某一方向的往来各剩什么 */
export function pairViews(s: Store, kind: 'receivable' | 'payable', date = '2026-01-31') {
  const parties = new FinanceParties(s),
    due = new FinanceDue(s);
  return {
    rows: parties.obligations(maker, { kind, pageSize: 200 }).rows,
    held: due.held(maker, { kind, date }).rows,
    soon: due.soon(maker, { date, days: 365, pageSize: 200 }).rows.filter((r) => r.kind === kind),
    plan: due.plan(maker, { date, months: 3, pageSize: 200 }).detail.rows.filter((r) => r.kind === kind),
    aging: parties.aging(maker, { kind, date }).rows,
  };
}

/** 这个单位收付款时系统建议核销的往来（只建一张待确认的资金单，不确认） */
export function suggestedFor(s: Store, cash: FinanceSettlements, kind: 'receipt' | 'payment', date: string) {
  const draft = cash.saveCash(maker, {
    requestId: 'suggest-' + kind + date,
    kind,
    accountId: 1,
    partyId: 1,
    date,
    amount: 100000,
    method: '银行',
    description: '虚构收付款',
  });
  return new FinanceAllocations(s).suggest(maker, draft.id, { date }).allocations.map((a) => a.obligationId);
}

/** 送货（或到货）被撤销后在财务待处理里“红字冲销并重做” */
export function reverseSource(s: Store, source: number, date: string) {
  businessChanges(s, maker).reverse(source);
  new FinanceEvents(s).sync(maker);
  const diff = event(s, source);
  return new FinanceEventHandling(s).correct(maker, diff.id, {
    version: Number(diff.version),
    date,
    requestId: 'correct-' + source,
    reason: '虚构撤销单据',
  });
}

/** 改单据内容里的一项（虚构数据），值按 JSON 写进去，版本号加一 */
export const setDoc = (s: Store, id: number, path: string, value: unknown) => businessChanges(s, maker).edit(id, path, value);
