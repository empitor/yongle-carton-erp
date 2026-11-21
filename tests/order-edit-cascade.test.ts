// 本机管理员给订单换客户时连带改送货单（server/business/order-edit-cascade.ts）：共享的送货单拆开，出库流水改挂、不重记，
// 状态和出库、送达记录沿用；写到一半失败整笔回滚；不是本机管理员的不能连带改。删明细见 order-edit-line-removal.test.ts，
// 审计和流水备注见 order-edit-audit.test.ts，删除引擎本身见 database-maintenance.test.ts。
import { pageActor } from './actor-fixture.js';
import { test } from 'node:test';
// 删除引擎要各模块登记的删除规则
import '../server/import/index.js';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { many, rows } from '../server/core/index.js';
import { customerSchema } from '../shared/core/domain.js';
import { flowStatusLabel } from '../shared/business/physical-flow.js';
import { manualWrite } from '../server/business/service.js';
import { splitDeliveryFixture } from './maintenance-fixture.js';
import { orderOf } from './flow-fixture.js';

const tables = ['orders', 'order_lines', 'flow_documents', 'flow_refs', 'stock_movements', 'stock_movement_revisions', 'business_audit'];
const snapshot = (f: ReturnType<typeof splitDeliveryFixture>) =>
  Object.fromEntries(tables.map((t) => [t, f.store.db.prepare('SELECT * FROM ' + t + ' ORDER BY rowid').all()]));

test('订单已出库后改客户和数量：金额重算，只发这张订单的送货单原地换客户，库存不动', () => {
  const f = splitDeliveryFixture();
  try {
    const a = f.order([100]);
    const d = f.ship([{ order: a }]);
    const customer = f.store.saveCustomer(customerSchema.parse({ name: '明确更正的客户' }));
    const saved = f.editOrder(a.id, { customerId: customer.id, lines: orderOf(f.store, a.id).lines.map((l) => ({ ...l, quantity: 50 })) });
    assert.deepEqual([saved.customerId, saved.lines[0].quantity, saved.totalCents], [customer.id, 50, 5000]);
    assert.equal(f.flow.get(d.id, 'delivery').customerId, customer.id);
    assert.equal(f.balance(), 760000);
    assert.deepEqual(f.foreignKeys(), []);
  } finally {
    f.store.close();
  }
});

test('改订单客户拆分已出库、已送达的送货单：拆出来的新单沿用原单的出库和送达记录、原来安排的日期', () => {
  const f = splitDeliveryFixture();
  try {
    const a = f.order([100]),
      b = f.order([100]);
    const shipped = f.ship([{ order: a }, { order: b }], { plannedDate: '2026-10-26' });
    const delivered = f.flow.markDelivered(shipped.id, { version: shipped.version }, f.who);
    assert.equal(flowStatusLabel(delivered), '已送达');
    const other = f.store.saveCustomer(customerSchema.parse({ name: '拆分送货更正客户' }));
    f.editOrder(a.id, { customerId: other.id });
    const split = f.deliveries().find((d) => d.customerId === other.id);
    assert.ok(split && split.id !== delivered.id, '拆出了一张新送货单');
    for (const k of ['date', 'plannedDate', 'confirmedBy', 'confirmedAt', 'shippedAt', 'shippedBy', 'deliveredAt', 'deliveredBy'] as const)
      assert.equal(split[k], delivered[k], k + ' 沿用原单');
    assert.equal(flowStatusLabel(split), '已送达', '拆出来的仍是已送达，不是送货中');
    assert.equal(flowStatusLabel(f.flow.get(delivered.id)), '已送达');
    assert.equal(f.balance(), 660000, '已有出库不重复扣减');
    assert.deepEqual(f.foreignKeys(), []);
  } finally {
    f.store.close();
  }
});

test('改订单客户拆分已撤销的送货单：出库和冲销两组流水都留在原单上、合计为 0，拆出的新单没有流水；删原单、删新单、两张都删，库存都不变', () => {
  for (const [which, policy] of [
    ['新单', 'recalculate'],
    ['原单', 'recalculate'],
    ['两张', 'recalculate'],
    ['新单', 'preserve'],
    ['原单', 'preserve'],
  ] as const) {
    const f = splitDeliveryFixture();
    try {
      const a = f.order([100]),
        b = f.order([100]);
      const d = f.ship([{ order: a }, { order: b }]);
      f.undo(d.id);
      assert.equal(f.balance(), 860000, '出库 200 又撤销，库存还是 860');
      const before = f.moves();
      const reversalIds = before.filter((m) => m.source_kind === 'flow_reversal').map((m) => String(m.id));
      assert.deepEqual(f.own(d.id), { out: -200000, back: 200000 });

      const other = f.store.saveCustomer(customerSchema.parse({ name: '虚构拆分撤销客户' }));
      f.editOrder(a.id, { customerId: other.id });

      const docs = f.deliveries();
      assert.equal(docs.length, 2);
      const original = docs.find((x) => x.id === d.id),
        split = docs.find((x) => x.id !== d.id);
      assert.ok(original);
      assert.ok(split);
      assert.deepEqual([original.status, split.status], ['reversed', 'reversed'], '两张都还是已撤销');
      assert.deepEqual([original.customerId, original.lines.map((l) => l.orderId)], [f.customer.id, [b.id]]);
      assert.deepEqual([split.customerId, split.lines.map((l) => l.orderId)], [other.id, [a.id]]);
      assert.deepEqual(f.moves(), before, '拆单没有改任何流水');
      assert.equal(f.revisions(), 0);
      assert.deepEqual(f.own(original.id), { out: -200000, back: 200000 });
      assert.deepEqual(f.own(split.id), { out: 0, back: 0 }, '拆出的已撤销送货单名下没有流水');
      assert.deepEqual(original.reversal?.movements, reversalIds, '原单的撤销记录还指着那几笔冲销流水');
      assert.deepEqual(split.reversal?.movements, [], '新单的撤销记录不带流水号');
      assert.equal(split.reversal?.reason, original.reversal?.reason);

      if (which !== '原单') f.remove(split.id, policy);
      if (which !== '新单') f.remove(original.id, policy);
      const label = '删' + which + '（' + (policy === 'recalculate' ? '库存一起改回' : '库存数量不动') + '）';
      assert.equal(f.balance(), 860000, label + '后库存不变');
      for (const left of f.deliveries()) {
        const sums = f.own(left.id);
        assert.equal(sums.out + sums.back, 0, label + '后，留下的已撤销送货单名下合计仍是 0');
      }
      assert.equal(
        f.moves().filter((m) => m.source_id === String(d.id) || m.source_id === String(split.id)).length,
        which === '新单' ? 3 : 0,
        label + '后，被删单据名下不留流水',
      );
      // 删原单时它的三笔流水按库存处理方式处理，都留了修订记录；删没有流水的新单不产生修订
      assert.equal(f.revisions(), which === '新单' ? 0 : 3);
      assert.deepEqual(f.foreignKeys(), []);
    } finally {
      f.store.close();
    }
  }
});

test('改订单客户拆分已出库的送货单：两张单各自名下的出库等于各自的明细，明细快照照旧，单据里记的流水号对得上；删任意一张、两张都删、撤销新单，库存都对', () => {
  for (const which of ['删新单', '删原单', '都删', '撤销新单'] as const) {
    const f = splitDeliveryFixture();
    try {
      const a = f.order([100]),
        b = f.order([100]);
      const d = f.ship([{ order: a }, { order: b }]);
      const snapshotLine = d.lines.find((l) => l.orderId === a.id);
      assert.ok(snapshotLine);
      assert.equal(f.balance(), 660000);
      const other = f.store.saveCustomer(customerSchema.parse({ name: '虚构拆分出库客户' }));
      f.editOrder(a.id, { customerId: other.id });

      const docs = f.deliveries();
      const original = docs.find((x) => x.id === d.id),
        split = docs.find((x) => x.id !== d.id);
      assert.ok(original);
      assert.ok(split);
      assert.deepEqual([original.status, split.status], ['confirmed', 'confirmed']);
      const moved = split.lines[0];
      assert.deepEqual(
        [moved.amountExact, moved.unitPriceExact, moved.productName],
        [snapshotLine.amountExact, snapshotLine.unitPriceExact, snapshotLine.productName],
        '拆出的新单保留确认时的明细快照',
      );
      assert.deepEqual(f.own(original.id), { out: -100000, back: 0 });
      assert.deepEqual(f.own(split.id), { out: -100000, back: 0 });
      const idsOf = (id: number) =>
        f
          .moves()
          .filter((m) => m.source_kind === 'flow_delivery' && m.source_id === String(id))
          .map((m) => String(m.id));
      assert.deepEqual(original.movements, idsOf(original.id), '原单记的流水号就是现在还在它名下的那一笔');
      assert.deepEqual(split.movements, idsOf(split.id));
      assert.ok(f.revisions() > 0, '拆、改挂出库流水都留了修订记录');
      assert.equal(f.balance(), 660000, '拆单不重复扣库存');

      if (which === '删新单' || which === '都删') f.remove(split.id);
      if (which === '删原单' || which === '都删') f.remove(original.id);
      if (which === '撤销新单') {
        f.undo(split.id);
        assert.deepEqual(f.own(split.id), { out: -100000, back: 100000 });
      }
      assert.equal(f.balance(), which === '都删' ? 860000 : 760000, which + '后库存');
      assert.deepEqual(f.foreignKeys(), []);
    } finally {
      f.store.close();
    }
  }
});

test('订单已由别的送货单发完时改客户：带着这张订单的已撤销、已取消、待送货的旧送货单照样拆开，不被“超过订单剩余数量”拦住，流水不动', () => {
  const f = splitDeliveryFixture();
  try {
    const a = f.order([100]),
      b = f.order([100]);
    const both = [{ order: a }, { order: b }];
    const reversed = f.ship(both);
    f.undo(reversed.id);
    const cancelled = f.pending(both);
    f.flow.cancel(cancelled.id, { version: cancelled.version, reason: '虚构：不送了', acknowledged: true }, f.who);
    const waiting = f.pending(both);
    const shipped = f.ship([{ order: a }]);
    assert.equal(orderOf(f.store, a.id).status, '已发货');
    const before = f.moves();

    const other = f.store.saveCustomer(customerSchema.parse({ name: '虚构发完后换客户' }));
    f.editOrder(a.id, { customerId: other.id });

    const edited = orderOf(f.store, a.id);
    assert.deepEqual([edited.customerId, edited.status], [other.id, '已发货']);
    const docs = f.deliveries();
    // 三张旧单各拆成两张，状态各自沿用；只带这张订单的已出库送货单直接换客户
    for (const [source, status] of [
      [reversed, 'reversed'],
      [cancelled, 'cancelled'],
      [waiting, 'draft'],
    ] as const) {
      const kept = docs.find((x) => x.id === source.id);
      assert.ok(kept);
      assert.deepEqual([kept.status, kept.customerId, kept.lines.map((l) => l.orderId)], [status, f.customer.id, [b.id]]);
    }
    const moved = docs.filter((x) => ![reversed.id, cancelled.id, waiting.id, shipped.id].includes(x.id));
    assert.deepEqual(moved.map((x) => x.status).sort(), ['cancelled', 'draft', 'reversed']);
    assert.ok(moved.every((x) => x.customerId === other.id && x.lines.length === 1 && x.lines[0].orderId === a.id));
    assert.equal(f.flow.get(shipped.id, 'delivery').customerId, other.id);
    // 没有一张已出库的送货单被拆：流水原样，不产生修订
    assert.deepEqual(f.moves(), before);
    assert.equal(f.revisions(), 0);
    for (const x of moved) assert.deepEqual(f.own(x.id), { out: 0, back: 0 });
    assert.equal(f.balance(), 760000);
    assert.deepEqual(f.foreignKeys(), []);
  } finally {
    f.store.close();
  }
});

test('一张送货单发三张订单，其中一张换客户：三张订单的出库各归各的订单，流水号、顺序号、数量都没变；订单的已发数量和状态不变；再改回原客户也不动流水', () => {
  const f = splitDeliveryFixture();
  try {
    const a = f.order([100]),
      b = f.order([100]),
      c = f.order([100]);
    const d = f.ship([{ order: a }, { order: b }, { order: c }]);
    assert.equal(f.balance(), 560000);
    const before = f.moves().filter((m) => m.source_id === String(d.id));
    assert.deepEqual(
      before.map((m) => [Number(m.delta_units), Number(m.customer_order_id)]),
      [a, b, c].map((o) => [-100000, o.id]),
    );
    const maxSeq = Math.max(...f.moves().map((m) => Number(m.seq)));
    const orderView = (id: number) => {
      const o = orderOf(f.store, id);
      return [o.customerId, o.status, o.lines[0].shippedQuantity];
    };

    const other = f.store.saveCustomer(customerSchema.parse({ name: '虚构三单拆分客户' }));
    f.editOrder(b.id, { customerId: other.id });
    const split = f.deliveries().find((x) => x.id !== d.id);
    assert.ok(split);
    const of = (id: number) => f.moves().filter((m) => m.source_kind === 'flow_delivery' && m.source_id === String(id));
    assert.deepEqual(of(d.id), [before[0], before[2]], '留在原单上的两笔出库原样没动，各自还记着自己的订单');
    assert.deepEqual(of(split.id), [{ ...before[1], source_id: String(split.id) }], '换客户那张订单的出库还是原来那笔，只是改挂到新送货单');
    assert.equal(Math.max(...f.moves().map((m) => Number(m.seq))), maxSeq, '没有合并、没有新记流水');
    const revisionRow = rows.stock_movement_revisions.pick({ movement_id: true, reason: true, after_document: true });
    const revisionDocument = z.looseObject({ source_id: z.string() });
    const revisions = () =>
      many(f.store.db, revisionRow, 'SELECT movement_id,reason,after_document FROM stock_movement_revisions ORDER BY id').map((r) => {
        assert.ok(r.after_document);
        return [r.movement_id, r.reason, revisionDocument.parse(JSON.parse(r.after_document)).source_id];
      });
    assert.deepEqual(revisions(), [[String(before[1].id), '拆分送货单 ' + d.number, String(split.id)]]);
    assert.deepEqual(f.flow.get(d.id).movements, [String(before[0].id), String(before[2].id)]);
    assert.deepEqual(split.movements, [String(before[1].id)]);
    assert.deepEqual(f.flow.get(d.id, 'delivery').lines.map((l) => l.orderId), [a.id, c.id]);
    assert.deepEqual([split.status, split.customerId, split.lines.map((l) => l.orderId)], ['confirmed', other.id, [b.id]]);
    assert.equal(f.balance(), 560000);
    assert.deepEqual(orderView(a.id), [f.customer.id, '已发货', 100]);
    assert.deepEqual(orderView(b.id), [other.id, '已发货', 100]);
    assert.deepEqual(orderView(c.id), [f.customer.id, '已发货', 100]);

    // 改回原客户：拆出的那张送货单跟着换回客户（不并回原单），流水和修订记录都不再变
    const moves = f.moves(),
      logged = revisions();
    f.editOrder(b.id, { customerId: f.customer.id });
    const docs = f.deliveries();
    assert.equal(docs.length, 2);
    assert.ok(docs.every((x) => x.status === 'confirmed' && x.customerId === f.customer.id));
    assert.deepEqual(f.moves(), moves);
    assert.deepEqual(revisions(), logged);
    assert.deepEqual(orderView(b.id), [f.customer.id, '已发货', 100]);
    assert.equal(f.balance(), 560000);
    assert.deepEqual(f.foreignKeys(), []);
  } finally {
    f.store.close();
  }
});

test('改订单连带拆送货单写到一半失败（写修订记录出错）：订单、送货单、流水、修订记录、审计全部回到改之前；去掉故障后再改能成功', () => {
  const f = splitDeliveryFixture();
  try {
    const a = f.order([100]),
      b = f.order([100]);
    f.ship([{ order: a }, { order: b }]);
    const other = f.store.saveCustomer(customerSchema.parse({ name: '虚构回滚客户' }));
    const before = snapshot(f);
    f.store.db.exec("CREATE TRIGGER fail_revision BEFORE INSERT ON stock_movement_revisions BEGIN SELECT RAISE(ABORT,'虚构：写修订记录失败'); END");
    assert.throws(() => f.editOrder(a.id, { customerId: other.id }), /虚构：写修订记录失败/);
    assert.deepEqual(snapshot(f), before);
    f.store.db.exec('DROP TRIGGER fail_revision');
    f.editOrder(a.id, { customerId: other.id });
    assert.equal(orderOf(f.store, a.id).customerId, other.id);
    assert.equal(f.deliveries().length, 2);
    assert.ok(f.revisions() > 0);
  } finally {
    f.store.close();
  }
});

test('不是本机管理员的不能连带改单据：远程的超级管理员模式、普通账号给有已出库送货单的订单换客户、删明细都被拦下，送货单不拆、流水不动', () => {
  const f = splitDeliveryFixture();
  try {
    const a = f.order([100, 60]),
      b = f.order([100]);
    f.ship([{ order: a, line: 0 }, { order: a, line: 1, quantity: '60' }, { order: b }]);
    const other = f.store.saveCustomer(customerSchema.parse({ name: '虚构越权客户' }));
    const remoteSuper = pageActor({
      id: 'fictional-remote-super',
      name: '虚构远程管理员',
      role: 'super_admin' as const,
      permissions: ['business:edit'],
      superAdminMode: true,
      superAdminUntil: Date.now() + 3600000,
    });
    const clerk = pageActor({ id: 'fictional-clerk', name: '虚构业务员', permissions: ['business:edit'] });
    const before = snapshot(f);
    for (const who of [remoteSuper, clerk]) {
      const edit = (patch: object) =>
        manualWrite(f.store, { entity: 'orders', action: 'update', id: a.id, input: { ...orderOf(f.store, a.id, true), ...patch } }, who);
      assert.throws(() => edit({ customerId: other.id }), /订单已关联生产\/送货记录，不能改变客户/, who.name + '换客户');
      assert.throws(() => edit({ lines: [orderOf(f.store, a.id).lines[0]] }), /不能改变客户、产品明细/, who.name + '删明细');
    }
    assert.deepEqual(snapshot(f), before);
  } finally {
    f.store.close();
  }
});
