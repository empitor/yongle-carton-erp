import type { z } from 'zod';
import { lineMoney } from '../operations/operations.js';
import type { FlowDocument, FlowDocuments, LifecycleField } from './flow-document.js';
import type { arrivalLineSchema, arrivalSchema, deliverySchema, productionSchema, taskSchema } from './physical-flow.js';

/*
 * 单据里服务端抄下来的快照（名称、单价税率、材质楞型、尺寸、面积金额……）：库里的单据结构（flow-document.ts）比录入结构
 * （physical-flow.ts）多出来、又不是生命周期记录（确认、取消撤销、出库送达、更正关系）的字段。清单由类型从两份结构派生：
 * 单据结构多一个这样的字段，这里的登记缺一项就编译不过（tests/flow-snapshot.test.ts 另按运行时的结构比一遍）。
 *
 * 每一项登记它跟着哪个引用（ref）：重新保存一张单据时（更正出替代单、改已下达的任务、管理员改订单和库存品连带改单据），
 * 引用没变的原样保留原单上的，引用换了才用新单上按新引用取的（用户 2026-11-21 定：档案改过名，更正出的替代单仍是原来的名字）。
 * 明细先给新单每一行定一行原单作来源（keepLines），再逐项比引用。
 * 算出来的（derive）引用换了按保留下来的别的快照重算：送货金额 = 新数量 × 出库时的单价。
 */

/** 一项快照：ref 给出它跟着的引用（同一行和表头的录入字段），derive 是引用换了时按这一行算出它的值 */
type Rule<T, D, F extends keyof T> = { ref: (value: T, doc: D) => unknown; derive?: (value: T) => T[F] };
/** 一层（表头或一行明细）的快照登记：快照字段一个不多一个不少 */
type Rules<T, D, F extends keyof T> = { readonly [P in F]-?: Rule<T, D, P> };
/** T 比录入的 I 多出来、又不是生命周期记录的字段（种类在行上，不算） */
type Snapshot<T, I> = Exclude<keyof T, keyof I | LifecycleField | 'kind'>;

type Arrival = FlowDocument<'arrival'>;
type ArrivalLine = FlowDocuments['arrival']['lines'][number];
type Delivery = FlowDocument<'delivery'>;
type DeliveryLine = FlowDocuments['delivery']['lines'][number];
type Task = FlowDocument<'task'>;
type Production = FlowDocument<'production'>;
type Input<S extends z.ZodType> = z.output<S>;
type DeliveryInputLine = Input<typeof deliverySchema>['lines'][number];

/** 到货明细的面积、金额按纸板资料、数量、单价、计价方式算（server/flow/validate-arrival.ts） */
const arrivalContent = (l: ArrivalLine) => [l.item, l.quantity, l.unitPrice, l.priceBasis];
/** 送货明细抄的是订单明细（品名、规格、单价、税率）和它的产品（材质、楞型） */
const orderLine = { ref: (l: DeliveryLine) => l.orderLineId };
/** 尺寸先取成品库存品的，没填取产品的（server/flow/validate-delivery.ts） */
const dimensions = { ref: (l: DeliveryLine) => [l.orderLineId, l.stockId] };

const rules: {
  arrival: {
    doc: Rules<Arrival, Arrival, Snapshot<Arrival, Input<typeof arrivalSchema>>>;
    lines: Rules<ArrivalLine, Arrival, Snapshot<ArrivalLine, Input<typeof arrivalLineSchema>>>;
  };
  task: { doc: Rules<Task, Task, Snapshot<Task, Input<typeof taskSchema>>> };
  production: { doc: Rules<Production, Production, Snapshot<Production, Input<typeof productionSchema>>> };
  delivery: {
    doc: Rules<Delivery, Delivery, Snapshot<Delivery, Input<typeof deliverySchema>>>;
    lines: Rules<DeliveryLine, Delivery, Snapshot<DeliveryLine, DeliveryInputLine>>;
  };
} = {
  arrival: {
    doc: { supplierName: { ref: (d) => d.supplierId } },
    lines: {
      area: { ref: arrivalContent },
      amount: { ref: arrivalContent },
      purchaseId: { ref: (l) => l.purchaseLineId },
      purchaseNumber: { ref: (l) => l.purchaseLineId },
      supplierName: { ref: (_l, d) => d.supplierId },
    },
  },
  task: { doc: { productName: { ref: (d) => d.productId } } },
  production: { doc: { productName: { ref: (d) => d.productId } } },
  delivery: {
    doc: { customerName: { ref: (d) => d.customerId } },
    lines: {
      productName: orderLine,
      specification: orderLine,
      unit: orderLine,
      orderNumber: orderLine,
      externalPurchaseOrder: orderLine,
      customerProductCode: orderLine,
      unitPriceExact: orderLine,
      taxRate: orderLine,
      taxMode: orderLine,
      productId: orderLine,
      material: orderLine,
      flute: orderLine,
      amountExact: { ref: (l) => [l.orderLineId, l.quantity], derive: (l) => lineMoney(l.quantity, l.unitPriceExact ?? null) },
      length: dimensions,
      width: dimensions,
      height: dimensions,
      dimensionUnit: dimensions,
    },
  },
};

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const keysOf = <R extends object>(r: R) => Object.keys(r).filter((k): k is Extract<keyof R, string> => Object.hasOwn(r, k));

/**
 * 一层（表头或一行）：from 是原单上对得上的那一层（对不上是 undefined）。引用和 from 一样、from 上有值的字段换回 from 的，
 * 再把没换回、新单上算过的 derive 字段按换好的这一层重算。一层的快照只从这一个来源取，单价和金额不会取自原单不同的行
 */
function keepLayer<T extends object, D, F extends keyof T>(r: Rules<T, D, F>, next: T, nextDoc: D, from: T | undefined, oldDoc: D): T {
  const out = { ...next },
    kept = new Set<string>();
  for (const key of keysOf(r)) {
    const rule = r[key];
    if (from && from[key] !== undefined && same(rule.ref(from, oldDoc), rule.ref(next, nextDoc))) {
      out[key] = from[key];
      kept.add(key);
    }
  }
  for (const key of keysOf(r)) {
    const derive = r[key].derive;
    if (derive && !kept.has(key) && next[key] !== undefined) out[key] = derive(out);
  }
  return out;
}

/**
 * 明细：新单每一行按顺序对上原单里还没被对上过、行键（row）一样的第一行，这一行的快照都从它取；
 * 对不上的（原单没有这条订单明细、采购明细，或同一条的行比原单多）快照用新单的
 */
function keepLines<T extends object, D extends { lines: T[] }, F extends keyof T>(r: Rules<T, D, F>, row: (l: T) => unknown, old: D, next: D) {
  const used = new Set<number>();
  return next.lines.map((l) => {
    const at = old.lines.findIndex((o, i) => !used.has(i) && same(row(o), row(l)));
    if (at >= 0) used.add(at);
    return keepLayer(r, l, next, at >= 0 ? old.lines[at] : undefined, old);
  });
}

/** 明细的行键：送货按订单明细，到货按采购明细和库存品 */
const rows = {
  arrival: (l: ArrivalLine) => [l.purchaseLineId, l.stockId],
  delivery: (l: DeliveryLine) => l.orderLineId,
};

/**
 * 重新保存单据：next 是要写的新内容（引用换了的快照已按新引用取好），old 是原单（库里那份或它的视图）。
 * 返回 next 换回原单快照以后的内容；只动快照字段，录入的和生命周期记录照 next。种类不同是程序写错了，当场报错
 */
export function keepSnapshot<K extends FlowDocument['kind']>(old: FlowDocument<K>, next: FlowDocument<K>): FlowDocument<K>;
export function keepSnapshot(old: FlowDocument, next: FlowDocument): FlowDocument {
  const mismatch = () => new Error('重新保存单据：原单和新单的种类不一样（' + old.kind + ' / ' + next.kind + '）');
  switch (next.kind) {
    case 'arrival': {
      if (old.kind !== 'arrival') throw mismatch();
      const head = keepLayer(rules.arrival.doc, next, next, old, old);
      return { ...head, lines: keepLines(rules.arrival.lines, rows.arrival, old, next) };
    }
    case 'delivery': {
      if (old.kind !== 'delivery') throw mismatch();
      const head = keepLayer(rules.delivery.doc, next, next, old, old);
      return { ...head, lines: keepLines(rules.delivery.lines, rows.delivery, old, next) };
    }
    case 'task':
      if (old.kind !== 'task') throw mismatch();
      return keepLayer(rules.task.doc, next, next, old, old);
    case 'production':
      if (old.kind !== 'production') throw mismatch();
      return keepLayer(rules.production.doc, next, next, old, old);
  }
}
