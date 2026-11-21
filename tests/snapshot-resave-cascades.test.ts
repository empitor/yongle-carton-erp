// 本机管理员改订单、改库存品、解除采购明细时连带重存单据：服务端抄下的快照字段引用没变的原样保留，
// 引用换了才按新引用取（用户 2026-11-21 定）。快照字段从单据结构派生，每个都先填成虚构的标记值（snapshot-fixture.ts）。
// 内存库、虚构数据。
import { test } from 'node:test';
// 删除引擎要各模块登记的删除规则（改订单整张删送货单时用）
import '../server/import/index.js';
import assert from 'node:assert/strict';
import { alignStock, detachPurchaseLines } from '../server/flow/maintenance-cascade.js';
import { storedDocument } from '../server/flow/read.js';
import { orderOf } from './flow-fixture.js';
import { fixture, splitDeliveryFixture } from './maintenance-fixture.js';
import { assertSnapshots, markSnapshots } from './snapshot-fixture.js';

test('改订单去掉一行：合送的送货单留下的那一行、只是少了订单的生产任务，快照都留着原来的', () => {
  const f = splitDeliveryFixture();
  try {
    const second = f.base.product({ name: '虚构纸箱二' });
    const order = f.order([300, 200]),
      d = f.ship([{ order }, { order, line: 1 }]);
    const both = f.base.order(f.customer, [f.base.line(f.product, 100), f.base.line(second, 100)]),
      task = f.flow.save('task', { date: '2026-10-27', productId: second.id, quantity: '100', unit: '只', orderIds: [both.id] }, f.who);
    markSnapshots(f.store, d.id);
    markSnapshots(f.store, task.id);
    f.editOrder(order.id, { lines: [orderOf(f.store, order.id).lines[0]] });
    f.editOrder(both.id, { lines: [orderOf(f.store, both.id).lines[0]] });
    const after = storedDocument(f.store, d.id, 'delivery');
    assert.equal(after.lines.length, 1);
    assertSnapshots(after);
    const detached = storedDocument(f.store, task.id, 'task');
    assert.deepEqual(detached.orderIds, []);
    assertSnapshots(detached);
  } finally {
    f.store.close();
  }
});

test('订单换客户：整张改客户的送货单客户名按新客户取，明细快照留着；和别的订单合送的拆出新单，两张的明细快照都留着', () => {
  const f = splitDeliveryFixture();
  try {
    const other = f.base.customer({ name: '虚构新客户' });
    const alone = f.order([300]),
      own = f.ship([{ order: alone }]);
    const mixed = f.order([300]),
      kept = f.order([300]),
      shared = f.ship([{ order: mixed }, { order: kept }]);
    markSnapshots(f.store, own.id);
    markSnapshots(f.store, shared.id);
    f.editOrder(alone.id, { customerId: other.id });
    f.editOrder(mixed.id, { customerId: other.id });
    const moved = storedDocument(f.store, own.id, 'delivery');
    assertSnapshots(moved, { doc: ['customerName'] });
    assert.equal(moved.customerName, '虚构新客户');
    assertSnapshots(storedDocument(f.store, shared.id));
    const split = f.deliveries().find((d) => d.id !== own.id && d.id !== shared.id && d.customerId === other.id);
    assert.ok(split, '拆出了新送货单');
    const created = storedDocument(f.store, split.id, 'delivery');
    assert.deepEqual(created.lines.map((l) => l.orderId), [mixed.id]);
    assertSnapshots(created, { doc: ['customerName'] });
    assert.equal(created.customerName, '虚构新客户');
  } finally {
    f.store.close();
  }
});

test('库存品改名对齐到货单：这一行的纸板资料换成新的、面积金额重算，别的快照留着原来的', () => {
  const f = fixture();
  try {
    const a = f.arrival();
    markSnapshots(f.store, a.id);
    const item = f.ops.items(true, f.raw.id)[0];
    alignStock(f.flow, item, { ...item, name: '虚构纸板改名' }, f.who);
    const after = storedDocument(f.store, a.id, 'arrival');
    assert.equal(after.lines[0].item.name, '虚构纸板改名');
    assertSnapshots(after, { lines: { 0: ['area', 'amount'] } });
  } finally {
    f.store.close();
  }
});

test('解除采购明细：到货行的采购单编号、单号跟着清掉，别的快照留着原来的', () => {
  const f = fixture();
  try {
    const a = f.arrival();
    markSnapshots(f.store, a.id);
    detachPurchaseLines(f.flow, f.purchase.id, [f.purchase.lines[0].id], f.who);
    const after = storedDocument(f.store, a.id, 'arrival');
    assert.deepEqual([after.lines[0].purchaseLineId, after.lines[0].purchaseId, after.lines[0].purchaseNumber], [null, null, '']);
    assertSnapshots(after, { lines: { 0: ['purchaseId', 'purchaseNumber'] } });
  } finally {
    f.store.close();
  }
});
