// 财务从业务拿数据的只读窗口（server/flow/finance-facts/）：来源一组的口径。heads 只给已确认、已撤销的单据和盘点流水，
// texts 按批读原文和单号，read 解析成财务口径和算进指纹的内容，被删的看不到，撤销（更正）那天按冲回流水的日期。
// 业务重写模块时靠这些测试判断窗口有没有接对。全部是虚构数据，只用内存库。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { StoredDataError } from '../server/core/index.js';
import { financeFacts, type SourceText } from '../server/flow/index.js';
import { z } from 'zod';
import { financeFingerprint, flowDocumentSchema, toFinanceSource } from '../shared/business/index.js';
import { businessChanges } from './business-changes-fixture.js';
import { clerk, flowFixture } from './flow-fixture.js';
import { applyCorrection, previewCorrection } from './receive-fixture.js';
import { shipOnDocDate } from './ship-date.js';

/** 送货（确认、撤销、待送货各一张）、到货两张、手工入库和盘点各一笔流水 */
function world() {
  const f = flowFixture();
  f.stockIn('100');
  f.base.stockIn(f.raw, { quantity: '10', date: '2026-10-20' });
  const order = f.order(100);
  const deliver = (quantity: string, date: string) => {
    const d = f.draft('delivery', { date, customerId: f.customer.id, lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: f.finished.id, quantity }] });
    f.confirmId(d.id, shipOnDocDate(f.flow, d.id));
    return d.id;
  };
  const shipped = deliver('5', '2026-10-25'),
    voided = deliver('3', '2026-10-24');
  f.flow.reverse(voided, { version: f.flow.get(voided).version, reason: '虚构：发错', acknowledged: true }, clerk);
  const pending = f.draft('delivery', { customerId: f.customer.id, lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: f.finished.id, quantity: '1' }] }).id;
  const arrived = f.arrive('虚构送货单-1', '20').id,
    other = f.arrive('虚构送货单-2', '30').id;
  const adjust = (quantity: string) =>
    f.flow.stock.move(
      f.raw.id,
      { action: 'adjust', quantity, date: '2026-10-26', notes: '虚构盘点', expectedVersion: f.ops.items(true, f.raw.id)[0].version, acknowledged: true, requestId: randomUUID() },
      clerk,
    ).movementId;
  return { f, shipped, voided, pending, arrived, other, counted: adjust('58') };
}

test('来源一览：只给已确认、已撤销的送货、到货、完工单和盘点流水，单据按种类、状态、日期排，盘点流水排最后', () => {
  const w = world();
  const production = businessChanges(w.f.store).confirmed('production', '2026-10-27', {
    productId: w.f.product.id,
    finishedStockId: w.f.finished.id,
    goodQuantity: '10',
    operator: '虚构机长',
    materials: [],
  });
  const heads = financeFacts.sources.heads(w.f.store.db);
  assert.deepEqual(
    heads.map((h) => [h.kind, h.id, h.status, h.date]),
    [
      ['arrival', String(w.arrived), 'confirmed', '2026-10-27'],
      ['arrival', String(w.other), 'confirmed', '2026-10-27'],
      ['delivery', String(w.shipped), 'confirmed', '2026-10-25'],
      ['delivery', String(w.voided), 'reversed', '2026-10-24'],
      ['production', String(production), 'confirmed', '2026-10-27'],
      ['stock', w.counted, 'confirmed', '2026-10-26'],
    ],
    '待送货的、手工入库的流水不在里面',
  );
  assert.ok(heads.every((h) => h.version >= 1));
});

test('按批读原文：一次读出单号和内容，解析成财务口径；算进指纹的内容按约定的 financeFingerprint 取；找不到的不在结果里', () => {
  const w = world();
  const db = w.f.store.db;
  const texts = financeFacts.sources.texts(db, [
    { kind: 'delivery', id: String(w.shipped) },
    { kind: 'arrival', id: String(w.arrived) },
    { kind: 'delivery', id: String(w.pending) },
    { kind: 'arrival', id: String(w.shipped) },
  ]);
  assert.deepEqual(texts.map((t) => [t.kind, t.id]).sort(), [['arrival', String(w.arrived)], ['delivery', String(w.shipped)]], '待送货的、种类不对的读不到');
  const shipped = texts.find((t) => t.kind === 'delivery');
  assert.ok(shipped);
  assert.equal(shipped.number, w.f.flow.get(w.shipped).number);
  const { kind: _kind, ...content } = z.record(z.string(), z.unknown()).parse(JSON.parse(shipped.text));
  const read = financeFacts.sources.read(shipped);
  assert.deepEqual(read.counted, financeFingerprint('delivery', content), '指纹算的是约定里归“算”的栏目，财务口径的名字');
  assert.deepEqual(read.doc, toFinanceSource('delivery', flowDocumentSchema('delivery').parse(content)));
  assert.equal(read.doc.customerId, w.f.customer.id);
  assert.deepEqual(financeFacts.sources.texts(db, []), []);
});

test('盘点流水：单号拼成“库存品名 调整量 单位”，内容是流水的几项，管理员改写一次版本加一', () => {
  const w = world();
  const db = w.f.store.db;
  const [text] = financeFacts.sources.texts(db, [{ kind: 'stock', id: w.counted }]);
  assert.equal(text.number, '虚构纸板 -2 张', '期初 10 张加两次到货 50 张，盘成 58 张');
  const read = financeFacts.sources.read(text);
  assert.deepEqual(read.doc, { stockId: w.f.raw.id, deltaUnits: -2000, reason: '虚构盘点', createdAt: text.at });
  businessChanges(w.f.store).reviseMovement(w.counted, { notes: '虚构：改了备注' });
  const after = financeFacts.sources.heads(db).filter((h) => h.kind === 'stock');
  assert.deepEqual(after.map((h) => [h.id, h.version]), [[w.counted, text.version + 1]]);
});

test('被删的看不到：删掉的单据、盘点流水不在一览和原文里', () => {
  const w = world();
  const db = w.f.store.db,
    changes = businessChanges(w.f.store);
  const loose = changes.confirmed('delivery', '2026-10-21', {
    plannedDate: '2026-10-21',
    customerId: w.f.customer.id,
    lines: [{ orderId: 1, orderLineId: 1, stockId: w.f.finished.id, quantity: '1' }],
  });
  assert.ok(financeFacts.sources.heads(db).some((h) => h.id === String(loose)));
  changes.remove(loose);
  changes.removeMovements([w.counted]);
  const ids = financeFacts.sources.heads(db).map((h) => h.id);
  assert.ok(!ids.includes(String(loose)) && !ids.includes(w.counted));
  assert.deepEqual(financeFacts.sources.texts(db, [{ kind: 'delivery', id: String(loose) }, { kind: 'stock', id: w.counted }]), []);
});

test('内容读不出来：read 抛 StoredDataError（财务按它逐条跳过），一览照样给', () => {
  const w = world();
  businessChanges(w.f.store).tamper('flow_documents', w.shipped, '$.lines', '虚构的坏明细');
  const [text] = financeFacts.sources.texts(w.f.store.db, [{ kind: 'delivery', id: String(w.shipped) }]);
  assert.throws(() => financeFacts.sources.read(text), StoredDataError);
  assert.ok(financeFacts.sources.heads(w.f.store.db).some((h) => h.id === String(w.shipped)));
  const broken: SourceText = { ...text, kind: 'stock', text: '不是 JSON' };
  assert.throws(() => financeFacts.sources.read(broken), StoredDataError);
});

test('到货撤销（更正）那天：已撤销的取冲回流水的日期，替代单取被替代的原单冲回流水的日期，没撤销过的都是 null', () => {
  const w = world();
  const { store, flow } = w.f;
  flow.reverse(w.arrived, { version: flow.get(w.arrived).version, reason: '虚构：登记错了', acknowledged: true }, clerk);
  businessChanges(store).moveMovements({ kind: 'flow_reversal', id: w.arrived }, '2026-10-28');
  const record = flow.arrivalRecords({ includeInactive: true }).find((r) => r.flowId === w.other);
  assert.ok(record);
  const input = { expectedVersion: record.version, reason: '虚构：点错数量', items: [{ index: 0, quantity: '25' }] };
  const preview = previewCorrection(store, 'flow-' + w.other, input, clerk);
  const replacement = applyCorrection(store, 'flow-' + w.other, { ...input, requestId: randomUUID(), previewDigest: preview.previewDigest }, clerk).replacementId;
  businessChanges(store).moveMovements({ kind: 'flow_reversal', id: w.other }, '2026-10-29');
  const dates = financeFacts.sources.arrivalReversalDates(store.db, [String(w.arrived), String(replacement), String(w.other), String(w.shipped)]);
  assert.deepEqual(Object.fromEntries(dates), {
    [w.arrived]: { own: '2026-10-28', replaced: null },
    [replacement]: { own: null, replaced: '2026-10-29' },
    [w.other]: { own: '2026-10-29', replaced: null },
    [w.shipped]: { own: null, replaced: null },
  });
});
