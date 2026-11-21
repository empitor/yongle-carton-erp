// 成本计算和采购退货测试共用的搭建：真实单据服务走采购到货、领料完工、送货、退货，开发票、算成本（虚构数据、内存库）
import { randomUUID } from 'node:crypto';
import { PurchaseReturns } from '../server/flow/returns.js';
import { FinanceSettings } from '../server/finance/settings.js';
import { FinanceParties } from '../server/finance/parties.js';
import { FinanceEvents } from '../server/finance/events.js';
import { FinanceReports } from '../server/finance/reports.js';
import { FinanceInvoices } from '../server/finance/invoices.js';
import { FinanceCosting } from '../server/finance/costing.js';
import { shipOnDocDate } from './ship-date.js';
import { FinanceEventVouchers } from '../server/finance/event-voucher.js';
import { FinanceInvoiceConfirm } from '../server/finance/invoice-confirm.js';
import { FinanceEventHandling } from '../server/finance/event-handling.js';
import { applyCorrection, previewCorrection, saveDoc } from './receive-fixture.js';
import { bill, event, maker, newSettings, obligation, obligationRow, postDrafts as postAll, supervisor } from './finance-fixture.js';
import { many, one, rows } from '../server/core/index.js';
import { readCostingDetails } from '../server/finance/costing-details.js';
import type { StockItemBaseView } from '../shared/business/index.js';
import { businessBase } from './business-base-fixture.js';

export { maker };

/** 财务从 2026-02 启用，虚构客户、供应商（按未税 0 税率），走真实单据服务 */
export function fixture() {
  const base = costingBase();
  const sales = salesSide(base);
  return {
    s: base.s,
    costing: base.costing,
    raw: rawMaker(base.base),
    finished: sales.finished,
    receive: receiver(base),
    ...arrivals(base),
    ...invoicing(base),
    produce: sales.produce,
    deliver: sales.deliver,
    ...afterwards(base),
    postDrafts: base.postDrafts,
  };
}

/** 内存库、启用财务、虚构客户和供应商（1 号，未税 0 税率），各个服务；confirm(单据) 预览后核对（出库日按单据日期） */
function costingBase() {
  const base = businessBase(maker),
    { store: s, ops, flow } = base;
  new FinanceSettings(s).enable(maker, { period: '2026-02', taxpayer: 'general', version: 1, requestId: 'enable', rows: [] });
  base.customer();
  base.supplier();
  new FinanceParties(s).saveTerms(maker, { kind: 'supplier', partyId: 1, termDays: 0, taxRate: '0', taxMode: '未税', requestId: 'supplier-tax' });
  const postDrafts = () => postAll(s);
  const confirm = (doc: { id: number }) => base.check(doc, shipOnDocDate(flow, doc.id));
  return {
    base,
    s,
    ops,
    flow,
    events: new FinanceEvents(s),
    invoices: new FinanceInvoices(s),
    costing: new FinanceCosting(s),
    reports: new FinanceReports(s),
    returns: new PurchaseReturns(s),
    postDrafts,
    confirm,
  };
}
type CostingBase = ReturnType<typeof costingBase>;

/** raw() 每调一次建一种新纸板（名称、长度按序号区分） */
function rawMaker(base: ReturnType<typeof businessBase>) {
  let serial = 0;
  return () => {
    serial++;
    return base.raw({ name: '虚构纸板' + serial, length: 1000 + serial, width: 800, dimensionUnit: 'mm' });
  };
}

/**
 * receive(纸板, 日期, 单价)：到货 10 张、默认每张 10 元，生成并记账暂估，返回到货单和应付往来。
 * 送货单号按纸板和日期起，同一种纸不同日期能收几批。
 */
function receiver({ s, ops, flow, events, confirm, postDrafts }: CostingBase) {
  return (item: StockItemBaseView, date = '2026-02-05', unitPrice = '10.0000') => {
    const purchase = ops.savePurchase(
      {
        supplierId: 1,
        orderDate: date,
        status: '已订货',
        lines: [{ ...item, stockItemId: item.id, quantity: '10', unitPrice, priceBasis: 'quantity' }],
      },
      maker,
    );
    const received = confirm(
      saveDoc(
        flow,
        'arrival',
        {
          supplierId: 1,
          date,
          reference: '虚构到货-' + item.id + '-' + date,
          lines: [{ stockId: item.id, purchaseLineId: purchase.lines[0].id, item, quantity: '10', unitPrice, priceBasis: 'quantity' }],
        },
        maker,
      ),
    );
    events.sync(maker, { requestId: randomUUID() });
    const e = event(s, received.id, 'arrival');
    new FinanceEventVouchers(s).generate(maker, e.id, { version: e.version, requestId: randomUUID() });
    postDrafts();
    const payable = obligation(s, received.id, 'arrival').id;
    return { received, payable };
  };
}

/**
 * blue(号码, 日期, [往来, 金额, 部分到票时对应的原暂估][]) 开采购蓝票并确认；
 * red(号码, 日期, 原蓝票, 金额, 对方科目) 开红票并确认（都不记账）
 */
function invoicing({ s, invoices }: CostingBase) {
  const blue = (number: string, date: string, links: [number, number, number?][]) => {
    const net = links.reduce((n, [, amount]) => n + amount, 0);
    const b = invoices.create(maker, bill('purchase', number, { date, gross: net }));
    invoices.link(maker, b.id, {
      version: 1,
      requestId: 'link-' + number,
      links: links.map(([obligationId, amount, estimateAmount]) => ({ obligationId, amount, estimateAmount })),
    });
    new FinanceInvoiceConfirm(s).confirm(maker, b.id, { version: 2, requestId: 'confirm-' + number });
    return b;
  };
  const red = (number: string, date: string, originalId: unknown, net: number, counterAccount?: string) => {
    const r = invoices.create(maker, bill('purchase', number, { date, gross: net, originalId: Number(originalId) }));
    new FinanceInvoiceConfirm(s).confirm(maker, r.id, {
      version: 1,
      requestId: 'confirm-' + number,
      ...(counterAccount ? { counterAccount } : {}),
    });
    return r;
  };
  return { blue, red };
}

/** 成品纸箱和一张 10 只、30 元/只的订单；produce(纸板, 日期, 数量) 领料完工，deliver(日期, 数量) 送货 */
function salesSide({ base, flow, confirm }: CostingBase) {
  const product = base.product();
  const finished = base.finished(product, { name: '虚构纸箱' });
  const produce = (item: StockItemBaseView, date: string, qty: string) =>
    confirm(
      saveDoc(
        flow,
        'production',
        { date, productId: product.id, finishedStockId: finished.id, goodQuantity: qty, operator: '虚构操作员', materials: [{ stockId: item.id, issued: qty }] },
        maker,
      ),
    );
  const order = base.order(
    { id: 1 },
    [base.line(product, 10, { productName: product.name, unitPriceCents: 3000, unitPriceExact: '30.0000' })],
    { orderDate: '2026-02-01', deliveryDate: '2026-02-15', taxRate: '0', taxMode: '未税' },
  );
  const deliver = (date: string, qty: string) =>
    confirm(
      saveDoc(
        flow,
        'delivery',
        { date, customerId: 1, lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: finished.id, quantity: qty }] },
        maker,
      ),
    );
  return { finished, produce, deliver };
}

/**
 * 不经采购单登记的到货、撤销或更正后的财务处理：
 * arrive(纸板, 日期, { unitPrice, quantities }) 核对一张到货单并同步财务（不生成凭证；不给单价就是无单价），各行数量默认一行 10 张；
 * redReverse(日期) 同步财务，把到货“有差异”的事件按这天红字冲销（并重做）、记账；
 * correctArrival(到货单, 数量, 日期) 更正第一行数量（冲回流水挪到这天），财务的处理由测试自己接着 redReverse。
 */
function arrivals({ s, flow, events, confirm, postDrafts }: CostingBase) {
  const arrive = (item: StockItemBaseView, date: string, { unitPrice, quantities = ['10'] }: { unitPrice?: string; quantities?: string[] } = {}) => {
    const lines = quantities.map((quantity) => ({ stockId: item.id, item, quantity, ...(unitPrice ? { unitPrice, priceBasis: 'quantity' } : {}) }));
    const confirmed = confirm(flow.save('arrival', { supplierId: 1, date, reference: '虚构登记到货-' + item.id + '-' + date, lines }, maker));
    events.sync(maker, { requestId: randomUUID() });
    return confirmed;
  };
  const redReverse = (date: string) => {
    events.sync(maker, { requestId: randomUUID() });
    const differing = many(
      s.db,
      rows.fin_events.pick({ id: true, version: true }),
      "SELECT id,version FROM fin_events WHERE status='difference' AND source_kind='arrival' ORDER BY id",
    );
    for (const d of differing)
      new FinanceEventHandling(s).correct(maker, d.id, { version: d.version, date, requestId: randomUUID(), reason: '虚构：撤销或更正后红冲' });
    postDrafts();
  };
  const correctArrival = (arrivalId: number, quantity: string, date: string) => {
    const record = flow.arrivalRecords({ includeInactive: true }).find((r) => r.flowId === arrivalId);
    if (!record) throw new Error('测试数据：没有到货单 ' + arrivalId + ' 的到货记录');
    const input = { expectedVersion: record.version, reason: '虚构：点错数量', items: [{ index: 0, quantity }] };
    const preview = previewCorrection(s, 'flow-' + arrivalId, input, maker);
    applyCorrection(s, 'flow-' + arrivalId, { ...input, requestId: randomUUID(), previewDigest: preview.previewDigest }, maker);
    s.db.prepare("UPDATE stock_movements SET date=? WHERE source_kind='flow_reversal' AND source_id=?").run(date, String(arrivalId));
  };
  return { arrive, redReverse, correctArrival };
}

/** 冲销、退货、算成本和读结果：reverse、reversal、cost、row、costRow、gl、details、returnGoods */
function afterwards({ s, flow, costing, reports, returns, postDrafts }: CostingBase) {
  /** 冲销单据。冲销流水默认记成今天，测试把它挪到指定日期，模拟那天冲销。 */
  const reverse = (doc: { id: number }, date: string) => {
    flow.reverse(doc.id, { version: flow.get(doc.id).version, reason: '虚构冲销', acknowledged: true }, supervisor);
    s.db.prepare("UPDATE stock_movements SET date=? WHERE source_kind='flow_reversal' AND source_id=?").run(date, String(doc.id));
  };
  /** 这张单据冲销时这个库存品的那条冲销流水编号 */
  const reversal = (doc: { id: number }, stockId: number) => {
    const m = one(
      s.db,
      rows.stock_movements.pick({ id: true }),
      "SELECT id FROM stock_movements WHERE source_kind='flow_reversal' AND source_id=? AND item_id=?",
      String(doc.id),
      stockId,
    );
    if (!m) throw new Error('测试数据：单据 ' + doc.id + ' 没有库存品 ' + stockId + ' 的冲销流水');
    return m.id;
  };
  const cost = (period: string, valuations: unknown[] = []) => {
    const result = costing.run(maker, { period, requestId: randomUUID(), valuations });
    postDrafts();
    return result;
  };
  /** 某月某库存品的成本行：入、出、期末的数量和金额（分） */
  const row = (period: string, stockId: number) => {
    const r = one(s.db, rows.fin_inventory_costs, 'SELECT * FROM fin_inventory_costs WHERE period=? AND stock_id=?', period, stockId);
    if (!r) throw new Error('测试数据：' + period + ' 没有库存品 ' + stockId + ' 的成本行');
    return { inQty: r.in_qty, inCents: r.in_cents, outQty: r.out_qty, outCents: r.out_cents, endQty: r.end_qty, endCents: r.end_cents };
  };
  /** 同一行排成数组整行比：入、出、期末的数量和金额 */
  const costRow = (period: string, stockId: number) => {
    const r = row(period, stockId);
    return [r.inQty, r.inCents, r.outQty, r.outCents, r.endQty, r.endCents];
  };
  const gl = (code: string, period: string) =>
    reports
      .balances(maker, period)
      .filter((r) => r.account_code.startsWith(code))
      .reduce((n, r) => n + r.ending, 0);
  /** 某月成本计算执行记录的明细（按成本计算自己的结构读） */
  const details = (period: string) => {
    const job = one(s.db, rows.fin_period_jobs.pick({ details: true }), "SELECT details FROM fin_period_jobs WHERE kind='costing' AND period=?", period);
    if (!job) throw new Error('测试数据：' + period + ' 还没算过成本');
    return readCostingDetails({ period, details: job.details });
  };
  const returnGoods = (arrivalId: number, date: string, quantity: string) =>
    returns.create(maker, { arrivalId, date, reason: '虚构质量问题', requestId: randomUUID(), lines: [{ lineIndex: 0, quantity }] });
  return { reverse, reversal, cost, row, costRow, gl, details, returnGoods };
}

/** 采购退货测试：财务从 2026-02 启用，经单据服务到货 10 张、每张 10 元、未税，暂估记账 */
export function returnFixture(start = '2026-02') {
  const base = businessBase(maker),
    { store: s, ops, flow } = base;
  newSettings(s, start);
  const events = new FinanceEvents(s),
    invoices = new FinanceInvoices(s),
    cost = new FinanceCosting(s),
    reports = new FinanceReports(s),
    returns = new PurchaseReturns(s);
  const raw = base.raw({ length: 1000, width: 800, dimensionUnit: 'mm' });
  const purchase = ops.savePurchase(
    {
      supplierId: 1,
      orderDate: '2026-02-01',
      status: '已订货',
      lines: [{ ...raw, stockItemId: raw.id, quantity: '10', unitPrice: '10.0000', priceBasis: 'quantity' }],
    },
    maker,
  );
  new FinanceParties(s).saveTerms(maker, { kind: 'supplier', partyId: 1, termDays: 0, taxRate: '0', taxMode: '未税', requestId: 'supplier-tax' });
  const saved = saveDoc(
    flow,
    'arrival',
    {
      supplierId: 1,
      date: '2026-02-05',
      reference: '虚构到货',
      lines: [
        { stockId: raw.id, purchaseLineId: purchase.lines[0].id, item: raw, quantity: '10', unitPrice: '10.0000', priceBasis: 'quantity' },
      ],
    },
    maker,
  );
  const received = base.check(saved);
  events.sync(maker, { requestId: 'physical' });
  new FinanceEventVouchers(s).generate(maker, event(s, received.id).id, { version: 1, requestId: 'arrival-event' });
  postAll(s);
  const payable = Number(obligation(s, received.id).id);
  const ledger = (code: string) =>
    reports.balances(maker, '2026-02').filter((r) => r.account_code.startsWith(code)).reduce((n, r) => n + r.ending, 0);
  /** 算 2026-02 的成本，读纸板那一行的入库数量、入库金额、期末数量 */
  const costed = () => {
    cost.run(maker, { period: '2026-02', requestId: 'cost-' + randomUUID() });
    const r = one(
      s.db,
      rows.fin_inventory_costs.pick({ in_qty: true, in_cents: true, end_qty: true }),
      'SELECT in_qty,in_cents,end_qty FROM fin_inventory_costs WHERE period=? AND stock_id=?',
      '2026-02',
      raw.id,
    );
    if (!r) throw new Error('测试数据：2026-02 没有纸板的成本行');
    return r;
  };
  const amount = () => obligationRow(s, payable).amount_cents;
  return { s, ops, flow, returns, invoices, raw, purchase, received, payable, ledger, costed, amount };
}
