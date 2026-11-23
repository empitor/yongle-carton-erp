/**
 * 未到票就退货：退货当时按这批到货的暂估单价冲减暂估，不等到票（财务同步时做，events.sync 末尾调用）。
 *
 * 做法和部分到票留余量暂估一样：红冲当时的暂估凭证，按剩下的金额另出一张（凭证来源 purchase_return，
 * module_id 是退货单，红冲的那张也挂到这张退货单上），往来金额、estimate_remaining、estimate_voucher_id 跟着改。
 * 到票时 invoice-blue.ts 只转回剩下的暂估，不用改。退货撤销时同样一红一出，把冲掉的加回来。
 *
 * 退了多少钱：按到货那一行的暂估不含税额 × 退货数量 / 实际入库数量（整数分，proportion 不用浮点）。
 * 这张退货冲了多少按凭证算（returnBooked：挂在它上面的凭证在应付上的净借方），大于 0 是冲过、0 是没冲或已恢复，
 * 不另记状态。成本计算按同一个算法给退货流水计价（returnValue）。
 *
 * 分界：只处理这批到货还没确认过发票的；已到票的退货仍走红字发票。到货凭证还没记账、当前暂估凭证还没记账、
 * 操作人没有财务编辑权限的，这次先不做，下次同步再看（不拦业务）。
 */
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { quantityUnits, today } from '../../../shared/core/index.js';
import { isSuperMode, many, one, rows, type Actor, type Store } from '../../core/index.js';
import { financeFacts } from '../../flow/index.js';
import { financeAudit } from '../base/core.js';
import { proportion } from '../base/amounts.js';
import { readOrSkip } from '../base/unreadable.js';
import { FinanceLedger } from '../ledger/ledger.js';
import { isReversed } from '../base/reversal-pairs.js';
import { entry, row } from '../base/query.js';
import { rescaleInstallments } from '../parties/terms.js';
import { bookingDate } from '../base/periods.js';
import { bookedArrivalEvent } from '../costing/costing-arrivals.js';
import { readSnapshot, type EventSnapshot } from './source-snapshot.js';
import type { VoucherRecord } from '../ledger/voucher-read.js';

const bookedRow = z.object({ id: z.number(), net: z.number() });
/** 这几张退货各冲了多少暂估（分），一次查完：挂在它上面的没作废的凭证在应付（2202）上的净借方；没挂凭证的不在结果里（算 0） */
function returnBooked(db: DatabaseSync, returnIds: readonly number[]) {
  const booked = many(
    db,
    bookedRow,
    `SELECT v.module_id AS id,sum((e.debit-e.credit)*(CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END)) AS net
      FROM fin_vouchers v JOIN fin_entries e ON e.voucher_id=v.id
      WHERE v.module_source='purchase_return' AND v.status<>'void' AND e.account_code LIKE '2202%'
      AND v.module_id IN (SELECT value FROM json_each(?)) GROUP BY v.module_id`,
    JSON.stringify(returnIds),
  );
  return new Map(booked.map((b) => [b.id, b.net]));
}

type ReturnLine = { lineIndex: number; quantity: string };
/** 退货逐行退掉的暂估金额（分）：到货那一行的暂估不含税额 × 退货数量 / 实际入库数量，带上那一行的库存品 */
export function returnLineValues(snapshot: EventSnapshot, lines: ReturnLine[]) {
  return lines.map((l) => {
    const line = snapshot.doc?.lines?.[l.lineIndex];
    const net = Number(snapshot.money?.lines[l.lineIndex]?.net ?? 0);
    const stocked = quantityUnits(line?.stockedQuantity ?? '0');
    return { stockId: Number(line?.stockId), value: stocked ? proportion(net, quantityUnits(l.quantity), stocked) : 0 };
  });
}
/** 退货退掉的暂估金额合计（分） */
export const returnValue = (snapshot: EventSnapshot, lines: ReturnLine[]) =>
  returnLineValues(snapshot, lines).reduce((n, l) => n + l.value, 0);

/**
 * 成本计算给退货流水计价：只算冲过暂估的退货（挂着已记账的退货冲暂估凭证），按到货单记过账的那条事件
 * （bookedArrivalEvent，和撤销到货冲回暂估同一个找法）的暂估单价算。
 * 返回 退货单编号 → 库存品 → { value 退掉的暂估金额, restored 退货撤销后暂估已经加回 }。
 * 没冲过暂估的（已到票后才退的）不在里面，照旧只扣数量，金额由红字发票体现。
 */
export function returnCosts(db: DatabaseSync, returnIds: string[]) {
  const result = new Map<string, Map<number, { value: number; restored: boolean }>>();
  if (!returnIds.length) return result;
  const booked = many(
    db,
    bookedRow,
    `SELECT v.module_id AS id,sum((e.debit-e.credit)*(CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END)) AS net
      FROM fin_vouchers v JOIN fin_entries e ON e.voucher_id=v.id
      WHERE v.module_source='purchase_return' AND v.status='posted' AND e.account_code LIKE '2202%'
      AND v.module_id IN (SELECT value FROM json_each(?)) GROUP BY v.module_id`,
    JSON.stringify(returnIds.map(Number)),
  );
  if (!booked.length) return result;
  const net = new Map(booked.map((b) => [b.id, b.net]));
  for (const r of financeFacts.purchases.returnRows(db, [...net.keys()])) {
    const event = bookedArrivalEvent(db, String(r.arrivalId));
    if (!event) continue;
    const perStock = new Map<number, { value: number; restored: boolean }>();
    for (const l of returnLineValues(readSnapshot(event), financeFacts.purchases.returnLines(r))) {
      const before = perStock.get(l.stockId)?.value ?? 0;
      perStock.set(l.stockId, { value: before + l.value, restored: net.get(r.id) === 0 });
    }
    result.set(String(r.id), perStock);
  }
  return result;
}

/** 挂着暂估的应付：往来一行，加上来源事件的快照（事件、凭证都是联表查到的，不会空着） */
const payableRow = rows.fin_obligations.extend({
  event_id: z.number(),
  voucher_id: z.number(),
  snapshot: rows.fin_events.shape.snapshot,
});
/**
 * 挂着暂估的到货应付（FROM 和 WHERE，o 是往来、e 是到货事件）：到货凭证已生成并记账、没被替代、没被冲销、
 * 还没确认过发票。哪张到货挂着暂估（estimateArrivals）和一张到货挂的那笔（arrivalPayable）同一个条件。
 */
const estimatePayables = `FROM fin_obligations o JOIN fin_events e ON e.id=o.event_id
      JOIN fin_vouchers v ON v.id=o.voucher_id
      WHERE e.source_kind='arrival' AND e.status='generated' AND o.kind='payable'
      AND o.reversal_of IS NULL AND o.tax_status<>'superseded' AND v.status='posted' AND NOT ${isReversed('o')}
      AND NOT EXISTS(SELECT 1 FROM fin_invoice_links l JOIN fin_invoices i ON i.id=l.invoice_id
        WHERE l.obligation_id=o.id AND i.status NOT IN ('draft','void'))`;

/** 这张到货单现在挂着暂估的应付 */
function arrivalPayable(db: DatabaseSync, arrivalId: number) {
  return one(db, payableRow, `SELECT o.*,e.snapshot ${estimatePayables} AND e.source_id=? ORDER BY o.id DESC LIMIT 1`, String(arrivalId));
}

/** 现在挂着暂估应付的到货单编号（退货冲暂估、撤销后加回都只能落在它们上面） */
function estimateArrivals(db: DatabaseSync) {
  return many(db, z.object({ id: z.string() }), `SELECT DISTINCT e.source_id AS id ${estimatePayables}`).map((a) => Number(a.id));
}

/** 一张要记的退货：窗口给的退货单（不带内容原文）和读出来的明细 */
type ReturnToBook = Omit<ReturnType<typeof financeFacts.purchases.returnRows>[number], 'document'> & { lines: ReturnLine[] };
/** 一张退货这次怎么记：凭证日期、摘要、子请求号的前缀，冲减前后的暂估和现在那张暂估凭证，退掉多少、是不是撤销后加回 */
type Rebooking = {
  r: ReturnToBook;
  o: z.output<typeof payableRow>;
  voucher: VoucherRecord | null;
  current: number;
  target: number;
  date: string;
  description: string;
  step: string;
  value: number;
  restore: boolean;
};

/**
 * 红冲现在那张暂估凭证，按冲减（恢复）后的金额另出一张（科目照原来到货那张暂估凭证：借原材料、贷应付供应商），
 * 两张都挂到这张退货单上。返回新出的暂估凭证（冲到 0 的没有）。
 */
function rebookEstimate(store: Store, ledger: FinanceLedger, user: Actor, b: Rebooking): number | null {
  const db = store.db;
  const { r, o, voucher, current, target, date, description, step } = b;
  const tag = (voucherId: number) =>
    db.prepare("UPDATE fin_vouchers SET module_source='purchase_return',module_id=? WHERE id=?").run(r.id, voucherId);
  if (voucher && current) {
    const red = ledger.reverse(
      user,
      voucher.header.id,
      { version: voucher.header.version, requestId: step + ':red', date, description },
      { linked: true },
    );
    tag(red.header.id);
  }
  const template = ledger.get(user, o.voucher_id).entries;
  const material = template.find((e) => e.debit > 0),
    party = template.find((e) => e.auxiliary_kind === 'supplier');
  if (!target || !material || !party) return null;
  const auxiliary = { kind: 'supplier' as const, id: String(party.auxiliary_id), name: String(party.auxiliary_name) };
  return ledger.createLinked(user, 'purchase_return', r.id, {
    date,
    description,
    requestId: step,
    entries: [entry(material.account_code, target, 0), entry(party.account_code, 0, target, auxiliary)],
  }).header.id;
}

/**
 * 一张退货这次能不能记、怎么记（只读）：找不到挂着暂估的应付（已到票、启用前的到货）、金额为 0 或冲成负数、
 * 暂估凭证还没记账的，这次不做，返回 null。补扫前判断有没有要补的和真去记（ReturnEstimates 的 pending、book）都按它。
 */
function planReturn(db: DatabaseSync, ledger: FinanceLedger, user: Actor, r: ReturnToBook): Rebooking | null {
  const o = arrivalPayable(db, r.arrivalId);
  if (!o) return null;
  const value = returnValue(readSnapshot({ id: o.event_id, snapshot: o.snapshot }), r.lines);
  const restore = r.status === 'reversed';
  const current = o.estimate_remaining ?? o.amount_cents;
  const currentVoucher = o.estimate_remaining == null ? o.voucher_id : o.estimate_voucher_id;
  const target = restore ? current + value : current - value;
  if (!value || target < 0) return null;
  const voucher = currentVoucher ? ledger.get(user, currentVoucher) : null;
  if (voucher && voucher.header.status !== 'posted') return null;
  // 冲减记在退货那天；恢复记在撤销退货那天（北京时间），不早于退货日
  // 也不早于现在那张暂估凭证（红冲日期不能早于原凭证），所以同步不会因为日期出错；
  // 那天所在月份已结账的，记到最早没结账月份的 1 号（bookingDate）
  const reversedOn = today(new Date(r.updatedAt));
  const wanted = [restore ? reversedOn : '', r.date, voucher?.header.date ?? ''].reduce((a, b) => (b > a ? b : a));
  const step = 'return-estimate:' + r.id + ':' + (restore ? 'restore' : 'reduce');
  const description = (restore ? '退货撤销恢复暂估 ' : '退货冲暂估 ') + r.number;
  return { r, o, voucher, current, target, date: bookingDate(db, wanted), description, step, value, restore };
}

/** 按 planReturn 记一张退货（冲减暂估，撤销的加回） */
function bookReturn(store: Store, ledger: FinanceLedger, user: Actor, plan: Rebooking) {
  const db = store.db;
  const { r, o, value, restore, target } = plan;
  const before = row(db, 'fin_obligations', o.id);
  const replacement = rebookEstimate(store, ledger, user, plan);
  const amount = o.amount_cents + (restore ? value : -value);
  db.prepare(
    'UPDATE fin_obligations SET amount_cents=?,estimate_remaining=?,estimate_voucher_id=?,version=version+1 WHERE id=?',
  ).run(amount, target, replacement, o.id);
  rescaleInstallments(db, o.id, amount);
  const after = { ...row(db, 'fin_obligations', o.id), returnId: r.id, value };
  financeAudit(store, user, {
    action: restore ? 'return_restore' : 'return_reduce',
    entity: 'fin_obligations',
    id: o.id,
    before,
    after,
  });
}

/** 采购退货暂估只由有财务编辑权限的人（或超级管理员模式）在补扫时记；只能看财务的人补扫时不记 */
const booksReturns = (user: Actor) => isSuperMode(user) || user.permissions.includes('finance:edit');

/**
 * 要在财务记一笔的采购退货（按编号排）：还挂着暂估应付的到货的退货里（向窗口按到货单圈，不读全部退货），
 * 已确认、还没冲过暂估的，和已撤销、冲过还没恢复的。冲没冲过看财务自己记的凭证（returnBooked）。
 * 已经到票、启用前的到货不挂暂估，它们的退货一张都不读。语句条数固定：挂暂估的到货、圈退货、冲过多少各一句。
 */
function returnRowsToBook(db: DatabaseSync) {
  const arrivals = estimateArrivals(db);
  const found = arrivals.length ? financeFacts.purchases.returnsOfArrivals(db, arrivals) : [];
  const booked = found.length ? returnBooked(db, found.map((r) => r.id)) : new Map<number, number>();
  return found.filter((r) => {
    const value = booked.get(r.id) ?? 0;
    return r.status === 'confirmed' ? value === 0 : value > 0;
  });
}

/** 这个人补扫时要看的采购退货：没有财务编辑权限的一张都不看，内容读不出来的逐张跳过（unreadable.ts，键是“purchase_return:编号”） */
function returnsToBook(store: Store, user: Actor): ReturnToBook[] {
  if (!booksReturns(user)) return [];
  return returnRowsToBook(store.db).flatMap(({ document, ...r }) => {
    const record = { kind: 'purchase_return', id: String(r.id), number: r.number, content: document };
    const lines = readOrSkip(store.db, record, () => financeFacts.purchases.returnLines({ ...r, document }));
    return lines ? [{ ...r, lines }] : [];
  });
}

/**
 * 一次补扫里要看的采购退货：只读一次（第一次用到时），判断要不要补（pending）和真去记（book）共用；
 * 记过的从名单里拿掉，同一次补扫的后几批不会再记。没有财务编辑权限的人一张都不看。
 */
export class ReturnEstimates {
  private candidates: ReturnToBook[] | undefined;
  private readonly ledger: FinanceLedger;
  constructor(
    private readonly store: Store,
    private readonly user: Actor,
  ) {
    this.ledger = new FinanceLedger(store);
  }
  private list() {
    this.candidates ??= returnsToBook(this.store, this.user);
    return this.candidates;
  }
  /** 有没有这次真能记的（只读，补扫前判断要不要开写事务，events.ts 的 pending；和记的时候同一个 planReturn） */
  pending() {
    return this.list().some((r) => planReturn(this.store.db, this.ledger, this.user, r) !== null);
  }
  /** 记进暂估：一张一张算了就记（同一张到货的几张退货，后一张按前一张记完的暂估算），返回记了几张 */
  book() {
    const left: ReturnToBook[] = [];
    for (const r of this.list()) {
      const plan = planReturn(this.store.db, this.ledger, this.user, r);
      if (plan) bookReturn(this.store, this.ledger, this.user, plan);
      else left.push(r);
    }
    const done = this.list().length - left.length;
    this.candidates = left;
    return done;
  }
}
