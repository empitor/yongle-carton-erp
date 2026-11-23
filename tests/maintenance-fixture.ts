import { pageActor } from './actor-fixture.js';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/core/db.js';
import { DatabaseMaintenanceService } from '../server/lifecycle/index.js';
import { DataManagementService } from '../server/admin/data-management-service.js';
import { createBusinessService } from '../server/orders/index.js';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { saveDoc } from './receive-fixture.js';
import { businessBase, standardRecords } from './business-base-fixture.js';
import { viewAs } from './read-result.js';
import type { FlowKind } from '../shared/business/index.js';
import type { Actor } from '../server/core/index.js';
import { count } from '../server/core/index.js';

type Base = ReturnType<typeof businessBase>;

/**
 * 删除引擎（database-maintenance.test.ts）、管理员改订单连带改单据（order-edit-cascade.test.ts）、
 * 本机管理员的数据管理（local-administration.test.ts、assistant-management-tools.test.ts）共用：
 * 一个虚构客户、产品、供应商，一张 1000 只的订单和它的采购单；arrival、task、production、delivery 各确认一张单据，
 * del 按删除引擎先预览再删。
 */
export function fixture(store = new Store(':memory:')) {
  const who = localAdministratorActor(
      pageActor({
        id: 'fixture-owner',
        name: '虚构数据库维护',
        role: 'super_admin',
        permissions: ['business:edit'],
        superAdminMode: true,
        superAdminUntil: Date.now() + 3600000,
      }),
    ),
    base = businessBase(who, store),
    { ops, flow } = base,
    service = new DatabaseMaintenanceService(store);
  const records = baseRecords(base, who);
  return {
    store,
    who,
    /** 建档、预览再核对（business-base-fixture） */
    base,
    ops,
    flow,
    service,
    ...records,
    ...documentMakers(base, records, who),
    /** 数据管理（本机管理员直接改全部业务数据），local-administration.test.ts 用 */
    dataManagement: new DataManagementService(store),
    del: deleter(service, who),
  };
}

/** 虚构客户、产品、供应商、纸板 raw、成品 finished，一张 1000 只的订单和挂它的已订货采购单（1000 张） */
function baseRecords(base: Base, who: Actor) {
  const { customer, product, supplier, raw, finished } = standardRecords(base);
  const order = base.order(customer, [base.line(product, 1000)]);
  const purchase = base.ops.savePurchase(
    {
      supplierId: supplier.id,
      customerOrderId: order.id,
      orderDate: '2026-10-01',
      status: '已订货',
      lines: [{ stockItemId: raw.id, name: raw.name, quantity: '1000', unit: '张', priceBasis: 'quantity' }],
    },
    who,
  );
  return { customer, product, supplier, raw, finished, order, purchase };
}

/** 各确认一张单据：arrival 到货 1000 张、task 安排 1000 只（安排即下达）、production(任务) 完工 860 只、delivery 送 100 只 */
function documentMakers(base: Base, r: ReturnType<typeof baseRecords>, who: Actor) {
  const save = <K extends FlowKind>(kind: K, input: Record<string, unknown>) => saveDoc(base.flow, kind, { date: '2026-10-27', ...input }, who);
  const confirm = <K extends FlowKind>(kind: K, input: Record<string, unknown>) => viewAs(base.check(save(kind, input)), kind);
  const arrival = () =>
    confirm('arrival', {
      supplierId: r.supplier.id,
      reference: randomUUID(),
      lines: [{ stockId: r.raw.id, item: { name: r.raw.name, unit: '张' }, quantity: '1000', purchaseLineId: r.purchase.lines[0].id }],
    });
  const task = () => save('task', { productId: r.product.id, quantity: '1000', unit: '只', orderIds: [r.order.id] });
  const production = (taskId: number | null = null) =>
    confirm('production', {
      productId: r.product.id,
      finishedStockId: r.finished.id,
      goodQuantity: '860',
      operator: '虚构员工',
      taskId,
      materials: [{ stockId: r.raw.id, issued: '900', returned: '0' }],
    });
  const delivery = () =>
    confirm('delivery', {
      customerId: r.customer.id,
      lines: [{ orderId: r.order.id, orderLineId: r.order.lines[0].id, stockId: r.finished.id, quantity: '100' }],
    });
  return { arrival, task, production, delivery };
}

/** del(模块, 记录, 库存处理) 按删除引擎先预览再删 */
function deleter(service: DatabaseMaintenanceService, who: Actor) {
  return (module: string, row: { id: number; version: number }, inventoryPolicy = 'preserve') => {
    const selection = { module, items: [{ id: row.id, version: row.version }], inventoryPolicy },
      p = service.preview(selection, who);
    return service.delete({ ...selection, requestId: randomUUID(), deletionDigest: p.digest }, who, 's');
  };
}

/** 送一行：哪张订单（编号和各行编号）、第几行（默认第 1 行）、数量（默认 100） */
type ShipLine = { order: { id: number; lines: { id: number }[] }; line?: number; quantity?: string };
/**
 * 管理员改订单连带改送货单的用例（order-edit-cascade、order-edit-line-removal）：在 fixture 上先到货、完工 860 只，
 * order(各行数量) 下单，pending/ship 存一张待送货或已出库的送货单，editOrder 以本机管理员改订单，
 * moves/own/revisions 读流水、单张送货单名下的出库和冲销合计、修订记录数。
 */
export function splitDeliveryFixture() {
  const f = fixture();
  f.arrival();
  f.production();
  const order = (quantities: number[]) => f.base.order(f.customer, quantities.map((q) => f.base.line(f.product, q)));
  const pending = (lines: ShipLine[], extra: object = {}) =>
    f.flow.save(
      'delivery',
      {
        date: '2026-10-27',
        customerId: f.customer.id,
        lines: lines.map(({ order: o, line = 0, quantity = '100' }) => ({ orderId: o.id, orderLineId: o.lines[line].id, stockId: f.finished.id, quantity })),
        ...extra,
      },
      f.who,
    );
  const ship = (lines: ShipLine[], extra: object = {}) => viewAs(f.base.check(pending(lines, extra)), 'delivery');
  const undo = (id: number) => f.flow.reverse(id, { version: f.flow.get(id).version, reason: '虚构：发错了', acknowledged: true }, f.who);
  const editOrder = (id: number, patch: Record<string, unknown>, who: Actor = f.who) => {
    const current = f.store.order(id);
    if (!current) throw new Error('测试数据：没有订单 ' + id);
    return createBusinessService(f.store).execute(
      { entity: 'orders', action: 'update', id, input: { ...current, ...patch } },
      { source: 'manual-ui', operatorId: who.id, superAdminMode: true, actor: who },
    );
  };
  const moves = () =>
    f.store.db
      .prepare('SELECT seq,id,item_id,delta_units,source_kind,source_id,customer_order_id FROM stock_movements ORDER BY seq')
      .all()
      .map((m) => ({ ...m }));
  /** 这张送货单名下的流水：出库（flow_delivery）、冲销（flow_reversal）各自的合计 */
  const own = (id: number) => {
    const sum = (kind: string) =>
      moves()
        .filter((m) => m.source_kind === kind && m.source_id === String(id))
        .reduce((n, m) => n + Number(m.delta_units), 0);
    return { out: sum('flow_delivery'), back: sum('flow_reversal') };
  };
  const revisions = () => count(f.store.db, 'SELECT count(*) FROM stock_movement_revisions');
  const balance = () => f.ops.balance(f.finished.id);
  const remove = (id: number, inventoryPolicy = 'recalculate') => f.del('delivery', f.flow.get(id), inventoryPolicy);
  const deliveries = () => f.flow.list('delivery', true);
  const foreignKeys = () => f.store.db.prepare('PRAGMA foreign_key_check').all();
  return { ...f, order, pending, ship, undo, editOrder, moves, own, revisions, balance, remove, deliveries, foreignKeys };
}
