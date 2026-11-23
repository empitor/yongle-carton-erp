// 业务档案的底子（内存库、虚构数据）：客户、产品、供应商、纸板、成品库存、订单怎么建，单据怎么预览再核对，都只在这里写一份。
// 各模块的准备代码（flow-fixture、stack-fixture、document-fixture、maintenance-fixture……）在它上面搭自己的数据；
// 以后拆客户产品订单、采购库存时，主要改这一份。名字、数量、有没有期初库存这些差别用参数给，默认值是最常用的那套。
import { randomUUID } from 'node:crypto';
import { Store } from '../server/core/db.js';
import { OperationsService } from '../server/operations/index.js';
import { FlowService } from '../server/flow/index.js';
import type { Actor } from '../server/core/index.js';
import { customerSchema, orderSchema, productSchema } from '../shared/core/domain.js';

type Fields = Record<string, unknown>;
/** 只要编号的记录：单据、订单、产品、库存品 */
type Ref = { id: number };
/** 期初入库：数量、日期（备注默认“虚构期初”） */
export type Opening = { quantity: string; date: string; notes?: string };

/**
 * 建档的几样，操作人都是 who：
 * customer(字段) 客户（默认“虚构客户”）；product(字段) 产品（默认“虚构纸箱”）；supplier(字段) 供应商（默认“虚构供应商”）；
 * raw(字段, 期初) 纸板（默认“虚构纸板”、张）；finished(产品, 字段, 期初) 关联产品的成品（默认“虚构成品”、只）；
 * stockIn(库存品, 期初) 入库一笔；line(产品, 数量, 字段) 一行订单明细（只、1 元）；order(客户, 明细, 字段) 已确认的订单；
 * check(单据, 别的字段, 谁) 预览后核对（带上预览摘要、新请求号、已确认）。
 */
export function businessBase(who: Actor, store = new Store(':memory:')) {
  const ops = new OperationsService(store),
    flow = new FlowService(store);
  const stockIn = (item: Ref, { quantity, date, notes = '虚构期初' }: Opening) =>
    flow.stock.move(
      item.id,
      { expectedVersion: ops.items(true, item.id)[0].version, requestId: randomUUID(), action: 'in', quantity, date, notes, acknowledged: true },
      who,
    );
  const withOpening = <T extends Ref>(item: T, opening?: Opening) => {
    if (opening) stockIn(item, opening);
    return item;
  };
  const line = (p: Ref, quantity: number, fields: Fields = {}) => ({ productId: p.id, quantity, unit: '只', unitPriceCents: 100, ...fields });
  return {
    store,
    ops,
    flow,
    stockIn,
    line,
    customer: (fields: Fields = {}) => store.saveCustomer(customerSchema.parse({ name: '虚构客户', ...fields })),
    product: (fields: Fields = {}) => store.saveProduct(productSchema.parse({ name: '虚构纸箱', ...fields })),
    supplier: (fields: Fields = {}) => ops.saveSupplier({ name: '虚构供应商', ...fields }, who),
    raw: (fields: Fields = {}, opening?: Opening) => withOpening(ops.saveItem({ name: '虚构纸板', kind: 'raw', unit: '张', ...fields }, who), opening),
    finished: (p: Ref, fields: Fields = {}, opening?: Opening) =>
      withOpening(ops.saveItem({ name: '虚构成品', kind: 'finished', unit: '只', productId: p.id, ...fields }, who), opening),
    order: (c: Ref, lines: Fields[], fields: Fields = {}) =>
      store.saveOrder(orderSchema.parse({ customerId: c.id, orderDate: '2026-10-01', deliveryDate: '2026-10-30', status: '已确认', lines, ...fields })),
    check: (doc: Ref, extra: Fields = {}, by: Actor = who) =>
      flow.confirm(doc.id, { previewDigest: flow.preview(doc.id, by).previewDigest, requestId: randomUUID(), acknowledged: true, ...extra }, by),
  };
}

/** 最常用的一套档案：一个客户、一个产品、一个供应商、一种纸板、产品的成品库存，按这个顺序建；名字不同的给 names */
export function standardRecords(
  base: ReturnType<typeof businessBase>,
  names: Partial<Record<'customer' | 'product' | 'supplier' | 'raw' | 'finished', Fields>> = {},
) {
  const customer = base.customer(names.customer),
    product = base.product(names.product),
    supplier = base.supplier(names.supplier),
    raw = base.raw(names.raw),
    finished = base.finished(product, names.finished);
  return { customer, product, supplier, raw, finished };
}
