// 走真实单据流程的财务测试底子（虚构数据、内存库）
import { z } from 'zod';
import { FinanceSettings } from '../server/finance/settings.js';
import { FinanceEvents } from '../server/finance/events.js';
import { FinanceParties } from '../server/finance/parties.js';
import { FinanceClosing } from '../server/finance/closing.js';
import { FinanceEventViews } from '../server/finance/event-views.js';
import { FinanceEventVouchers } from '../server/finance/event-voucher.js';
import { FinanceEventHandling } from '../server/finance/event-handling.js';
import { count as countRows, many, one, parseStoredJson, rows } from '../server/core/index.js';
import type { Actor } from '../server/core/auth.js';
import { maker, postDrafts, event } from './finance-fixture.js';
import { receiveLines } from './receive-fixture.js';
import { applyCorrection, previewCorrection } from './receive-fixture.js';
import { correctDocument, planCorrection } from '../server/flow/correction.js';
import { updateDocumentInfo } from '../server/flow/document-info.js';
import { lineMoney } from '../shared/business/operations.js';

type FlowBase = ReturnType<(typeof import('./flow-fixture.js'))['flowFixture']>;
/** 送货要的订单：编号和明细编号（送每张订单的第一行） */
type OrderRef = { id: number; lines: { id: number }[] };

/** 走真实单据流程的底子：内存库、虚构数据，财务从 2026-10 启用，客户订单、供应商都按未税 0 税率。 */
export async function flowFinance() {
  const { flowFixture, localAdmin, clerk } = await import('./flow-fixture.js');
  const { shipOnDocDate } = await import('./ship-date.js');
  const { randomUUID } = await import('node:crypto');
  const f = flowFixture();
  new FinanceSettings(f.store).enable(maker, { period: '2026-10', taxpayer: 'general', version: 1, requestId: 'enable', rows: [] });
  new FinanceParties(f.store).saveTerms(maker, {
    kind: 'supplier',
    partyId: f.supplier.id,
    termDays: 0,
    taxRate: '0',
    taxMode: '未税',
    requestId: 'supplier-tax',
  });
  const events = new FinanceEvents(f.store);
  const sync = () => {
    let processed = 0;
    for (let more = true; more; ) {
      const r = events.sync(maker, { requestId: randomUUID() });
      processed += r.processed;
      more = r.remaining;
    }
    return processed;
  };
  const admin = localAdmin();
  f.stockIn('500');
  const order = f.order(100, { taxRate: '0', taxMode: '未税' });
  /** 送货：默认按带税率的订单；传别的订单（比如没写税率的）可以一张单子送几张订单 */
  const deliver = (quantity: string, orders: OrderRef[] = [order]) => {
    const d = f.draft('delivery', {
      customerId: f.customer.id,
      lines: orders.map((o) => ({ orderId: o.id, orderLineId: o.lines[0].id, stockId: f.finished.id, quantity })),
    });
    return f.confirmId(d.id, shipOnDocDate(f.flow, d.id));
  };
  const reverse = (id: number) =>
    f.flow.reverse(id, { version: f.flow.get(id).version, reason: '虚构：发错', acknowledged: true }, clerk);
  const purchase = arrivalPurchase(f, clerk);
  const receive = (quantity: string, reference: string) =>
    receiveLines(
      f.store,
      purchase.id,
      { date: '2026-10-26', reference, items: [{ lineId: purchase.lines[0].id, quantity }], requestId: randomUUID() },
      clerk,
    ).arrival;
  return {
    f, events, sync, ...documentEdits(f, admin, randomUUID), deliver, reverse, receive,
    correctArrival: arrivalCorrection(f, clerk, purchase.lines[0].id, randomUUID),
    ...financeReads(f), ...financeHandling(f, randomUUID), randomUUID, admin, order,
  };
}

/** 采购单：f.raw 10000 张、1 元/张，已订货（receive 按它登记到货） */
function arrivalPurchase(f: FlowBase, who: Actor) {
  return f.ops.savePurchase(
    {
      supplierId: f.supplier.id,
      orderDate: '2026-10-01',
      status: '已订货',
      lines: [{ stockItemId: f.raw.id, name: f.raw.name, unit: '张', quantity: '10000', unitPrice: '1.0000', priceBasis: 'quantity' }],
    },
    who,
  );
}

/** 已生效单据的改法：info 只改说明、correct 更正（本机管理员）、tamperQuantity 不经程序直接改库 */
function documentEdits(f: FlowBase, admin: Actor, newId: () => string) {
  /** 已生效的单据只改说明（备注这类，server/flow/document-info.ts） */
  const info = (id: number, patch: Record<string, unknown>) =>
    updateDocumentInfo(f.store, id, { ...patch, expectedVersion: f.flow.get(id).version }, admin);
  /** 更正一张已生效的单据（server/flow/correction.ts，本机管理员），返回替代单 */
  const correct = (id: number, input: Record<string, unknown>) => {
    const v = { expectedVersion: f.flow.get(id).version, reason: '虚构：数量登记错了', ...input };
    const digest = planCorrection(f.store, id, v, admin).previewDigest;
    return f.flow.get(correctDocument(f.store, id, { ...v, previewDigest: digest, requestId: newId() }, admin).replacementId);
  };
  /**
   * 不经程序直接改库：把单据每行的数量改掉（按单价重算金额），版本号加一。程序里改数量只能走更正（原单撤销、出替代单），
   * 这里只给“单据被直接改动，财务能发现”的防篡改测试用（finance-source-fingerprint），所以只能直接改库造出来。
   */
  const tamperQuantity = (id: number, quantity: string) => {
    const where = 'flow_documents.document（单据 ' + id + '）';
    const stored = one(f.store.db, rows.flow_documents.pick({ document: true }), 'SELECT document FROM flow_documents WHERE id=?', id);
    if (!stored) throw new Error('测试数据：没有单据 ' + id);
    const doc = parseStoredJson(pricedLines, stored.document, where);
    const lines = doc.lines.map((l) => ({ ...l, quantity, amountExact: lineMoney(quantity, l.unitPriceExact) }));
    f.store.db.prepare('UPDATE flow_documents SET document=?,version=version+1 WHERE id=?').run(JSON.stringify({ ...doc, lines }), id);
  };
  return { info, correct, tamperQuantity };
}
/** 送货单内容里 tamperQuantity 要改的：每行的单价（别的键原样写回） */
const pricedLines = z.looseObject({ lines: z.array(z.looseObject({ unitPriceExact: z.string().nullable() })) });

/** 按采购明细 lineId 更正一张到货单的数量（第 1 行），走预览再提交 */
function arrivalCorrection(f: FlowBase, who: Actor, lineId: number, newId: () => string) {
  return (arrivalId: number, quantity: string) => {
    const record = f.flow.arrivalRecords({ includeInactive: true }).find((r) => r.flowId === arrivalId);
    if (!record) throw new Error('测试数据：没有到货单 ' + arrivalId + ' 的到货记录');
    const input = { expectedVersion: record.version, reason: '虚构：点错数量', items: [{ index: 0, lineId, quantity }] };
    const preview = previewCorrection(f.store, 'flow-' + arrivalId, input, who);
    applyCorrection(f.store, 'flow-' + arrivalId, { ...input, requestId: newId(), previewDigest: preview.previewDigest }, who);
  };
}

/** 财务这边读出来看的：当前事件、事件列表里的一行、单号、事件数、结账检查、还算数的往来、“有差异”的事件数 */
function financeReads(f: FlowBase) {
  /** 某张单据当前对应的财务事件（观察记录指向的那条） */
  const current = (id: number) => event(f.store, id);
  /** 事件列表（前 200 条）里的这个事件，列表里没有就让测试失败 */
  const listed = (eventId: unknown) => {
    const row = new FinanceEventViews(f.store).list(maker, { pageSize: 200 }).rows.find((r) => r.id === Number(eventId));
    if (!row) throw new Error('测试数据：事件列表里没有事件 ' + String(eventId));
    return row;
  };
  const number = (id: number) => {
    const row = one(f.store.db, rows.flow_documents.pick({ number: true }), 'SELECT number FROM flow_documents WHERE id=?', id);
    if (!row) throw new Error('测试数据：没有单据 ' + id);
    return row.number;
  };
  const count = () => countRows(f.store.db, 'SELECT count(*) FROM fin_events');
  const closingOk = () => {
    const step = new FinanceClosing(f.store).check(maker, { period: '2026-10' }).steps.find((x) => x.key === 'events');
    if (!step) throw new Error('结账检查里没有“业务单据”这一步');
    return step.ok;
  };
  /** 某张单据（某种来源）名下还算数的往来：不是红冲记录、没被替代、凭证没作废、没被红冲过 */
  const active = (kind: string, id: number) =>
    many(
      f.store.db,
      rows.fin_obligations,
      `SELECT o.* FROM fin_obligations o JOIN fin_events e ON e.id=o.event_id
        LEFT JOIN fin_vouchers v ON v.id=o.voucher_id
        WHERE e.source_kind=? AND e.source_id=? AND o.reversal_of IS NULL AND o.tax_status<>'superseded'
        AND (o.voucher_id IS NULL OR v.status<>'void')
        AND NOT EXISTS(SELECT 1 FROM fin_obligations r WHERE r.reversal_of=o.id)`,
      kind,
      String(id),
    );
  const differences = () => countRows(f.store.db, "SELECT count(*) FROM fin_events WHERE status='difference'");
  return { current, listed, number, count, closingOk, active, differences };
}

/** 财务处理：book 给单据当前事件生成凭证（post 为真时一并记账）；correctAll 红冲重做“有差异”的事件并记账 */
function financeHandling(f: FlowBase, newId: () => string) {
  const book = (id: number, post = false) => {
    const e = event(f.store, id);
    new FinanceEventVouchers(f.store).generate(maker, e.id, { version: e.version, requestId: newId() });
    if (post) postDrafts(f.store);
    return event(f.store, id);
  };
  const correctAll = (id: number, kind = 'delivery') => {
    const differing = many(
      f.store.db,
      rows.fin_events.pick({ id: true, version: true }),
      "SELECT id,version FROM fin_events WHERE status='difference' AND source_kind=? AND source_id=? ORDER BY id",
      kind,
      String(id),
    );
    for (const row of differing)
      new FinanceEventHandling(f.store).correct(maker, row.id, {
        version: row.version,
        requestId: newId(),
        date: '2026-10-28',
        reason: '虚构：核对后红冲重做',
      });
    postDrafts(f.store);
  };
  return { book, correctAll };
}
