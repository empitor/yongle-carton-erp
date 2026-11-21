// 到货记录（server/flow/arrivals.ts、receipt-events.ts、arrival-source.ts）：验收和入库状态、逐行入库流水、采购库存要看的到货数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { flowFixture, clerk } from './flow-fixture.js';
import { orderedPurchase, saveDoc } from './receive-fixture.js';
import { many, rows as tableRows } from '../server/core/index.js';
import { arrivalSource, purchaseArrivals, reservedUnits } from '../server/flow/arrival-source.js';
import { receiptEvents } from '../server/flow/receipt-events.js';

function fixture() {
  const f = flowFixture();
  const p = orderedPurchase(f, clerk);
  const draft = (lines: unknown[], reference = randomUUID()) =>
    saveDoc(f.flow, 'arrival', { date: '2026-10-29', supplierId: f.supplier.id, reference, lines }, clerk);
  const confirm = (d: { id: number }) =>
    f.base.check(d, {}, clerk);
  const record = (id: number) => {
    const found = f.flow.arrivalRecords({ includeInactive: true }).find((r) => r.flowId === id);
    assert.ok(found);
    return found;
  };
  const item = { name: f.raw.name, unit: '张' };
  const linked = (quantity: string, extra = {}) => ({ stockId: f.raw.id, purchaseLineId: p.purchase.lines[0].id, item, quantity, ...extra });
  const loose = (quantity: string, extra = {}) => ({ stockId: f.raw.id, item, quantity, differenceReason: '虚构无采购单到货', ...extra });
  const moves = () =>
    many(f.store.db, tableRows.stock_movements, 'SELECT * FROM stock_movements ORDER BY rowid');
  return { ...f, ...p, draft, confirm, record, linked, loose, moves };
}

test('待核对的到货写明尚未入库；核对后按实际入库数入库，原始流水缺了不虚报实际入库', () => {
  const f = fixture();
  try {
    const d = f.draft([f.linked('100', { acceptedQuantity: '90', rejectedQuantity: '10', stockedQuantity: '90' })]);
    assert.equal(f.record(d.id).inventoryStatus, '尚未入库');
    assert.equal(f.record(d.id).lines[0].stockedQuantity, '0');
    assert.equal(f.current().lines[0].receivedQuantity, '0');
    assert.equal(f.moves().length, 0);
    f.confirm(d);
    assert.equal(f.record(d.id).lines[0].stockedQuantity, '90');
    assert.equal(f.current().lines[0].receivedQuantity, '100');
    f.store.db.prepare("DELETE FROM stock_movements WHERE source_kind='flow_arrival' AND source_id=?").run(String(d.id));
    assert.equal(f.record(d.id).inventoryStatus, '入库待核对');
    assert.equal(f.record(d.id).lines[0].stockedQuantity, null);
  } finally {
    f.store.close();
  }
});

test('没验收就取消的到货单显示未验收、原单已失效，不当成全部合格', () => {
  const f = fixture();
  try {
    const d = f.draft([f.linked('100')]);
    assert.equal(f.record(d.id).inspectionStatus, '待验收');
    f.flow.cancel(d.id, { version: d.version, reason: '虚构取消', acknowledged: true }, clerk);
    const r = f.record(d.id);
    assert.deepEqual([r.status, r.inspectionStatus, r.inventoryStatus], ['cancelled', '未验收', '原单已失效']);
    assert.equal(f.moves().length, 0);
  } finally {
    f.store.close();
  }
});

test('到货详情逐行列入库流水：同一库存品的几行各挂各的一笔、一行入库 0 不串；撤销后扣回的一笔按库存品合计挂第一行；流水和行对不上就待核对，不按申报猜', () => {
  const f = fixture();
  try {
    const flows = (id: number) => f.record(id).lines.map((l) => l.movements.map((m) => [m.source_kind, Number(m.delta_units)]));
    const ids = (id: number) => f.record(id).lines.flatMap((l) => l.movements.map((m) => m.id));
    const mixed = f.confirm(f.draft([f.linked('100'), f.loose('50')]));
    assert.deepEqual(flows(mixed.id), [[['flow_arrival', 100_000]], [['flow_arrival', 50_000]]]);
    assert.equal(new Set(ids(mixed.id)).size, 2, '同一笔流水只出现在一行');
    assert.equal(f.record(mixed.id).inventoryStatus, '已入库');
    f.flow.reverse(mixed.id, { version: mixed.version, reason: '虚构登记重了', acknowledged: true }, clerk);
    assert.deepEqual(flows(mixed.id), [
      [
        ['flow_arrival', 100_000],
        ['flow_reversal', -150_000],
      ],
      [['flow_arrival', 50_000]],
    ]);
    assert.deepEqual(f.record(mixed.id).lines.map((l) => l.stockedQuantity), ['100', '50'], '入库数只看入库那几笔');
    const zero = f.confirm(f.draft([f.loose('3', { acceptedQuantity: '0', rejectedQuantity: '3', stockedQuantity: '0' }), f.loose('7')]));
    assert.deepEqual(f.record(zero.id).lines.map((l) => [l.stockedQuantity, !!l.inventoryMismatch]), [['0', false], ['7', false]]);
    assert.equal(f.record(zero.id).inventoryStatus, '部分入库');
    // 流水和行数对不上（删掉一条模拟）：两行都待核对
    const both = f.confirm(f.draft([f.loose('3'), f.loose('7')]));
    f.store.db
      .prepare("DELETE FROM stock_movements WHERE rowid=(SELECT max(rowid) FROM stock_movements WHERE source_kind='flow_arrival' AND source_id=?)")
      .run(String(both.id));
    assert.deepEqual(f.record(both.id).lines.map((l) => l.stockedQuantity), [null, null]);
    assert.equal(f.record(both.id).inventoryStatus, '入库待核对');
  } finally {
    f.store.close();
  }
});

test('没有采购单的到货行采购单号留空（页面写“无采购单”），不填一个假单号；挂了采购单的写它的单号', () => {
  const f = fixture();
  try {
    const d = f.draft([f.linked('10'), f.loose('5')]);
    assert.deepEqual(f.record(d.id).lines.map((l) => l.purchaseNumber), [f.purchase.number, '']);
    f.confirm(d);
    assert.deepEqual(f.record(d.id).lines.map((l) => l.purchaseNumber), [f.purchase.number, '']);
  } finally {
    f.store.close();
  }
});

test('到货行没写计价方式：挂了采购明细的跟采购明细走，写了的照写的，没挂的留空等人补', () => {
  const f = fixture();
  try {
    const other = orderedPurchase(f, clerk, ['500']);
    const written = f.linked('5', { purchaseLineId: other.purchase.lines[0].id, priceBasis: 'area' });
    const d = f.confirm(f.draft([f.linked('10'), written, f.loose('5')]));
    assert.deepEqual(f.flow.get(d.id, 'arrival').lines.map((l) => l.priceBasis), ['quantity', 'area', null], '采购明细是按张');
  } finally {
    f.store.close();
  }
});

test('采购库存要看的到货数据：已到货和到货记录、单据引用、订货单的到货、待送货占用的成品', () => {
  const f = fixture();
  try {
    const received = f.receive('300', '虚构送货单-数据');
    const loaded = purchaseArrivals(f.store, [f.purchase.id]);
    assert.equal(loaded.receivedUnits.get(f.purchase.lines[0].id), 300000);
    assert.equal(loaded.apply(f.ops.repo.purchaseRows(true, f.purchase.id))[0].receipts.length, 1);
    assert.equal(arrivalSource.purchaseReferenced(f.store, f.purchase.id), true);
    assert.deepEqual([...arrivalSource.referencedStock(f.store, [f.raw.id, f.finished.id])], [f.raw.id]);
    assert.equal(arrivalSource.documentNumbers(f.store, [received.arrival.id]).get(String(received.arrival.id))?.number, received.arrival.number);
    const batchId = f.batch().id;
    assert.equal(arrivalSource.batchHasArrivals(f.store, batchId), true);
    assert.deepEqual(arrivalSource.batchArrivals(f.store, batchId).map((a) => [a.id, a.reference]), [[received.arrival.id, '虚构送货单-数据']]);
    const order = f.order(50);
    f.stockIn('100');
    saveDoc(f.flow, 'delivery', { date: '2026-10-27', customerId: f.customer.id, lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: f.finished.id, quantity: '30' }] }, clerk);
    assert.equal(reservedUnits(f.store, [f.finished.id]).get(f.finished.id), 30000);
    assert.equal(reservedUnits(f.store).get(f.finished.id), 30000);
  } finally {
    f.store.close();
  }
});

test('按采购单读到货：一张到货单挂了几张采购单的明细，读其中一张时整张到货单的明细照样都在（更正要用）', () => {
  const f = fixture();
  try {
    const other = orderedPurchase(f, clerk, ['500']);
    f.confirm(f.draft([f.linked('10'), { ...f.linked('10'), purchaseLineId: other.purchase.lines[0].id }]));
    const scoped = receiptEvents(f.store, [f.purchase.id]);
    assert.deepEqual(scoped, receiptEvents(f.store).filter((e) => e.lines.some((l) => l.purchaseId === f.purchase.id)));
    assert.equal(scoped[0].lines.length, 2);
    assert.equal(f.current().receipts[0].correctionLines.length, 2);
  } finally {
    f.store.close();
  }
});
