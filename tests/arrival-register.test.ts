// 登记到货（server/flow/register-arrival.ts，唯一入口）和到货单的核对入库：入库、幂等、回滚、校验。内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { count, many, one, rows as tableRows } from '../server/core/index.js';
import { flowFixture, clerk, localAdmin } from './flow-fixture.js';
import { orderedPurchase, saveDoc } from './receive-fixture.js';
import type { Actor } from '../server/core/auth.js';
import type { StockItemView } from '../shared/business/index.js';
import { registerArrival } from '../server/flow/register-arrival.js';
import { syncReceivedUnits } from '../server/flow/receipt-events.js';
import { viewOfKind } from '../server/flow/read.js';
import { buildDashboard } from '../server/business/dashboard.js';

function fixture(lines?: (string | [StockItemView, string])[]) {
  const f = flowFixture();
  const moves = () =>
    many(f.store.db, tableRows.stock_movements, 'SELECT * FROM stock_movements ORDER BY rowid');
  const arrivals = () => f.flow.list('arrival');
  return { ...f, ...orderedPurchase(f, clerk, lines), moves, arrivals, balance: () => f.ops.repo.balance(f.raw.id) };
}

test('登记到货：给采购单就按它的订货单登记，当场入库；合格、不合格、实际入库分开存，库存只加实际入库；不带订货单版本被拒', () => {
  const f = fixture();
  try {
    const line = f.purchase.lines[0],
      batch = f.batch();
    const input = {
      expectedVersion: batch.version,
      requestId: randomUUID(),
      reference: '虚构送货单-核心',
      date: '2026-10-10',
      rows: [{ key: batch.rows[0].key, quantity: '400', rejectedQuantity: '50', stockedQuantity: '300' }],
    };
    const { expectedVersion: _v, ...withoutVersion } = input;
    assert.throws(() => registerArrival(f.store, { purchaseId: f.purchase.id }, withoutVersion, clerk), /请带上订货单的版本/);
    const done = registerArrival(f.store, { purchaseId: f.purchase.id }, input, clerk);
    assert.equal(done.arrival.status, 'confirmed');
    assert.equal(done.arrival.orderBatchId, batch.id);
    assert.deepEqual(
      done.arrival.lines.map((l) => [l.purchaseLineId, l.quantity, l.acceptedQuantity, l.rejectedQuantity, l.stockedQuantity]),
      [[line.id, '400', '350', '50', '300']],
    );
    assert.equal(f.balance(), 300000);
    assert.equal(f.current().lines[0].receivedQuantity, '400', '采购已到货按实到算');
    assert.equal(done.batch.rows[0].remainingUnits, 600000);
    assert.deepEqual(f.flow.arrivalRecords({ purchaseId: f.purchase.id }).map((r) => r.flowId), [done.arrival.id]);
    // 已到货缓存和按到货单现算的一致
    syncReceivedUnits(f.store);
    const cached = one(f.store.db, tableRows.purchase_lines.pick({ received_units: true }), 'SELECT received_units FROM purchase_lines WHERE id=?', line.id);
    assert.ok(cached);
    assert.equal(cached.received_units, 400000);
  } finally {
    f.store.close();
  }
});

test('分两批到货：部分到货变全部到货，入同一个库存品；到货记录、采购单、报表的数一致', () => {
  const f = fixture(['10000']);
  try {
    const first = f.receive('5000', '虚构批次1', { date: '2026-10-29', actualTime: '14:00' });
    assert.equal(f.current().arrivalProgress, '部分到货');
    assert.equal(f.current().businessStatus, '已订货');
    assert.equal(f.current().lines[0].remainingQuantity, '5000');
    const second = f.receive('5000', '虚构批次2', { date: '2026-10-30', actualTime: '09:30' });
    assert.notEqual(first.arrival.id, second.arrival.id);
    assert.equal(f.current().arrivalProgress, '全部到货');
    assert.equal(f.current().businessStatus, '已订货');
    assert.deepEqual([f.current().lines[0].receivedQuantity, f.current().lines[0].remainingQuantity], ['10000', '0']);
    assert.equal(f.balance(), 10000000);
    const records = f.flow.arrivalRecords({ purchaseId: f.purchase.id });
    assert.deepEqual(records.map((r) => [r.actualTime, r.inspectionStatus, r.lines[0].stockedQuantity]), [
      ['09:30', '全部合格', '5000'],
      ['14:00', '全部合格', '5000'],
    ]);
    assert.equal(f.current().receipts.length, 2);
    assert.deepEqual(f.moves().map((m) => m.source_kind), ['flow_arrival', 'flow_arrival']);
    assert.equal(buildDashboard(f.store, [], {}).overview.purchases.arrivedCents, 2000000);
    assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    f.store.close();
  }
});

test('不重复登记：同一请求原样返回、换内容被拒；旧版本、超量、早于采购日期、送货单号重复（不分大小写和首尾空格）都拦下；验收数不对整单不落库', () => {
  const f = fixture(['10000']);
  try {
    for (const row of [
      { quantity: '100', rejectedQuantity: '120' },
      { quantity: '100', rejectedQuantity: '10', stockedQuantity: '100' },
    ]) {
      assert.throws(() => f.receive([row], '虚构验收错'), /不合格数量不能超过本次实到数量|实际入库数量不能超过合格数量/);
      assert.deepEqual([f.arrivals().length, f.moves().length], [0, 0]);
    }
    const input = f.input('5000', 'dh-唯一批次'),
      result = f.register(input);
    assert.equal(f.register(input).arrival.id, result.arrival.id);
    assert.throws(() => f.register({ ...input, actualTime: '15:00' }), /不同内容/);
    assert.throws(() => f.register({ ...input, requestId: randomUUID() }), /订货单已更新/);
    assert.throws(() => f.receive('5001', '虚构超量'), /比还没到的 5000 张 多/);
    assert.throws(() => f.receive('100', '虚构早到', { date: '2026-09-30' }), /到货日期不能早于采购日期/);
    assert.throws(() => f.receive('100', ' DH-唯一批次 '), /同一供应商送货单号/);
    assert.deepEqual([f.moves().length, f.arrivals().length], [1, 1]);
    assert.equal(f.current().lines[0].receivedQuantity, '5000');
  } finally {
    f.store.close();
  }
});

test('登记中途写库失败：整单回滚，不留半张到货单、不换订货单版本、不记审计；重试照常且只入库一次', () => {
  const f = fixture(['10000']);
  try {
    const input = f.input('5000', '虚构中断批次'),
      version = f.batch().version;
    const audits = count(f.store.db, 'SELECT COUNT(*) n FROM business_audit');
    f.store.db.exec("CREATE TRIGGER reject_actual BEFORE UPDATE ON purchases BEGIN SELECT RAISE(ABORT,'fictional interrupted'); END");
    assert.throws(() => f.register(input), /fictional interrupted/);
    assert.equal(f.arrivals().length, 0);
    assert.equal(f.batch().version, version);
    assert.equal(f.moves().length, 0);
    assert.equal(count(f.store.db, 'SELECT COUNT(*) n FROM business_audit'), audits);
    f.store.db.exec('DROP TRIGGER reject_actual');
    const done = f.register(input);
    assert.equal(f.register(input).arrival.id, done.arrival.id);
    assert.equal(f.moves().length, 1);
  } finally {
    f.store.close();
  }
});

test('存成待入库（AI 识别的送货单）：不动库存、已到货和订货单，不能排日期；重新识别改存同一张；人核对后才入库，入库和撤销都换订货单版本', () => {
  const f = fixture();
  try {
    const before = f.batch().version;
    const waiting = f.receive('200', '虚构送货单-识别', { pending: true, actualTime: '15:45' });
    assert.equal(waiting.arrival.status, 'draft');
    assert.equal(waiting.arrival.lines[0].purchaseLineId, f.purchase.lines[0].id);
    assert.equal(f.balance(), 0);
    assert.equal(f.current().lines[0].receivedQuantity, '0');
    assert.equal(f.batch().version, before);
    // 到货没有计划日：到货安排在订货单上
    assert.throws(
      () => f.flow.schedule(waiting.arrival.id, { expectedVersion: waiting.arrival.version, plannedDate: '2026-11-05', requestId: randomUUID() }, clerk),
      /仅可调整未完成生产任务或待送货的送货单/,
    );
    const ref = { id: waiting.arrival.id, version: waiting.arrival.version };
    assert.throws(() => f.receive('250', '虚构送货单-识别', { arrival: ref }), /只有待入库的到货单能改存/);
    const resaved = f.receive('250', '虚构送货单-识别', { pending: true, arrival: ref, actualTime: '15:45' });
    assert.equal(resaved.arrival.id, waiting.arrival.id);
    assert.equal(resaved.arrival.lines[0].quantity, '250');
    assert.equal(f.arrivals().length, 1);
    const done = viewOfKind(f.base.check(resaved.arrival, {}, clerk), 'arrival');
    assert.equal(done.actualTime, '15:45');
    assert.equal(f.balance(), 250000);
    assert.equal(f.current().lines[0].receivedQuantity, '250');
    // 核对入库、撤销都换订货单的版本号：开着的登记窗口拿旧版本登记会被拦
    assert.equal(f.batch().version, before + 1);
    f.flow.reverse(done.id, { version: done.version, reason: '虚构：登记重了', acknowledged: true }, clerk);
    assert.equal(f.batch().version, before + 2);
    assert.throws(() => f.register({ ...f.input('10', '虚构旧窗口'), expectedVersion: before }), /订货单已更新/);
  } finally {
    f.store.close();
  }
});

test('待入库的送货单记下原文数量、面积和差异原因；数量和原文对不上又没写原因，拒收', () => {
  const f = fixture();
  try {
    const pending = (row: Record<string, unknown>) => f.receive([{ quantity: '200', ...row }], '虚构送货单-原文', { pending: true });
    assert.throws(() => pending({ statedQuantity: '250' }), /实收数量与送货单数量不一致，请记录差异原因/);
    assert.equal(f.arrivals().length, 0);
    const saved = pending({ statedQuantity: '250', statedArea: '120.5', differenceReason: '虚构：少送 50 张' }).arrival;
    assert.deepEqual(
      [saved.lines[0].statedQuantity, saved.lines[0].statedArea, saved.lines[0].differenceReason],
      ['250', '120.5', '虚构：少送 50 张'],
    );
  } finally {
    f.store.close();
  }
});

test('挂采购单的到货只能登记到货产生：通用保存带采购明细被拒；改存待入库单不能换订货单，库里被改挂到别的订货单的核对时拦下', () => {
  const f = fixture();
  try {
    const line = f.purchase.lines[0];
    const linked = (extra: Record<string, unknown> = {}) => ({
      date: '2026-10-10',
      supplierId: f.supplier.id,
      reference: '虚构送货单-绕路',
      lines: [{ stockId: f.raw.id, purchaseLineId: line.id, item: { ...line, unit: '张' }, quantity: '100', unitPrice: '2', priceBasis: 'quantity' }],
      ...extra,
    });
    const onlyByBatch = /挂采购单的到货请在到货页“待到货”里按订货单登记到货/;
    assert.throws(() => f.flow.save('arrival', linked(), clerk), onlyByBatch);
    assert.throws(() => f.flow.save('arrival', linked({ orderBatchId: f.batch().id }), clerk), onlyByBatch);
    // 不挂采购单的货照常
    const loose = f.flow.save('arrival', { date: '2026-10-10', supplierId: f.supplier.id, reference: '虚构样品', lines: [{ stockId: f.raw.id, item: { name: f.raw.name, unit: '张' }, quantity: '5' }] }, clerk);
    assert.equal(loose.status, 'draft');
    // 改登记出来的待入库单：留在原订货单上可以改，换到别的订货单不行
    const waiting = f.receive('200', '虚构送货单-待核对', { pending: true }).arrival;
    const edited = f.flow.save('arrival', { ...waiting, notes: '虚构改备注', version: waiting.version }, clerk, waiting.id);
    assert.equal(edited.notes, '虚构改备注');
    const other = orderedPurchase(f, clerk, ['50']);
    const otherBatch = other.batch().id;
    assert.throws(
      () => f.flow.save('arrival', { ...edited, orderBatchId: otherBatch, version: edited.version }, clerk, waiting.id),
      /到货明细的采购单不在这份订货单里|挂采购单的到货请在/,
    );
    f.store.db.prepare("UPDATE flow_documents SET order_batch_id=?,document=json_set(document,'$.orderBatchId',?) WHERE id=?").run(otherBatch, otherBatch, waiting.id);
    assert.throws(() => f.flow.preview(waiting.id, clerk), /到货明细的采购单不在这份订货单里/);
    assert.equal(f.balance(), 0);
  } finally {
    f.store.close();
  }
});

/** 一种有尺寸、材质的纸板（不挂采购单的到货按它比规格、算面积） */
const board = { name: '五层纸板', kind: 'raw', unit: '张', length: 100, width: 80, dimensionUnit: 'cm', material: 'K=A', flute: 'BC' };
const looseArrival = (f: ReturnType<typeof fixture>, lines: unknown[], reference: string = randomUUID()) =>
  saveDoc(f.flow, 'arrival', { date: '2026-10-20', supplierId: f.supplier.id, reference, lines }, clerk);

test('不挂采购单的到货：选的库存品规格不一致、数量和原文对不上没写原因都拒收；几种纸板一起收，一样的入已有的、不一样的新建，算不出面积的面积和金额留空', () => {
  const f = fixture();
  try {
    const stock = f.ops.saveItem(board, clerk);
    const item = { ...board, kind: undefined };
    assert.throws(() => looseArrival(f, [{ stockId: stock.id, item: { ...item, length: 120 }, quantity: '10' }]), /不一致/);
    assert.throws(() => looseArrival(f, [{ stockId: stock.id, item, quantity: '10', statedQuantity: '12' }]), /差异原因/);
    const d = looseArrival(f, [
      { item, quantity: '10', differenceReason: '独立备料' },
      { item: { ...item, length: 120, dimensionUnit: null }, quantity: '12', unitPrice: '1.2345', differenceReason: '规格待补充' },
    ]);
    const p = f.flow.preview(d.id, clerk);
    const previewed = viewOfKind(p.document, 'arrival').lines[1];
    assert.deepEqual([previewed.area, previewed.amount], [null, null]);
    const result = viewOfKind(f.flow.confirm(d.id, { previewDigest: p.previewDigest, requestId: randomUUID(), acknowledged: true }, clerk), 'arrival');
    assert.equal(result.lines[0].stockId, stock.id);
    assert.notEqual(result.lines[1].stockId, stock.id);
  } finally {
    f.store.close();
  }
});

test('到货明细的单位：空、没写按“张”，单据和新建的库存品一致；别的单位拒收，不换算', () => {
  const f = fixture();
  try {
    const stock = f.ops.saveItem(board, clerk);
    const { kind: _kind, unit: _unit, ...noUnit } = board;
    const draft = (item: Record<string, unknown>, stockId: number | null = stock.id) =>
      looseArrival(f, [{ stockId, item, quantity: '10', differenceReason: '虚构无采购单' }]);
    assert.equal(draft({ ...noUnit, unit: '' }).lines[0].item.unit, '张');
    assert.equal(draft(noUnit).lines[0].item.unit, '张');
    assert.throws(() => draft({ ...noUnit, unit: '公斤' }), /原材料的数量单位只有“张”；别的单位请先换算成张再填。/);
    const d = draft({ ...noUnit, name: '虚构新纸板', length: 90, unit: '' }, null);
    const done = viewOfKind(f.base.check(d, {}, clerk), 'arrival');
    assert.equal(f.ops.repo.items(true, Number(done.lines[0].stockId))[0].unit, '张');
    const stored = one(f.store.db, tableRows.flow_documents.pick({ document: true }), 'SELECT document FROM flow_documents WHERE id=?', done.id);
    assert.ok(stored);
    const parsed = z
      .object({ lines: z.array(z.object({ item: z.object({ unit: z.string() }) })) })
      .parse(JSON.parse(stored.document) as unknown);
    assert.equal(parsed.lines[0].item.unit, '张');
  } finally {
    f.store.close();
  }
});

test('纸板按整张：到货填小数张、验收数带小数张、合格加不合格不等于实到，都拒收，不落库', () => {
  const f = fixture();
  try {
    const line = (row: Record<string, string>) => [{ stockId: f.raw.id, item: { name: f.raw.name, unit: '张' }, differenceReason: '虚构', ...row }];
    assert.throws(() => looseArrival(f, line({ quantity: '10.5' })), /纸板库存按整张登记，不能填写小数张。/);
    assert.throws(
      () => looseArrival(f, line({ quantity: '10', acceptedQuantity: '6.5', rejectedQuantity: '3.5' })),
      /纸板到货、验收及入库均使用整张数量。/,
    );
    assert.throws(
      () => looseArrival(f, line({ quantity: '10', acceptedQuantity: '6', rejectedQuantity: '3' })),
      /验收合格与不合格数量之和必须等于本批实际到货数量。/,
    );
    assert.deepEqual([f.arrivals().length, f.balance()], [0, 0]);
  } finally {
    f.store.close();
  }
});

test('到货单先校验再写：订货单不存在、识别原件不存在都说清楚；实收日期不能晚于今天', () => {
  const f = fixture();
  try {
    const line = [{ stockId: f.raw.id, item: { name: f.raw.name, unit: '张' }, quantity: '10' }];
    assert.throws(() => saveDoc(f.flow, 'arrival', { date: '2026-10-20', supplierId: f.supplier.id, reference: '虚构-批次', orderBatchId: 999999, lines: line }, clerk), /订货单不存在/);
    assert.throws(() => saveDoc(f.flow, 'arrival', { date: '2026-10-20', supplierId: f.supplier.id, reference: '虚构-原件', sourceId: randomUUID(), lines: line }, clerk), /AI识别原件不存在/);
    assert.throws(() => f.confirm('arrival', { date: '2099-06-01', supplierId: f.supplier.id, reference: '虚构-未来', lines: line }), /到货日期不能晚于今天/);
    assert.equal(f.arrivals().length, 1, '只有那张未来日期的还停在待核对');
  } finally {
    f.store.close();
  }
});

test('核对入库时写库失败：整单回滚，没建出库存品、没占送货单号，单据还是待核对', () => {
  const f = fixture();
  try {
    const items = () => f.ops.repo.items().length;
    const before = items();
    const d = looseArrival(f, [{ item: { name: '虚构新独立规格', unit: '张' }, quantity: '10' }], 'ROLLBACK'),
      p = f.flow.preview(d.id, clerk);
    f.store.db.exec("CREATE TRIGGER fail_flow BEFORE INSERT ON stock_movements BEGIN SELECT RAISE(ABORT,'test write failure'); END");
    assert.throws(() => f.flow.confirm(d.id, { previewDigest: p.previewDigest, requestId: randomUUID(), acknowledged: true }, clerk), /test write failure/);
    f.store.db.exec('DROP TRIGGER fail_flow');
    assert.equal(items(), before);
    assert.equal(f.flow.get(d.id).status, 'draft');
    assert.equal(count(f.store.db, 'SELECT COUNT(*) n FROM flow_receipt_keys'), 0);
  } finally {
    f.store.close();
  }
});

test('撤销到货：料被领用了不够扣时拦下（超级管理员也一样）；撤销后已到货按有效单据重算、采购单换版本；同一送货单号能按实际重新登记，没撤销的仍拒重复', () => {
  const f = fixture();
  try {
    const a = f.receive('100', 'SUP-001').arrival;
    f.confirm('production', { productId: f.product.id, finishedStockId: f.finished.id, goodQuantity: '10', operator: '虚构员工', materials: [{ stockId: f.raw.id, issued: '60', returned: '0' }] });
    const reverse = (who: Actor) =>
      f.flow.reverse(a.id, { version: f.flow.get(a.id).version, reason: '虚构核错', acknowledged: true }, who);
    for (const who of [clerk, localAdmin()]) assert.throws(() => reverse(who), /撤销要扣回.*不够扣。这批库存已经被后面的业务用掉了/);
    // 领的料退回来以后能撤
    const it = f.ops.repo.items(true, f.raw.id)[0];
    f.ops.move(f.raw.id, { expectedVersion: it.version, requestId: randomUUID(), action: 'in', quantity: '60', date: '2026-10-20', notes: '虚构退料', acknowledged: true }, clerk);
    const version = f.current().version;
    reverse(clerk);
    assert.equal(f.current().lines[0].receivedQuantity, '0');
    const actual = one(f.store.db, tableRows.purchase_lines.pick({ received_units: true }), 'SELECT received_units FROM purchase_lines WHERE id=?', f.purchase.lines[0].id);
    assert.ok(actual);
    assert.equal(Number(actual.received_units), 0);
    assert.ok(f.current().version > version);
    assert.equal(f.receive('90', 'SUP-001').arrival.status, 'confirmed');
    assert.throws(() => f.arrive('SUP-001', '90'), /已收货，不能重复入库/);
  } finally {
    f.store.close();
  }
});
