// 合并导出订货单（server/documents/、server/operations/batches.ts）：订货单号按天取号、交错生成不重号、预览不占号、作废的文件拦下。
// 内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Store } from '../server/core/db.js';
import { AppError, count, one as oneRow, rows } from '../server/core/index.js';
import { OperationsService } from '../server/operations/service.js';
import { OrderBatchService } from '../server/operations/batches.js';
import { BusinessDocuments } from '../server/documents/service.js';
import { quantityUnits } from '../shared/core/quantity.js';
import { actor } from './assistant-fixture.js';

/** 几张合并、还没建批次的导出记下的订货单号；没有就直接判失败 */
function batchNo(e: { batchNumber?: string | null }) {
  assert.ok(e.batchNumber, '导出记录上没有订货单号');
  return e.batchNumber;
}

function setup() {
  const store = new Store(':memory:'),
    ops = new OperationsService(store),
    docs = new BusinessDocuments(store, async () => Buffer.from('虚构订货单文件')),
    batches = new OrderBatchService(store);
  const supplier = ops.saveSupplier({ name: '虚构春芳纸板厂', contact: '虚构联系人', phone: '000', address: '' }, actor);
  const other = ops.saveSupplier({ name: '虚构另一家纸板厂', contact: '', phone: '', address: '' }, actor);
  const item = ops.saveItem(
    { name: '虚构纸板A', kind: 'raw', unit: '张', length: 1000, width: 800, dimensionUnit: 'mm', specification: 'K=A B楞' },
    actor,
  );
  const purchase = (quantity: string, orderDate: string, supplierId = supplier.id) =>
    ops.savePurchase(
      { supplierId, orderDate, expectedDate: null, status: '待订货', notes: '', lines: [{ ...item, stockItemId: item.id, quantity, unitPrice: '1.2' }] },
      actor,
    );
  /** 把采购单改成已订货；skipBatch 时不自动建订货单（测试自己合并建） */
  const ordered = (ids: number[], options: { skipBatch?: boolean } = {}) => {
    for (const id of ids) {
      const cur = ops.repo.purchases(true, id)[0];
      ops.savePurchase({ ...cur, status: '已订货', version: cur.version }, actor, id, options);
    }
  };
  const stock = () => quantityUnits(ops.repo.items(true, item.id)[0].quantity);
  return { store, ops, docs, batches, supplier, other, item, purchase, ordered, stock };
}

/** 两张采购单合并导出的请求 */
const merged = (x: { id: number; version: number }, y: { id: number; version: number }, markOrdered = true) => ({
  kind: 'purchase' as const,
  id: x.id,
  format: 'xlsx' as const,
  markOrdered,
  expectedVersion: x.version,
  purchases: [
    { id: x.id, version: x.version },
    { id: y.id, version: y.version },
  ],
  requestId: randomUUID(),
});
const sequences = (store: Store) =>
  store.db
    .prepare('SELECT scope,last FROM number_sequences ORDER BY scope')
    .all()
    .map((r) => [String(r.scope), Number(r.last)]);

test('合并订货单用真实 Word/Excel 生成：几张采购单都有备注、分批交货也放得下，交货安排在条款区', async () => {
  const f = setup();
  const docs = new BusinessDocuments(f.store);
  const withNotes = (quantity: string, orderDate: string, notes: string) =>
    f.ops.savePurchase(
      {
        supplierId: f.supplier.id,
        orderDate,
        expectedDate: null,
        status: '待订货',
        notes,
        lines: [{ ...f.item, stockItemId: f.item.id, quantity, unitPrice: '1.2' }],
      },
      actor,
    );
  const a = withNotes('1000', '2026-11-01', '按原单位与尺寸供货，纸板不要受潮'),
    b = withNotes('800', '2026-11-02', '虚构第二张采购单的备注，送货前电话联系'),
    c = withNotes('600', '2026-11-03', '按原单位与尺寸供货，纸板不要受潮');
  const key = f.batches.draft([a.id, b.id, c.id], actor).rows[0].key;
  const purchases = [a, b, c].map((p) => ({ id: p.id, version: p.version }));
  const schedule = [
    { rowKey: key, quantity: '1000', dueDate: '2026-11-12' },
    { rowKey: key, quantity: '800', dueDate: '2026-11-15' },
  ];
  const preview = docs.batchPreview({ purchaseIds: purchases.map((p) => p.id), schedule });
  const field = (k: string) => {
    const found = preview.fields.find(([name]) => name === k);
    assert.ok(found, '预览上没有“' + k + '”这一栏');
    return found[1];
  };
  assert.equal(field('预计交货日期'), '分批，见交货安排');
  assert.match(field('交货安排'), /11-12 前 1000；11-15 前 800；其余 600/);
  assert.match(field('对应采购单'), /CG-.*、CG-.*、CG-/);
  assert.equal(preview.notes, '按原单位与尺寸供货，纸板不要受潮；虚构第二张采购单的备注，送货前电话联系', '相同的备注只写一次，连成一段');
  for (const format of ['docx', 'xlsx'] as const) {
    const file = await docs.generate(
      { kind: 'purchase', id: a.id, format, markOrdered: false, expectedVersion: a.version, purchases, schedule, requestId: randomUUID() },
      actor,
    );
    assert.ok(file.size > 1000, format + ' 生成了文件');
  }
});

test('合并订货单号按天取号：预览只看不占，生成了导出记录才占，没交付也占着，重新导出拿新号', async () => {
  const f = setup();
  const [a, b, c, d] = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'].map((day) => f.purchase('100', day));
  const preview = (x: { id: number }, y: { id: number }) => f.docs.batchPreview({ purchaseIds: [x.id, y.id] }).number;
  for (let i = 0; i < 3; i++) assert.match(preview(a, b), /^DG-\d{8}-01$/);
  assert.match(f.batches.nextNumber(), /^DG-\d{8}-01$/);
  assert.deepEqual(sequences(f.store), [], '预览三次不占号');
  const first = await f.docs.generate(merged(a, b), actor);
  assert.match(batchNo(first), /^DG-\d{8}-01$/);
  assert.match(first.filename, /^DG-\d{8}-01-采购订货单/);
  const scope = batchNo(first).slice(0, 11);
  assert.deepEqual(sequences(f.store), [[scope, 1]]);
  // 第一份还没交付，号也占着
  assert.match(preview(c, d), /-02$/);
  const second = await f.docs.generate(merged(c, d), actor);
  assert.match(batchNo(second), /-02$/);
  // 同一组采购单没交付又重新导出，拿新号
  const third = await f.docs.generate(merged(a, b), actor);
  assert.match(batchNo(third), /-03$/);
  assert.deepEqual(sequences(f.store), [[scope, 3]]);
  // 同一个请求再交一次原样返回，不多占号
  const request = merged(c, d, false);
  const fourth = await f.docs.generate(request, actor);
  assert.deepEqual(await f.docs.generate(request, actor), fourth);
  assert.match(batchNo(fourth), /-04$/);
  assert.deepEqual(sequences(f.store), [[scope, 4]]);
  assert.deepEqual(
    f.store.db
      .prepare('SELECT batch_number FROM document_exports ORDER BY batch_number')
      .all()
      .map((r) => String(r.batch_number).slice(-2)),
    ['01', '02', '03', '04'],
    '导出记录里的订货单号不重复',
  );
  // 交付完成建批次用的就是纸上印的那个号，批次指向这条导出记录
  f.docs.delivered(third.exportId, actor);
  f.docs.complete(third.exportId, third.sha256, actor);
  const batch = oneRow(f.store.db, rows.order_batches.pick({ number: true, export_id: true }), 'SELECT number,export_id FROM order_batches');
  assert.ok(batch, '交付完成后应建出订货批次');
  assert.deepEqual([batch.number, batch.export_id], [third.batchNumber, third.exportId]);
  assert.deepEqual(sequences(f.store), [[scope, 4]], '交付完成不再占号');
  assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  // 已经在订货单里的再导出，沿用原来的号，不占新号
  const current = (p: { id: number }) => {
    const now = f.ops.repo.purchases(true, p.id)[0];
    return { id: now.id, version: now.version };
  };
  const again = await f.docs.generate(merged(current(a), current(b), false), actor);
  assert.match(again.filename, new RegExp('^' + third.batchNumber + '-'));
  assert.equal(again.batchNumber, null);
  assert.deepEqual(sequences(f.store), [[scope, 4]]);
  // 只有一张采购单的订货单号就是采购单号，不走计数
  const single = f.purchase('100', '2026-11-05');
  const one = await f.docs.generate(
    { kind: 'purchase', id: single.id, format: 'xlsx', markOrdered: true, expectedVersion: single.version, requestId: randomUUID() },
    actor,
  );
  assert.equal(one.batchNumber, null);
  assert.deepEqual(sequences(f.store), [[scope, 4]]);
});

test('两份合并导出交错生成：先存下的占住订货单号，后存的被拒绝并提示重新导出，不会印出重号', async () => {
  const f = setup();
  const [a, b, c, d] = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'].map((day) => f.purchase('100', day));
  const printed: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const slow = new BusinessDocuments(f.store, async (form) => {
    printed.push(form.number);
    await gate;
    return Buffer.from('虚构订货单文件-慢');
  });
  const fast = new BusinessDocuments(f.store, async (form) => {
    printed.push(form.number);
    return Buffer.from('虚构订货单文件-快');
  });
  // 第一份排版卡住时第二份也开始排版：两份看到的都是 01
  const slowJob = slow.generate(merged(a, b), actor);
  const done = await fast.generate(merged(c, d), actor);
  release();
  await assert.rejects(
    slowJob,
    (e: unknown) => e instanceof AppError && e.status === 409 && /^生成文件期间，订货单号 DG-\d{8}-01 已被另一份订货单占用，请重新导出。$/.test(e.message),
  );
  assert.deepEqual(printed.map((n) => n.slice(-2)), ['01', '01']);
  assert.match(batchNo(done), /-01$/);
  assert.equal(count(f.store.db, 'SELECT COUNT(*) n FROM document_exports'), 1, '被拒绝的那份不留导出记录');
  assert.equal(count(f.store.db, "SELECT COUNT(*) n FROM business_audit WHERE action='generate'"), 1);
  assert.deepEqual(sequences(f.store), [[batchNo(done).slice(0, 11), 1]], '被拒绝的那次占号一起退回');
  // 重新导出拿到下一个号
  const retry = await f.docs.generate(merged(a, b), actor);
  assert.match(batchNo(retry), /-02$/);
  for (const file of [done, retry]) {
    f.docs.delivered(file.exportId, actor);
    f.docs.complete(file.exportId, file.sha256, actor);
  }
  assert.deepEqual(
    f.store.db
      .prepare('SELECT number FROM order_batches ORDER BY number')
      .all()
      .map((r) => String(r.number).slice(-2)),
    ['01', '02'],
  );
});

test('手工把几张采购单一起建订货批次也从同一个计数里占号；事务退回，号也退回', async () => {
  const f = setup();
  const [a, b, c, d, e, g] = ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'].map((day) =>
    f.purchase('100', day),
  );
  f.ordered([a.id, b.id, c.id, d.id], { skipBatch: true });
  const first = f.batches.create([a.id, b.id], actor);
  assert.match(first.number, /^DG-\d{8}-01$/);
  const scope = first.number.slice(0, 11);
  f.store.db.exec('SAVEPOINT fictional_outer');
  assert.match(f.batches.create([c.id, d.id], actor).number, /-02$/);
  f.store.db.exec('ROLLBACK TO fictional_outer; RELEASE fictional_outer');
  assert.equal(f.batches.batchIdOf(c.id), null);
  assert.deepEqual(sequences(f.store), [[scope, 1]]);
  assert.match(f.batches.create([c.id, d.id], actor).number, /-02$/, '退回的号下次还是它');
  // 手工建的和导出的共用一个计数
  const file = await f.docs.generate(merged(e, g), actor);
  assert.match(batchNo(file), /-03$/);
  assert.match(f.batches.nextNumber(), /-04$/);
  // 别的日期各算各的，预览不占
  assert.equal(f.batches.nextNumber('2026-01-02'), 'DG-20260102-01');
  assert.deepEqual(sequences(f.store), [[scope, 3]]);
  // 占号时发现不是预览看到的那个：拒绝，也不多占
  assert.throws(
    () => f.batches.reserveNumber(scope + '-09'),
    (e: unknown) => e instanceof AppError && e.status === 409 && /已被另一份订货单占用/.test(e.message),
  );
  assert.deepEqual(sequences(f.store), [[scope, 3]]);
});

test('预览 Word 排版只排版不落库：订货单号、导出记录、审计、采购单都不变，随后正式导出拿到的就是预览上的号', async () => {
  const f = setup();
  const [a, b] = ['2026-11-01', '2026-11-02'].map((day) => f.purchase('100', day));
  const printed: string[] = [];
  const docs = new BusinessDocuments(f.store, async (form, format) => {
    printed.push(form.number + ' ' + format);
    return Buffer.from('虚构Word预览-' + form.number);
  });
  const snapshot = () => ({
    sequences: sequences(f.store),
    exports: count(f.store.db, 'SELECT COUNT(*) n FROM document_exports'),
    audits: count(f.store.db, 'SELECT COUNT(*) n FROM business_audit'),
    batches: count(f.store.db, 'SELECT COUNT(*) n FROM order_batches'),
    purchases: f.ops.repo.purchases(true, [a.id, b.id]).map((p) => [p.id, p.version, p.businessStatus]),
  });
  const before = snapshot();
  assert.deepEqual(before.sequences, []);
  const request = { kind: 'purchase' as const, purchaseIds: [a.id, b.id] };
  // 窗口里的“预览”看到的号
  const shown = docs.batchPreview({ purchaseIds: [a.id, b.id] }).number;
  assert.match(shown, /^DG-\d{8}-01$/);
  for (let i = 0; i < 2; i++) assert.equal((await docs.previewFile(request, actor)).toString(), '虚构Word预览-' + shown);
  assert.deepEqual(printed, [shown + ' docx', shown + ' docx'], 'Word 预览上印的是下一个号，和窗口里的预览一致');
  assert.deepEqual(snapshot(), before, '号、导出记录、审计、批次、采购单都没动');
  // 权限和正式导出一样；参数多了少了都拒绝
  await assert.rejects(() => docs.previewFile(request, null), (e: unknown) => e instanceof AppError && e.status === 401);
  await assert.rejects(() => docs.previewFile(request, { ...actor, permissions: [] }), (e: unknown) => e instanceof AppError && e.status === 403);
  await assert.rejects(() => docs.previewFile({ ...request, requestId: randomUUID() }, actor));
  assert.deepEqual(snapshot(), before);
  // 随后正式导出，占到的就是预览上的那个号
  const file = await docs.generate(merged(a, b), actor);
  assert.equal(file.batchNumber, shown);
  assert.equal(printed.at(-1), shown + ' xlsx');
  assert.deepEqual(sequences(f.store), [[shown.slice(0, 11), 1]]);
});

test('同一组采购单先后导出两份订货单：先完成的建批次，后完成的被拒绝、不记完成，下载也拦；同一份重复点完成照常', async () => {
  const f = setup();
  const [a, b] = ['2026-11-01', '2026-11-02'].map((day) => f.purchase('100', day));
  const current = (p: { id: number }) => {
    const now = f.ops.repo.purchases(true, p.id)[0];
    return { id: now.id, version: now.version };
  };
  const voided = (who: string, number: string) => (e: unknown) =>
    e instanceof AppError && e.status === 409 && e.message === who + '已按订货单 ' + number + ' 订货，这份文件作废，请不要发给供应商。';
  const completed = (id: string) => {
    const row = oneRow(f.store.db, rows.document_exports.pick({ completed_at: true }), 'SELECT completed_at FROM document_exports WHERE id=?', id);
    assert.ok(row, '没有这条导出记录');
    return row.completed_at;
  };
  const audits = () => count(f.store.db, "SELECT COUNT(*) n FROM business_audit WHERE action='download-complete'");
  // 两份都在采购单还没订货时生成（两个人先后点了导出），纸上分别是 01、02；另有人单独导出了其中一张
  const first = await f.docs.generate(merged(a, b), actor);
  const second = await f.docs.generate(merged(a, b), actor);
  const single = await f.docs.generate(
    { kind: 'purchase', id: a.id, format: 'xlsx', markOrdered: true, expectedVersion: a.version, requestId: randomUUID() },
    actor,
  );
  assert.match(batchNo(first), /-01$/);
  assert.match(batchNo(second), /-02$/);
  // 两份都下载了，后生成的先交付完成
  f.docs.delivered(first.exportId, actor);
  f.docs.delivered(second.exportId, actor);
  const done = f.docs.complete(second.exportId, second.sha256, actor);
  assert.equal(done.deliveryStatus, 'completed');
  const ordered = [current(a), current(b)];
  // 先生成的那份再点完成：拒绝，不记完成，不另建批次，采购单不动
  assert.throws(() => f.docs.complete(first.exportId, first.sha256, actor), voided('这几张采购单', batchNo(second)));
  assert.equal(completed(first.exportId), null, '导出记录没有被标成完成');
  assert.equal(f.docs.status(first.exportId, actor).deliveryStatus, 'delivered');
  assert.equal(f.docs.status(first.exportId, actor).message, '这几张采购单已按订货单 ' + second.batchNumber + ' 订货，这份文件作废，请不要发给供应商。');
  assert.deepEqual(
    f.store.db.prepare('SELECT number,export_id FROM order_batches').all().map((r) => [r.number, r.export_id]),
    [[second.batchNumber, second.exportId]],
    '批次表里只有一个号',
  );
  assert.deepEqual([current(a), current(b)], ordered);
  assert.equal(audits(), 1);
  // 下载这一步也拦：作废的文件不再给出去
  assert.throws(() => f.docs.file(first.exportId, actor), voided('这几张采购单', batchNo(second)));
  // 单独导出的那一张同样作废（还没下载就拦）
  assert.throws(() => f.docs.file(single.exportId, actor), voided('这张采购单', batchNo(second)));
  assert.throws(() => f.docs.complete(single.exportId, single.sha256, actor), voided('这张采购单', batchNo(second)));
  assert.equal(completed(single.exportId), null);
  // 批次服务也守着：带着别的号来建，不悄悄沿用已有批次
  assert.throws(() => f.batches.create([a.id, b.id], actor, { number: batchNo(first) }), voided('这几张采购单', batchNo(second)));
  // 已完成的那份：重复点完成原样返回，重新下载照常
  assert.deepEqual(f.docs.complete(second.exportId, second.sha256, actor), done);
  assert.equal(f.docs.file(second.exportId, actor).buffer.length, second.size);
  assert.equal(audits(), 1);
  // 按已有的订货单整份重新导出并交付：号对得上，照常完成，不另建批次
  const again = await f.docs.generate(merged(current(a), current(b)), actor);
  assert.equal(again.batchNumber, null);
  assert.match(again.filename, new RegExp('^' + second.batchNumber + '-'));
  f.docs.delivered(again.exportId, actor);
  assert.equal(f.docs.complete(again.exportId, again.sha256, actor).deliveryStatus, 'completed');
  assert.equal(count(f.store.db, 'SELECT COUNT(*) n FROM order_batches'), 1);
  assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
});
