// 一套虚构业务数据：一个客户、两个产品（箱A、箱B），能下订单；stackFixture 再加纸板（期初 100000 张）、
// 成品A，能核对单据、安排生产、登记完工。只用到客户、产品、订单的测试用 orderBasics，不建库存。
import { pageActor } from './actor-fixture.js';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/core/db.js';
import { OperationsService } from '../server/operations/service.js';
import { FlowService } from '../server/flow/service.js';
import type { Actor } from '../server/core/auth.js';
import { customerSchema, orderSchema, productSchema, type Product } from '../shared/core/domain.js';
import type { z } from 'zod';
import { shipOnDocDate } from './ship-date.js';

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
  const customer = store.saveCustomer(customerSchema.parse({ name: '虚构客户' })),
    pa = store.saveProduct(productSchema.parse({ name: '虚构箱A' })),
    pb = store.saveProduct(productSchema.parse({ name: '虚构箱B' }));
  const line = (p: Pick<Product, 'id' | 'name'>, quantity = 100): OrderLineDraft => ({
    productId: p.id,
    productName: p.name,
    specification: '',
    quantity,
    unit: '只',
    unitPriceCents: 100,
    notes: '',
  });
  const order = (lines: OrderLineDraft[]) =>
    store.saveOrder(
      orderSchema.parse({
        customerId: customer.id,
        orderDate: '2026-10-01',
        deliveryDate: '2026-10-30',
        status: '已确认',
        notes: '',
        costs: null,
        lines,
      }),
    );
  return { store, customer, pa, pb, line, order };
}

/**
 * 整套：orderBasics 加纸板 raw（期初 100000 张）和成品A fa。confirm(单据, 谁) 预览后核对；
 * task(订单, 产品) 安排 100 只；production(任务编号, 产品, 成品库存, 良品数) 登记完工，领 10 张纸板。
 * shipOnDocDate：核对送货单时出库日按单据日期（补录历史送货的测试用）。
 */
export function stackFixture(file = ':memory:', options: { shipOnDocDate?: boolean } = {}) {
  const store = new Store(file),
    ops = new OperationsService(store),
    flow = new FlowService(store);
  const basics = orderBasics(store);
  const raw = ops.saveItem(rawInput, stackActor),
    fa = ops.saveItem({ ...rawInput, name: '成品A', kind: 'finished', unit: '只', productId: basics.pa.id }, stackActor);
  ops.move(
    raw.id,
    {
      action: 'in',
      quantity: '100000',
      date: '2026-10-01',
      notes: '虚构期初',
      acknowledged: true,
      requestId: randomUUID(),
      expectedVersion: raw.version,
    },
    stackActor,
  );
  const confirm = (d: Ref, who: Actor = stackActor) => {
    const p = flow.preview(d.id, who);
    const ship = options.shipOnDocDate ? shipOnDocDate(flow, d.id) : {};
    return flow.confirm(d.id, { previewDigest: p.previewDigest, requestId: randomUUID(), acknowledged: true, ...ship }, who);
  };
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
