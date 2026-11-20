// 单据流转测试的公共底子（都是内存库、虚构数据）：flowFixture 一个客户、产品、供应商、纸板和成品库存；
// businessFixture 再带一张订单和到货、安排生产、完工的写法；workbenchFixture 是工作台和单据样张用的有料号产品。
import { pageActor } from './actor-fixture.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/core/db.js';
import { OperationsService } from '../server/operations/service.js';
import { FlowService } from '../server/flow/service.js';
import { customerSchema, orderSchema, productSchema, specification } from '../shared/core/domain.js';
import type { Actor } from '../server/core/auth.js';
import type { FlowKind } from '../shared/business/index.js';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { saveDoc } from './receive-fixture.js';

export const clerk: Actor = pageActor({ id: 'flow-clerk', name: '虚构业务员', permissions: ['business:edit'] });
export const localAdmin = (): Actor =>
  localAdministratorActor(
    pageActor({
      id: 'flow-admin',
      name: '虚构维护',
      role: 'super_admin',
      permissions: ['business:edit'],
      superAdminMode: true,
      superAdminUntil: Date.now() + 3600000,
    }),
  );

export function orderOf(store: Store, id: number, includeArchived = false) {
  const order = store.order(id, includeArchived);
  assert.ok(order, '测试数据：没有订单 ' + id);
  return order;
}

export function flowFixture(who: Actor = clerk) {
  const store = new Store(':memory:'),
    ops = new OperationsService(store),
    flow = new FlowService(store);
  const customer = store.saveCustomer(customerSchema.parse({ name: '虚构客户', address: '虚构地址' }));
  const product = store.saveProduct(productSchema.parse({ name: '虚构纸箱' }));
  const supplier = ops.saveSupplier({ name: '虚构供应商' }, who);
  const raw = ops.saveItem({ name: '虚构纸板', kind: 'raw', unit: '张' }, who);
  const finished = ops.saveItem({ name: '虚构成品', kind: 'finished', unit: '只', productId: product.id }, who);
  const draft = <K extends FlowKind>(kind: K, input: Record<string, unknown>) => saveDoc(flow, kind, { date: '2026-10-27', ...input }, who);
  /** 安排生产任务：安排即下达，没有核对这一步 */
  const task = (input: Record<string, unknown>) => flow.save('task', { date: '2026-10-27', ...input }, who);
  const confirmId = (id: number, extra: Record<string, unknown> = {}) => {
    const p = flow.preview(id, who);
    return flow.confirm(id, { previewDigest: p.previewDigest, requestId: randomUUID(), acknowledged: true, ...extra }, who);
  };
  /** 保存并核对，返回核对后的这张单据（按种类收窄） */
  const confirm = <K extends FlowKind>(kind: K, input: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
    const id = draft(kind, input).id;
    confirmId(id, extra);
    return flow.get(id, kind);
  };
  const order = (quantity: number, over: Record<string, unknown> = {}) =>
    store.saveOrder(
      orderSchema.parse({
        customerId: customer.id,
        orderDate: '2026-10-01',
        deliveryDate: '2026-12-30',
        status: '已确认',
        lines: [{ productId: product.id, quantity, unit: '只', unitPriceCents: 100 }],
        ...over,
      }),
    );
  const stockIn = (quantity: string, stockId = finished.id) => {
    const it = ops.repo.items(true, stockId)[0];
    ops.move(
      stockId,
      { expectedVersion: it.version, requestId: randomUUID(), action: 'in', quantity, date: '2026-10-20', notes: '虚构入库', acknowledged: true },
      who,
    );
  };
  const arrive = (reference: string, quantity: string) =>
    confirm('arrival', {
      supplierId: supplier.id,
      reference,
      lines: [{ stockId: raw.id, item: { name: raw.name, unit: '张' }, quantity }],
    });
  return { store, ops, flow, customer, product, supplier, raw, finished, draft, task, confirm, confirmId, order, stockIn, arrive };
}

/** businessFixture 的身份：本机最高管理员（超级管理员模式） */
export const fixtureOwner = () =>
  localAdministratorActor(
    pageActor({
      id: 'fixture-owner',
      name: '虚构维护',
      role: 'super_admin',
      permissions: ['business:edit'],
      superAdminMode: true,
      superAdminUntil: Date.now() + 3600000,
    }),
  );

/**
 * 业务流程的底子（本机最高管理员）：客户、产品、供应商、纸板 raw、衬板 glue、成品，一张 1000 只的订单。
 * confirm(类别, 内容) 保存并核对（日期默认 2026-10-27）；arrival(数量) 纸板到货；task(数量) 给这张订单安排生产；
 * production(任务编号, 良品数) 登记完工，领 10 张纸板。
 */
export function businessFixture() {
  const store = new Store(':memory:'),
    actor = fixtureOwner(),
    ops = new OperationsService(store),
    flow = new FlowService(store);
  const customer = store.saveCustomer(customerSchema.parse({ name: '虚构客户' })),
    product = store.saveProduct(productSchema.parse({ name: '虚构纸箱' })),
    supplier = ops.saveSupplier({ name: '虚构供应商' }, actor),
    raw = ops.saveItem({ name: '虚构纸板', kind: 'raw', unit: '张' }, actor),
    glue = ops.saveItem({ name: '虚构衬板', kind: 'raw', unit: '张' }, actor),
    finished = ops.saveItem({ name: '虚构成品', kind: 'finished', unit: '只', productId: product.id }, actor);
  const order = store.saveOrder(
    orderSchema.parse({
      customerId: customer.id,
      orderDate: '2026-10-01',
      deliveryDate: '2026-10-30',
      status: '已确认',
      lines: [{ productId: product.id, quantity: 1000, unit: '只', unitPriceCents: 100 }],
    }),
  );
  const confirm = <K extends FlowKind>(kind: K, input: Record<string, unknown>) => {
    const d = saveDoc(flow, kind, { date: '2026-10-27', ...input }, actor);
    const p = flow.preview(d.id, actor);
    flow.confirm(d.id, { previewDigest: p.previewDigest, requestId: randomUUID(), acknowledged: true }, actor);
    return flow.get(d.id, kind);
  };
  const arrival = (quantity: string) =>
    confirm('arrival', {
      supplierId: supplier.id,
      reference: randomUUID(),
      lines: [{ stockId: raw.id, item: { name: raw.name, unit: '张' }, quantity }],
    });
  // 安排生产即下达，没有核对这一步
  const task = (quantity: string) =>
    flow.save('task', { date: '2026-10-27', productId: product.id, quantity, unit: '只', orderIds: [order.id], plannedDate: '2026-10-27' }, actor);
  const production = (taskId: number, goodQuantity: string) =>
    confirm('production', {
      taskId,
      productId: product.id,
      finishedStockId: finished.id,
      goodQuantity,
      operator: '虚构员工',
      materials: [{ stockId: raw.id, issued: '10', returned: '0' }],
    });
  return { store, actor, ops, flow, customer, product, supplier, raw, glue, finished, order, confirm, arrival, task, production };
}

/**
 * 工作台的底子（2026-10-29）：有客户料号 000123 和尺寸材质的产品、100 只的订单、纸板期初 100 张、
 * 一张待订货的采购单（1000 张、单价 1.2345）、一张安排好的生产任务（计划 2026-11-01）。
 */
export function workbenchFixture(who: Actor) {
  const date = '2026-10-29',
    store = new Store(':memory:'),
    ops = new OperationsService(store),
    flow = new FlowService(store);
  const customer = store.saveCustomer(customerSchema.parse({ name: '虚构工作台客户' }));
  const product = store.saveProduct(
    productSchema.parse({
      name: '虚构有料号纸箱',
      length: 300, width: 200, height: 150, dimensionUnit: 'mm', material: 'K=A', flute: 'BC',
      customerProductCode: '000123',
    }),
  );
  const order = store.saveOrder(
    orderSchema.parse({
      customerId: customer.id,
      orderDate: date,
      deliveryDate: date,
      status: '已确认',
      lines: [
        {
          productId: product.id,
          quantity: 100,
          unit: '只',
          unitPriceCents: 100,
          specification: specification(product),
          customerProductCode: '000123',
        },
      ],
    }),
  );
  const supplier = ops.saveSupplier({ name: '虚构模板供应商' }, who),
    raw = ops.saveItem({ name: '虚构纸板', kind: 'raw', unit: '张', length: 1000, width: 800, dimensionUnit: 'mm' }, who);
  ops.move(
    raw.id,
    { expectedVersion: raw.version, requestId: randomUUID(), action: 'in', quantity: '100', date, notes: '虚构期初', acknowledged: true },
    who,
  );
  const purchase = ops.savePurchase(
    {
      supplierId: supplier.id,
      customerOrderId: order.id,
      orderDate: date,
      expectedDate: '2026-11-02',
      status: '待订货',
      lines: [{ ...raw, stockItemId: raw.id, quantity: '1000', unitPrice: '1.2345', priceBasis: 'quantity' }],
    },
    who,
  );
  const task = flow.save(
    'task',
    { productId: product.id, quantity: '100', unit: '只', date, plannedDate: '2026-11-01', orderIds: [order.id] },
    who,
  );
  return { store, ops, flow, order, raw, product, purchase, task, customer };
}
