// 助手出的库存类卡片（核对到货、完工、送货、冲销、删除、出入库、登记到货、采购退货）：人点了确认才写，
// 走的是和页面同一个事务服务，权限、库存不足、幂等照旧。内存库、虚构数据。
import { z } from 'zod';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { actor, superActor, assistantFixture, cardDigest, lastCard, readAs } from './assistant-fixture.js';
import { customerSchema, productSchema, orderSchema, today } from '../shared/core/domain.js';
import { OperationsService } from '../server/operations/service.js';
import { saveDoc } from './receive-fixture.js';
import { asList, field } from '../server/assistant/chat/result-fields.js';
import { count } from '../server/core/index.js';
import type { Actor } from '../server/core/index.js';

const call = (name: string, args: Record<string, unknown>) => ({ message: '', toolCalls: [{ name, args }] });
/** 让模型调一个出卡片的命令，返回这张卡片 */
async function propose(f: ReturnType<typeof assistantFixture>, thread: string, who: Actor, name: string, args: Record<string, unknown>) {
  f.replies.push(call(name, args));
  const plan = lastCard(await f.say(thread, '虚构：办' + name, {}, who));
  assert(plan, name + ' 应该出卡片');
  return plan;
}

test('核对到货、完工、送货，冲销送货，删除空档案：点了确认才走原事务服务', async () => {
  const f = assistantFixture(),
    owner = superActor();
  try {
    const ops = new OperationsService(f.store),
      flow = f.manager.tools.flow,
      supplier = ops.saveSupplier({ name: '虚构供应商' }, actor),
      product = f.store.saveProduct(productSchema.parse({ name: '虚构纸箱' })),
      customer = f.store.saveCustomer(customerSchema.parse({ name: '虚构客户' })),
      raw = ops.saveItem({ name: '虚构纸板', kind: 'raw', unit: '张' }, actor),
      finished = ops.saveItem({ name: '虚构纸箱', kind: 'finished', unit: '只', productId: product.id, specification: '型号A' }, actor),
      thread = f.manager.create(owner).id;
    const confirm = async (name: string, args: Record<string, unknown>) => f.manager.execute((await propose(f, thread, owner, name, args)).id, { acknowledged: true }, owner, 's');
    const arrival = saveDoc(flow, 'arrival', {
      date: '2026-10-25',
      supplierId: supplier.id,
      reference: 'GLOBAL-ARR-1',
      lines: [{ stockId: raw.id, item: { name: '虚构纸板', unit: '张' }, quantity: '100' }],
    }, actor);
    const a = await propose(f, thread, owner, 'flow.propose_confirmation', { id: arrival.id });
    assert.equal(ops.repo.balance(raw.id), 0, '出卡片不动库存');
    f.manager.execute(a.id, { acknowledged: true }, owner, 's');
    assert.equal(ops.repo.balance(raw.id), 100000);
    const production = saveDoc(flow, 'production', {
      date: '2026-10-25',
      productId: product.id,
      finishedStockId: finished.id,
      goodQuantity: '50',
      scrapQuantity: '3',
      operator: '虚构操作员',
      materials: [{ stockId: raw.id, issued: '60', returned: '10' }],
    }, actor);
    await confirm('flow.propose_confirmation', { id: production.id });
    assert.equal(ops.repo.balance(raw.id), 50000);
    assert.equal(ops.repo.balance(finished.id), 50000);
    const order = f.store.saveOrder(
      orderSchema.parse({
        customerId: customer.id,
        orderDate: '2026-10-25',
        deliveryDate: '2026-10-25',
        status: '已确认',
        lines: [{ productId: product.id, productName: product.name, specification: '型号A', quantity: 100, unit: '只', unitPriceCents: 100 }],
      }),
    );
    const delivery = saveDoc(flow, 'delivery', {
      date: '2026-10-25',
      customerId: customer.id,
      lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: finished.id, quantity: '30' }],
    }, actor);
    await confirm('flow.propose_confirmation', { id: delivery.id });
    // 出库按实际出库那天记：单据写的是 10-25，今天确认，单据日期和出库流水都是今天，原来的日期留作计划送货日
    const shipped = flow.get(delivery.id, 'delivery');
    assert.deepEqual([shipped.date, shipped.plannedDate], [today(), '2026-10-25']);
    assert.equal(ops.repo.balance(finished.id), 20000);
    assert.equal(f.store.order(order.id)?.lines[0].shippedQuantity, 30);
    await confirm('flow.propose_reversal', { id: delivery.id, reason: '人工核对后撤销错误送货' });
    assert.equal(ops.repo.balance(finished.id), 50000);
    const reversed = f.store.order(order.id);
    assert.ok(reversed, '订单还在');
    assert.equal(reversed.lines[0].shippedQuantity, 0);
    const unused = f.store.saveProduct(productSchema.parse({ name: '可永久删除的虚构空档案' }));
    const deletion = await propose(f, thread, owner, 'records.delete', { module: 'products', id: unused.id });
    // 密码由聊天接口在确认卡片提交时核验
    f.manager.execute(deletion.id, { acknowledged: true, deletionDigest: cardDigest(deletion) }, owner, 's', { passwordVerified: true });
    assert.equal(f.store.product(unused.id, true), undefined);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.close();
  }
});

test('出入库卡片要编辑权限、点了才入库、出库超过库存拒绝；登记到货的卡片只在回滚预演里算，不动库存和已到货', async () => {
  const f = assistantFixture(),
    owner = superActor();
  try {
    const ops = new OperationsService(f.store),
      item = ops.saveItem({ name: '虚构纸板', kind: 'raw', unit: '张' }, actor);
    const move = (quantity: string, action = 'in') => ({ id: item.id, action, quantity, date: '2026-10-25', notes: '虚构' });
    assert(f.manager.tools.prepare('inventory.propose_movement', move('10'), actor, 's'));
    assert.throws(() => f.manager.tools.prepare('inventory.propose_movement', move('1'), { ...actor, permissions: [] }, 's'), /权限/);
    const plan = await propose(f, f.manager.create(owner).id, owner, 'inventory.propose_movement', move('10'));
    assert.equal(ops.repo.balance(item.id), 0);
    f.manager.execute(plan.id, { acknowledged: true }, owner, 's');
    assert.equal(ops.repo.balance(item.id), 10000);
    assert.throws(() => f.manager.tools.prepare('inventory.propose_movement', move('11', 'out'), owner, 's'), /库存不足/);
    const supplier = ops.saveSupplier({ name: '虚构供应商' }, actor),
      purchase = ops.savePurchase(
        {
          supplierId: supplier.id,
          orderDate: '2026-10-25',
          status: '已订货',
          lines: [{ name: '纸板', length: 1000, width: 800, dimensionUnit: 'mm', unit: '张', quantity: '20', priceBasis: 'quantity' }],
        },
        actor,
      ),
      batch = readAs(f.manager.tools.read('order_batch.get', { purchaseId: purchase.id }, owner), {});
    const receipt = f.manager.tools.prepare(
      'order_batch.receive',
      { id: batch.id, expectedVersion: batch.version, reference: 'AI-R-1', date: '2026-10-25', rows: [{ row: 1, quantity: '5', rejectedQuantity: '0' }], requestId: randomUUID() },
      owner,
      's',
    );
    assert.equal(ops.repo.purchases()[0].lines[0].receivedQuantity, '0');
    assert.equal(field(field(receipt.after, 'arrival'), 'status'), 'confirmed');
    assert.equal(field((asList(field(field(receipt.after, 'batch'), 'rows')) ?? [])[0], 'remainingUnits'), 15000);
  } finally {
    f.close();
  }
});

test('采购退货：查可退数量；退货和撤销退货只出卡片，和页面同一服务；等确认时别的库存品出入库不让卡片失效；再点不重复退', async () => {
  const f = assistantFixture();
  try {
    const ops = new OperationsService(f.store),
      flow = f.manager.tools.flow,
      supplier = ops.saveSupplier({ name: '虚构退货纸板厂' }, actor),
      raw = ops.saveItem({ name: '虚构退货纸板', kind: 'raw', unit: '张' }, actor);
    const purchase = ops.savePurchase(
      { supplierId: supplier.id, orderDate: '2026-11-01', status: '已订货', lines: [{ ...raw, stockItemId: raw.id, quantity: '100', unitPrice: '1.0000', priceBasis: 'quantity' }] },
      actor,
    );
    const draft = saveDoc(flow, 'arrival', {
      supplierId: supplier.id,
      date: '2026-11-05',
      reference: '虚构退货到货单',
      lines: [{ stockId: raw.id, purchaseLineId: purchase.lines[0].id, item: raw, quantity: '100', unitPrice: '1.0000', priceBasis: 'quantity' }],
    }, actor);
    const arrival = flow.confirm(draft.id, { previewDigest: flow.preview(draft.id, actor).previewDigest, requestId: randomUUID(), acknowledged: true }, actor);
    const returnable = () => readAs(f.manager.tools.read('purchase_return.returnable', { arrivalId: arrival.id }, actor), { lines: z.array(z.looseObject({})) });
    assert.equal(returnable().canReturn, true);
    assert.equal(returnable().lines[0].returnable, '100');
    const plan = await propose(f, f.manager.create(actor).id, actor, 'purchase_return.create', {
      arrivalId: arrival.id,
      date: today(),
      reason: '虚构质量问题',
      lines: [{ lineIndex: 0, quantity: '30' }],
      requestId: randomUUID(),
    });
    const other = ops.saveItem({ name: '虚构无关纸板', kind: 'raw', unit: '张' }, actor);
    ops.move(other.id, { expectedVersion: other.version, requestId: randomUUID(), action: 'in', quantity: '5', date: today(), notes: '虚构无关入库', acknowledged: true }, actor);
    assert.equal(ops.repo.balance(raw.id), 100000, '没人确认前不扣库存');
    assert.equal(count(f.store.db, 'SELECT COUNT(*) n FROM purchase_returns'), 0);
    const created = f.manager.execute(plan.id, { acknowledged: true }, actor, 's');
    assert.equal(ops.repo.balance(raw.id), 70000);
    assert.equal(field(f.manager.execute(plan.id, { acknowledged: true }, actor, 's'), 'id'), field(created, 'id'), '再点一次不重复退');
    assert.equal(ops.repo.balance(raw.id), 70000);
    assert.ok(f.store.db.prepare("SELECT 1 FROM business_audit WHERE entity='purchase_returns' AND action='create'").get());
    assert.equal(returnable().lines[0].returnable, '70');
    // 撤销退货要超级管理员模式（没权限、没进模式两种说法见 assistant-account-scope.test.ts）
    const owner = superActor();
    const reverse = await propose(f, f.manager.create(owner).id, owner, 'purchase_return.reverse', { id: field(created, 'id'), version: field(created, 'version'), reason: '虚构退错' });
    assert.equal(ops.repo.balance(raw.id), 70000);
    f.manager.execute(reverse.id, { acknowledged: true }, owner, 's');
    assert.equal(ops.repo.balance(raw.id), 100000);
    assert.ok(f.store.db.prepare("SELECT 1 FROM business_audit WHERE entity='purchase_returns' AND action='reverse'").get());
  } finally {
    f.close();
  }
});
