// 一套虚构业务数据：一个客户、两个产品（箱A、箱B），能下订单；stackFixture 再加纸板（期初 100000 张）、
// 成品A，能核对单据、安排生产、登记完工。只用到客户、产品、订单的测试用 orderBasics，不建库存。
import { pageActor } from './actor-fixture.js';
import { Store } from '../server/core/db.js';
import type { Actor } from '../server/core/auth.js';
import type { orderSchema, Product } from '../shared/core/domain.js';
import type { z } from 'zod';
import { shipOnDocDate } from './ship-date.js';
import { businessBase } from './business-base-fixture.js';

/** 订单明细的输入（orderSchema 收的一行）。 */
type OrderLineDraft = z.input<typeof orderSchema>['lines'][number];
/** 只要编号的记录：单据、订单、产品、库存品。 */
type Ref = { id: number };

export const stackActor: Actor = pageActor({ id: 'p0', name: '虚构操作员', permissions: ['business:edit'] });

export const rawInput = {
  name: '虚构五层纸板',
  kind: 'raw',
  unit: '张',
  length: 1000,
  width: 800,
  height: null,
  dimensionUnit: 'mm',
  material: 'K=A',
  flute: 'BC',
  specification: '',
  notes: '',
  productId: null,
};

/** 客户、箱A（pa）、箱B（pb）；line(产品, 数量) 拼一行订单明细（单价 1 元），order(明细) 下一张已确认的订单。 */
export function orderBasics(store = new Store(':memory:')) {
  const base = businessBase(stackActor, store);
  const customer = base.customer(),
    pa = base.product({ name: '虚构箱A' }),
    pb = base.product({ name: '虚构箱B' });
  const line = (p: Pick<Product, 'id' | 'name'>, quantity = 100): OrderLineDraft => ({
    productId: p.id,
    productName: p.name,
    specification: '',
    quantity,
    unit: '只',
    unitPriceCents: 100,
    notes: '',
  });
  const order = (lines: OrderLineDraft[]) => base.order(customer, lines, { notes: '', costs: null });
  return { store, customer, pa, pb, line, order };
}

/**
 * 整套：orderBasics 加纸板 raw（期初 100000 张）和成品A fa。confirm(单据, 谁) 预览后核对；
 * task(订单, 产品) 安排 100 只；production(任务编号, 产品, 成品库存, 良品数) 登记完工，领 10 张纸板。
 * shipOnDocDate：核对送货单时出库日按单据日期（补录历史送货的测试用）。
 */
export function stackFixture(file = ':memory:', options: { shipOnDocDate?: boolean } = {}) {
  const base = businessBase(stackActor, new Store(file)),
    { store, ops, flow } = base;
  const basics = orderBasics(store);
  const raw = base.raw(rawInput),
    fa = base.finished(basics.pa, { ...rawInput, name: '成品A', kind: 'finished', unit: '只', productId: basics.pa.id });
  base.stockIn(raw, { quantity: '100000', date: '2026-10-01' });
  const confirm = (d: Ref, who: Actor = stackActor) => base.check(d, options.shipOnDocDate ? shipOnDocDate(flow, d.id) : {}, who);
  // 安排生产即下达，没有核对这一步
  const task = (o: Ref, p: Ref) =>
    flow.save('task', { date: '2026-10-02', productId: p.id, quantity: '100', unit: '只', orderIds: [o.id] }, stackActor);
  const production = (taskId: number | null, p: Ref, stock: Ref, quantity: string) =>
    confirm(
      flow.save(
        'production',
        {
          date: '2026-10-05',
          taskId,
          productId: p.id,
          finishedStockId: stock.id,
          goodQuantity: quantity,
          scrapQuantity: '0',
          operator: '虚构机长',
          materials: [{ stockId: raw.id, issued: '10', returned: '0' }],
        },
        stackActor,
      ),
    );
  return { ...basics, ops, flow, raw, fa, confirm, task, production };
}
