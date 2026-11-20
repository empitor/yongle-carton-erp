/**
 * 一个月成本计算里的库存账：按流水记入库、出库（月末加权平均）、冲销按原成本冲回、撤销到货按原暂估红字入库、
 * 成本为负或零数量有余额时结清，边记边累计凭证分录。只在内存里算，不读写库（到货事件、原成本由调用方查好传进来）。
 */
import { z } from 'zod';
import { quantityUnits } from '../../shared/core/index.js';
import { financeError } from './core.js';
import { proportion } from './amounts.js';
import { spreadAdjustment, type InvoiceAdjustments } from './costing-invoice-adjust.js';
import { movementSource, type Movement } from './costing-source.js';
import { expectRow } from './finance-rows.js';
import { readSnapshot } from './source-snapshot.js';

/** 一个库存品这个月的数量和金额（期初、入库、出库、期末），算完记进 fin_inventory_costs 和执行明细 */
export const costingItem = z.object({
  stockId: z.number(), name: z.string(), kind: z.string(), unit: z.string(),
  openingQty: z.number(), openingCents: z.number(), inQty: z.number(), inCents: z.number(),
  outQty: z.number(), outCents: z.number(), endQty: z.number(), endCents: z.number(),
});
export type Item = z.output<typeof costingItem>;
/** 一笔销售出库的成本（冲回的是负数），记进 fin_cost_sales 和执行明细 */
export const costingSale = z.object({
  id: z.string(),
  orderId: z.number().nullable(),
  customerId: z.number().nullable(),
  productId: z.number().nullable(),
  cost: z.number(),
});
export type Sale = z.output<typeof costingSale>;
/** 转入主营业务成本的库存余额：哪个库存品、多少分、转到哪个科目、为什么 */
export const costingResidual = z.object({
  stockId: z.number(), name: z.string(), cents: z.number(), account: z.string(), reason: z.string(),
});
/** 冲销送货或完工单退回的库存对应的原出库。 */
export type ReversalOrigin =
  | { same: true; originals: string[] }
  | { same: false; cost: number; parts: [string, number][]; sales: Sale[] };
/** 冲销完工单扣回的成品对应的原完工入库 */
export type CompletionOrigin = { same: true } | { same: false; cost: number; counter: string };
/** 人工填的出入库金额和对方科目 */
type Valuation = { movementId: string; unit: string; amount: number; counterAccount?: string; reason: string };
/** 完工批次：领料成本、产量、分到的费用后的完工成本 */
export type ProductionJob = { materials: number; qty: number; unit: string; stockId: number; cost: number };
/** 到货入库对应的财务事件（已生成凭证的那条），查不到是 undefined */
type ArrivalEvent = { id: number; snapshot: string; status: string } | undefined;
/** 系统算出的入库成本（算不出是 null）和对方科目 */
type SystemInbound = { amount: number | null; parts: [string, number][] };

export const isReturn = (m: Movement) => m.source_kind === movementSource.purchaseReturn;
// 到货的金额由暂估和发票凭证入账，完工入库由完工结转入账，成本计算不再另记对方科目。
const bookedElsewhere = (m: Movement) =>
  m.source_kind === movementSource.arrival || m.source_kind === movementSource.production;

export class MonthCostBook {
  /** 凭证分录：科目 → 借方减贷方 */
  readonly balances = new Map<string, number>();
  /** 本月每笔出库算出的成本和对方科目，冲销时按原成本冲回，也记进明细给以后月份的冲销用 */
  readonly issued = new Map<string, { cost: number; counter: string }>();
  /** 本月每笔完工入库的成本，记进明细给以后月份冲销完工单用 */
  readonly received = new Map<string, number>();
  readonly sales: Sale[] = [];
  private readonly salesById = new Map<string, Sale>();
  /** 冲销完工单扣回的成品，查得到原完工成本的冲销入库 */
  readonly valued = new Set<number>();
  /** 转入主营业务成本的库存余额 */
  readonly residuals: z.output<typeof costingResidual>[] = [];
  /** 本月撤销或更正冲回过到货的库存品：成本冲成负数的先归零；数量为 0 的只留到过票、等红票冲的那部分，其余结清 */
  readonly undone = new Set<number>();

  constructor(
    private readonly c: {
      /** 这个月的第一天 */
      start: string;
      items: Map<number, Item>;
      mapping: (field: string) => string;
      manualMap: Map<string, Valuation>;
      origins: Map<string, ReversalOrigin | null>;
      completions: Map<string, CompletionOrigin>;
      /** 完工批次，按完工流水的来源编号（流水的 source_id 库里可能空着） */
      production: Map<string | null, ProductionJob>;
      adjustments: InvoiceAdjustments;
      /** 本月实际用上调差的到货批次 */
      consumed: Set<number>;
      /** 本月有到票调差或红票冲减的库存品 */
      adjustedStocks: Set<number>;
      /** 到货流水对应的财务事件 */
      arrivalEvent: (m: Movement) => ArrivalEvent;
      /** 撤销或更正冲回到货的流水（查到了记账的暂估）→ 要冲减的入库金额 */
      arrivals: Map<string, number>;
    },
  ) {}

  post(code: string, delta: number) {
    this.balances.set(code, (this.balances.get(code) ?? 0) + delta);
  }

  sameRun(m: Movement) {
    return m.delta_units > 0 && this.c.origins.get(m.id)?.same === true;
  }

  /** 撤销或更正冲回到货、按原暂估冲减入库的流水 */
  isArrivalUndo(m: Movement) {
    return this.c.arrivals.has(m.id);
  }

  /**
   * 撤销或更正冲回到货：像退货一样在出库计价前冲减入库（红字入库），按这批还挂着的暂估，不按月末均价。
   * 总账那一边由到货的红字冲销凭证记，这里不另记分录。
   */
  undoArrival(m: Movement) {
    const item = this.stock(m.item_id),
      value = expectRow(this.c.arrivals.get(m.id), '撤销到货要冲减的原暂估（流水 ' + m.id + '）');
    item.inQty += m.delta_units;
    item.inCents -= value;
    this.undone.add(item.stockId);
  }

  /** 库存品的数量金额：库存品按“这个月以前有流水的”全部取进来，流水的库存品一定在里面 */
  private stock(stockId: number) {
    return expectRow(this.c.items.get(stockId), '库存品（编号 ' + stockId + '）');
  }

  /** 完工入库：这批完工算出的成本，记下来给以后月份冲销完工单用 */
  private productionInbound(m: Movement): SystemInbound {
    const amount = this.c.production.get(m.source_id)?.cost ?? null;
    if (amount !== null) this.received.set(m.id, amount);
    return { amount, parts: [] };
  }

  /** 到货入库：按到货事件快照里这一行的暂估加上分到的到票调差；数量对不上一行时算不出（null） */
  private arrivalInbound(m: Movement, item: Item): SystemInbound {
    const event = this.c.arrivalEvent(m);
    if (event?.status !== 'generated')
      financeError('原材料到货财务资料未完成，请核对入库记录：' + item.name + '，' + m.date);
    const { adjustments, start } = this.c;
    this.c.consumed.add(event.id);
    const lines = spreadAdjustment(
      readSnapshot(event),
      adjustments.prior.get(event.id) ?? 0,
      adjustments.delta.get(event.id) ?? 0,
    ).filter(({ line }) => line.stockId === m.item_id);
    if (lines.some(({ line }) => line.item?.unit !== m.unit)) financeError('到货单位与库存单位不一致。');
    const matching = lines.filter(({ line }) => quantityUnits(line.stockedQuantity ?? '0') === m.delta_units);
    if (matching.length !== 1) return { amount: null, parts: [] };
    const [found] = matching;
    if (found.change) this.c.adjustedStocks.add(m.item_id);
    // 跨期补登的到货：这次的调差上面已经按以前月份的到货加进库存，这里只算到货本身和以前调过的
    return { amount: found.amount - (m.date < start ? found.change : 0), parts: [] };
  }

  /** 系统能算的入库成本：完工、到货、查得到原成本的冲销退回；别的算不出（null） */
  private systemInbound(m: Movement, item: Item): SystemInbound {
    if (m.source_kind === movementSource.production && m.kind === 'finished') return this.productionInbound(m);
    if (m.source_kind === movementSource.arrival) return this.arrivalInbound(m, item);
    const origin = this.c.origins.get(m.id);
    if (origin && !origin.same) return { amount: origin.cost, parts: origin.parts };
    return { amount: null, parts: [] };
  }

  /** 人填的入库金额和对方科目（手工流水默认待处理财产损溢） */
  private explicitInbound(m: Movement, item: Item, explicit: Valuation) {
    if (explicit.unit !== m.unit) financeError('成本输入单位与原流水不一致。');
    const counter =
      explicit.counterAccount ?? (m.source_kind === movementSource.manual ? this.c.mapping('adjustment') : null);
    if (!counter && explicit.amount && !bookedElsewhere(m))
      financeError('请在“计算成本”窗口选择这笔入库的对方科目：' + item.name + '，' + m.date);
    return { amount: explicit.amount, counter };
  }

  inbound(m: Movement) {
    const { manualMap, origins, mapping } = this.c;
    const item = this.stock(m.item_id),
      explicit = manualMap.get(m.id),
      origin = origins.get(m.id);
    const system = this.systemInbound(m, item);
    const chosen = explicit ? this.explicitInbound(m, item, explicit) : { ...system, counter: null };
    const { amount, counter } = chosen;
    if (amount === null) financeError('缺少入库成本或无法确认数量对应关系：' + item.name + '，' + m.date);
    item.inQty += m.delta_units;
    item.inCents += amount;
    const parts: [string, number][] = counter && amount ? [[counter, amount]] : explicit ? [] : system.parts;
    for (const [code, cents] of parts) {
      this.post(mapping(m.kind), cents);
      this.post(code, -cents);
    }
    if (!explicit && origin && !origin.same) this.sales.push(...origin.sales);
  }

  /** 出库的对方科目：领料记进完工批次的材料成本，成品送货记销售成本，别的按人选的（手工默认待处理财产损溢） */
  private outboundCounter(m: Movement, item: Item, amount: number, explicit: Valuation | undefined): string {
    const { production, mapping } = this.c;
    if (m.kind === 'raw' && m.source_kind === movementSource.production) {
      const job = production.get(m.source_id);
      if (!job) financeError('领料缺少对应的完工入库，请核对领料记录：' + item.name + '，' + m.date);
      job.materials += amount;
      return mapping('material');
    }
    if (m.kind === 'finished' && m.source_kind === movementSource.delivery) {
      const sale = { id: m.id, orderId: m.customer_order_id, customerId: m.customer_id, productId: m.product_id, cost: amount };
      this.sales.push(sale);
      this.salesById.set(m.id, sale);
      return mapping('sales');
    }
    const counter = explicit?.counterAccount ?? (m.source_kind === movementSource.manual ? mapping('adjustment') : null);
    if (!counter) financeError('请核对库存出库或冲销的对方科目：' + item.name + '，' + m.date);
    return counter;
  }

  outbound(m: Movement) {
    const item = this.stock(m.item_id),
      qty = -m.delta_units,
      explicit = this.c.manualMap.get(m.id);
    if (explicit && explicit.unit !== m.unit) financeError('出库成本单位与原流水不一致。');
    if (item.outQty + qty > item.openingQty + item.inQty) financeError('出库量超过可计价库存 ' + item.name);
    const amount =
      proportion(item.openingCents + item.inCents, item.outQty + qty, item.openingQty + item.inQty) - item.outCents;
    item.outQty += qty;
    item.outCents += amount;
    const counter = this.outboundCounter(m, item, amount, explicit);
    this.post(counter, amount);
    this.post(this.c.mapping(m.kind), -amount);
    this.issued.set(m.id, { cost: amount, counter });
  }

  /**
   * 本月出库本月又冲销（送货或完工单冲销退回库存）：当作负数出库，按原出库算出的成本和对方科目冲回，
   * 送货的销售成本一起冲掉。只用于 sameRun 为真的冲销流水。
   */
  reverseOut(m: Movement) {
    const { origins, mapping } = this.c;
    const item = this.stock(m.item_id),
      origin = origins.get(m.id);
    if (origin?.same !== true) financeError('冲销对应的原出库不在本月，请核对：' + item.name + '，' + m.date);
    const parts = new Map<string, number>();
    let cost = 0;
    for (const key of origin.originals) {
      const done = this.issued.get(key);
      if (!done) financeError('冲销对应的原出库还没有算出成本，请核对：' + item.name + '，' + m.date);
      cost += done.cost;
      parts.set(done.counter, (parts.get(done.counter) ?? 0) + done.cost);
      const sale = this.salesById.get(key);
      if (sale) sale.cost -= done.cost;
    }
    item.outQty -= m.delta_units;
    item.outCents -= cost;
    for (const [code, cents] of parts) {
      this.post(mapping(m.kind), cents);
      this.post(code, -cents);
    }
  }

  /** 冲销完工单扣回的成品按什么成本冲：本月完工的用本月算出的完工成本冲回生产成本，以前月份的按当时记下的 */
  private completionCost(m: Movement, item: Item) {
    const { completions, production, mapping } = this.c;
    const origin = completions.get(m.id);
    if (!origin) financeError('冲销完工单找不到原完工入库，请核对：' + item.name + '，' + m.date);
    if (!origin.same) return { cost: origin.cost, counter: origin.counter };
    const job = production.get(m.source_id);
    if (!job) financeError('冲销完工单找不到本月的完工批次，请核对：' + item.name + '，' + m.date);
    return { cost: job.cost, counter: mapping('material') };
  }

  /**
   * 冲销完工单扣回成品：按原完工成本冲减入库（借生产成本、贷库存商品），像退货一样在出库计价前算，
   * 不按月末均价出库。本月完工的用本月算出的完工成本。
   */
  undoCompletion(m: Movement) {
    const item = this.stock(m.item_id);
    const { cost, counter } = this.completionCost(m, item);
    item.inQty += m.delta_units;
    item.inCents -= cost;
    this.post(counter, cost);
    this.post(this.c.mapping(m.kind), -cost);
    this.valued.add(item.stockId);
  }

  private settle(item: Item, cents: number, reason: string) {
    const { mapping } = this.c;
    this.post(mapping('sales'), cents);
    this.post(mapping(item.kind), -cents);
    this.residuals.push({ stockId: item.stockId, name: item.name, cents, account: mapping('sales'), reason });
  }

  /**
   * 出库计价之前：还有库存但成本成了负数（比如折让超过剩下库存的价值，或按原完工成本冲回后不够），
   * 超出的部分属于已经领用、卖掉的货，转入主营业务成本，库存成本记为 0，不卡成本计算。
   */
  floorNegative(keys: Set<number>) {
    for (const key of keys) {
      const item = this.stock(key),
        cents = item.openingCents + item.inCents;
      if (item.openingQty + item.inQty <= 0 || cents >= 0) continue;
      item.inCents -= cents;
      this.settle(item, cents, '调差后成本为负，超出剩余库存价值的部分转入主营业务成本');
    }
  }

  /** 出库计价之后数量为 0 的库存品（keys 里的） */
  emptied(keys: Set<number>) {
    return [...keys].filter((key) => {
      const item = this.stock(key);
      return item.openingQty + item.inQty - item.outQty === 0;
    });
  }

  /**
   * 出库计价之后：数量为 0 却还有金额（货已领用完或退回后调差、红票才到），余额转入主营业务成本，
   * 库存不留“零数量有金额”。只处理本月有调差、按原成本冲回或撤销过到货的库存品；
   * 撤销过的到货里到过票、还在等红票冲的那部分（awaiting，按库存品）留着，单纯退货、红票还没到的余额也不动，等红票到了一起结清。
   */
  clearZero(keys: Set<number>, awaiting: Map<number, number>) {
    for (const key of this.emptied(keys)) {
      const item = this.stock(key);
      const cents = item.openingCents + item.inCents - item.outCents - (awaiting.get(key) ?? 0);
      if (!cents) continue;
      item.outCents += cents;
      this.settle(item, cents, '数量为 0 仍有余额，转入主营业务成本');
    }
  }
}
