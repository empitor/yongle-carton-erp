// 本机管理员改订单连带改送货单留下的记录（server/flow/rules/order-edit-cascade.ts）：每张被拆、减行、换客户的送货单一条审计，
// 改挂的出库流水备注里的单号跟着换、修订记录留着原备注。
import { AUDIT_SOURCE } from '../shared/core/audit-sources.js';
import { test } from 'node:test';
import '../server/import/index.js';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { many, one, rows as dbRows } from '../server/core/index.js';
import { customerSchema } from '../shared/core/domain.js';
import { splitDeliveryFixture } from './maintenance-fixture.js';

const movements = z.array(z.string());
const docRef = z.looseObject({ id: z.number() });
const deliveryAudit = z.looseObject({
  lines: z.array(z.looseObject({})),
  customerId: z.number(),
  status: z.string(),
  movements: movements.optional(),
});
const customerChange = z.looseObject({ before: deliveryAudit, after: deliveryAudit });
const lineRemoval = customerChange.extend({ movedTo: docRef.nullable(), movedMovements: movements });
const splitDelivery = z.looseObject({ from: docRef, after: deliveryAudit, movements });

test('拆分、减行、换客户的送货单各记一条单据级审计：带改之前和改之后、拆到哪张、带走哪几笔流水；不再记“新建待核对单据”', () => {
  const f = splitDeliveryFixture();
  try {
    const audits = (after: number) =>
      many(f.store.db, dbRows.business_audit.pick({ source: true, action: true, record_id: true, document: true }),
        "SELECT source,action,record_id,document FROM business_audit WHERE id>? AND entity='flow_delivery' ORDER BY id", after)
        .map((r) => ({ key: [r.source, r.action, Number(r.record_id)].join('/'), detail: r.document }));
    const mark = () => {
      const row = one(f.store.db, z.object({ n: z.number() }), 'SELECT coalesce(max(id),0) AS n FROM business_audit');
      assert.ok(row);
      return row.n;
    };

    // 已出库的送货单：两张订单各一行，其中一张换客户
    const a = f.order([100]),
      b = f.order([100]);
    const d = f.ship([{ order: a }, { order: b }]);
    const other = f.store.saveCustomer(customerSchema.parse({ name: '虚构审计客户' }));
    let from = mark();
    f.editOrder(a.id, { customerId: other.id });
    const split = f.deliveries().find((x) => x.id !== d.id);
    assert.ok(split);
    let rows = audits(from);
    assert.deepEqual(
      rows.map((r) => r.key),
      [AUDIT_SOURCE.page + '/remove-delivery-lines/' + d.id, AUDIT_SOURCE.page + '/split-delivery/' + split.id],
      '原单少了行、新单拆出来，各一条；没有“新建待核对单据”',
    );
    const removed = lineRemoval.parse(JSON.parse(rows[0].detail));
    const created = splitDelivery.parse(JSON.parse(rows[1].detail));
    assert.ok(removed.movedTo);
    assert.deepEqual([removed.before.lines.length, removed.after.lines.length, removed.movedTo.id], [2, 1, split.id]);
    assert.deepEqual(removed.movedMovements, split.movements);
    assert.notDeepEqual(removed.before.movements, removed.after.movements, '原单记的流水号也变了，审计里看得到');
    assert.deepEqual(
      [created.from.id, created.after.status, created.after.customerId, created.movements],
      [d.id, 'confirmed', other.id, split.movements],
      '新单记的是它最后的样子：已出库，带着改挂过来的流水',
    );

    // 只带这张订单的送货单：原地换客户，也记一条
    from = mark();
    f.editOrder(a.id, { customerId: f.customer.id });
    rows = audits(from);
    assert.deepEqual(rows.map((r) => r.key), [AUDIT_SOURCE.page + '/change-delivery-customer/' + split.id]);
    const changed = customerChange.parse(JSON.parse(rows[0].detail));
    assert.deepEqual([changed.before.customerId, changed.after.customerId], [other.id, f.customer.id]);

    // 改订单删明细：送货单少了一行，没有拆到别的单
    const c = f.order([100, 60]);
    const e = f.ship([{ order: c, line: 0 }, { order: c, line: 1, quantity: '60' }]);
    from = mark();
    const current = f.store.order(c.id);
    assert.ok(current);
    f.editOrder(c.id, { lines: [current.lines[0]] });
    rows = audits(from);
    assert.deepEqual(rows.map((r) => r.key), [AUDIT_SOURCE.page + '/remove-delivery-lines/' + e.id]);
    const detached = lineRemoval.parse(JSON.parse(rows[0].detail));
    assert.deepEqual([detached.movedTo, detached.movedMovements.length], [null, 1]);

    // 已撤销的送货单拆出来的新单：审计里记的是已撤销、没有流水
    const g = f.order([100]),
      h = f.order([100]);
    const r = f.ship([{ order: g }, { order: h }]);
    f.undo(r.id);
    from = mark();
    f.editOrder(g.id, { customerId: other.id });
    rows = audits(from);
    const reversedSplit = rows.find((x) => x.key.includes('split-delivery'));
    assert.ok(reversedSplit);
    const reversed = splitDelivery.parse(JSON.parse(reversedSplit.detail));
    assert.deepEqual([reversed.after.status, reversed.movements], ['reversed', []]);
    assert.ok(!rows.some((x) => x.key.includes('create-draft')));
    assert.deepEqual(f.foreignKeys(), []);
  } finally {
    f.store.close();
  }
});

test('拆出去的出库流水改挂到新送货单时，备注里的单号跟着换成新单的，修订记录里留着原备注；留成独立流水的、不是“单号 · 说明”写法的备注不动', () => {
  const f = splitDeliveryFixture();
  try {
    const row = (id: unknown) => {
      const movement = one(f.store.db, dbRows.stock_movements.pick({ notes: true, source_kind: true, source_id: true }),
        'SELECT notes,source_kind,source_id FROM stock_movements WHERE id=?', String(id));
      assert.ok(movement);
      return movement;
    };
    const notesOf = (id: unknown) => row(id).notes;
    const lastRevision = (id: unknown) => {
      const r = one(f.store.db, dbRows.stock_movement_revisions.pick({ before_document: true, after_document: true }),
        'SELECT before_document,after_document FROM stock_movement_revisions WHERE movement_id=? ORDER BY id DESC LIMIT 1', String(id));
      assert.ok(r);
      assert.ok(r.after_document);
      return {
        before: z.looseObject({ notes: z.string() }).parse(JSON.parse(r.before_document)),
        after: z.looseObject({ source_kind: z.string(), source_id: z.string().nullable(), notes: z.string().optional() }).parse(JSON.parse(r.after_document)),
      };
    };
    const splitOf = (orderId: number, originalId: number) => {
      const delivery = f.deliveries().find((x) => x.id !== originalId && x.lines.some((l) => l.orderId === orderId));
      assert.ok(delivery);
      return delivery;
    };
    const other = f.store.saveCustomer(customerSchema.parse({ name: '虚构备注客户' }));

    // 出库确认时的备注：“单号 · 客户发货”
    const a = f.order([100]),
      b = f.order([100, 60]);
    const d = f.ship([{ order: a }, { order: b, line: 0 }, { order: b, line: 1, quantity: '60' }]);
    const [ma, mb1, mb2] = f.moves().filter((m) => m.source_id === String(d.id));
    assert.deepEqual([ma, mb1, mb2].map((m) => notesOf(m.id)), Array(3).fill(d.number + ' · 客户发货'));

    // a 换客户：它那笔出库改挂到新送货单，备注里的单号换成新单的；留在原单上的两笔不动
    f.editOrder(a.id, { customerId: other.id });
    const split = splitOf(a.id, d.id);
    assert.notEqual(split.number, d.number);
    assert.deepEqual([notesOf(ma.id), String(row(ma.id).source_id)], [split.number + ' · 客户发货', String(split.id)], '备注里的单号和来源对得上');
    assert.deepEqual([notesOf(mb1.id), notesOf(mb2.id)], Array(2).fill(d.number + ' · 客户发货'));
    const moved = lastRevision(ma.id);
    assert.equal(moved.before.notes, d.number + ' · 客户发货', '修订记录里留着原备注');
    assert.deepEqual(moved.after, { source_kind: 'flow_delivery', source_id: String(split.id), notes: split.number + ' · 客户发货' });

    // 改订单删掉 b 的第二行：那笔出库留成独立流水，不挂在别的单上，备注还留着原来的送货单号
    const current = f.store.order(b.id);
    assert.ok(current);
    f.editOrder(b.id, { lines: [current.lines[0]] });
    assert.deepEqual([row(mb2.id).source_kind, row(mb2.id).source_id, notesOf(mb2.id)], ['database-maintenance', null, d.number + ' · 客户发货']);
    assert.deepEqual(lastRevision(mb2.id).after, { source_kind: 'database-maintenance', source_id: null });

    // 备注被人手工写成了别的样子：改挂时原样留着，修订记录里也不记备注变化
    const g = f.order([50]),
      h = f.order([50]);
    const d3 = f.ship([{ order: g, quantity: '50' }, { order: h, quantity: '50' }]);
    const mg = f.moves().find((m) => m.source_id === String(d3.id) && Number(m.customer_order_id) === g.id);
    assert.ok(mg);
    f.store.db.prepare("UPDATE stock_movements SET notes='虚构手写备注' WHERE id=?").run(mg.id);
    f.editOrder(g.id, { customerId: other.id });
    const split3 = splitOf(g.id, d3.id);
    assert.deepEqual([notesOf(mg.id), String(row(mg.id).source_id)], ['虚构手写备注', String(split3.id)]);
    assert.deepEqual(lastRevision(mg.id).after, { source_kind: 'flow_delivery', source_id: String(split3.id) });
    assert.deepEqual(f.foreignKeys(), []);
  } finally {
    f.store.close();
  }
});
