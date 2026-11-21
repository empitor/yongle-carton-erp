// 单据导出的服务（server/documents/）：生成、交付、确认的状态，幂等，归属账号，过期，单据删了或取消以后。内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { BusinessDocuments } from '../server/documents/service.js';
import { EXPORT_FILE_KEEP_DAYS, purgeExportFiles } from '../server/documents/export-records.js';
import { renderBusinessForm } from '../server/documents/render.js';
import { DatabaseMaintenanceService } from '../server/business/database-maintenance.js';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { z } from 'zod';
import { AppError } from '../server/core/errors.js';
import { count } from '../server/core/sql.js';
import { setup } from './document-fixture.js';
import { actor } from './actor-fixture.js';

/** 抛的是给人看的业务错误：状态码对、说明对（文字或规则） */
const failsWith = (status: number, message: string | RegExp) => (e: unknown) =>
  e instanceof AppError && e.status === status && (typeof message === 'string' ? e.message === message : message.test(e.message));

test('导出交付的状态：已生成 → 已下载 → 交付完成；没下载或校验不对不能确认，重复确认原样返回、不重复订货', async () => {
  const f = setup();
  try {
    const conflict = (pattern: RegExp) => failsWith(409, pattern);
    const audits = (action: string) => count(f.store.db, 'SELECT COUNT(*) n FROM business_audit WHERE action=?', action);
    const file = await f.docs.generate(f.exp('purchase', f.purchase.id), actor);
    assert.equal(file.deliveryStatus, 'ready');
    assert.equal(file.message, '文件已生成；下载交付完成后才标记已订货。');
    assert.equal(audits('generate'), 1);
    assert.throws(() => f.docs.complete(file.exportId, file.sha256, actor), conflict(/文件尚未完整交付或校验失败，单据状态未修改。/));
    // 任何状态都能下载，下载本身不改状态；响应发完才记“已下载”
    assert.equal(f.docs.file(file.exportId, actor).buffer.length, file.size);
    assert.equal(f.docs.status(file.exportId, actor).deliveryStatus, 'ready');
    f.docs.delivered(file.exportId, actor);
    const delivered = f.docs.status(file.exportId, actor);
    assert.equal(delivered.deliveryStatus, 'delivered');
    assert.ok(delivered.deliveredAt);
    assert.equal(delivered.completedAt, null);
    f.docs.delivered(file.exportId, actor);
    assert.equal(f.docs.status(file.exportId, actor).deliveredAt, delivered.deliveredAt, '重复下载不改已下载的时间');
    assert.throws(() => f.docs.complete(file.exportId, '0'.repeat(64), actor), conflict(/校验失败/));
    assert.equal(f.current().businessStatus, '待订货');
    assert.equal(count(f.store.db, 'SELECT COUNT(*) n FROM order_batches'), 0);
    const done = f.docs.complete(file.exportId, file.sha256, actor);
    assert.equal(done.deliveryStatus, 'completed');
    assert.ok(done.completedAt);
    assert.equal(done.deliveredAt, delivered.deliveredAt);
    assert.equal(done.businessStatus, '已订货');
    assert.equal(done.message, '文件结果及当前业务状态已核验。');
    const version = f.current().version;
    assert.deepEqual(f.docs.complete(file.exportId, file.sha256, actor), done, '重复确认原样返回');
    assert.equal(f.current().version, version, '不再改采购单');
    // 已订货以后再导出一份 Excel 交付：不再改采购单，也不动库存
    const again = await f.docs.generate(f.exp('purchase', f.purchase.id, { format: 'xlsx' }), actor);
    f.docs.delivered(again.exportId, actor);
    f.docs.complete(again.exportId, again.sha256, actor);
    assert.equal(f.current().version, version);
    assert.deepEqual([f.ops.balance(f.raw.id), f.current().lines[0].receivedQuantity], [0, '0']);
    assert.equal(audits('download-complete'), 2, '原单和再导出的 Excel 各一次');
    const batches = f.store.db.prepare('SELECT number,export_id FROM order_batches').all();
    assert.equal(batches.length, 1, '订货批次只有一个');
    assert.deepEqual([batches[0].number, batches[0].export_id], [f.current().number, file.exportId]);
    // 交付完成后照样能再下载，状态不变
    assert.equal(f.docs.file(file.exportId, actor).buffer.length, file.size);
    f.docs.delivered(file.exportId, actor);
    assert.deepEqual(f.docs.status(file.exportId, actor), done);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);

    // 送货单导出出库：交付确认时出库一次，重复确认不再出库
    const draft = f.saveDelivery(),
      moves = () => count(f.store.db, 'SELECT COUNT(*) n FROM stock_movements'),
      before = moves();
    const out = await f.docs.generate(f.exp('delivery', draft.id, { markShipped: true }), actor);
    assert.equal(out.deliveryStatus, 'ready');
    assert.equal(f.store.db.prepare('SELECT ship_date FROM document_exports WHERE id=?').get(out.exportId)?.ship_date, out.shipDate);
    assert.match(out.shipDate ?? '', /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(f.flow.get(draft.id).status, 'draft');
    assert.throws(() => f.docs.complete(out.exportId, out.sha256, actor), conflict(/尚未完整交付/));
    assert.equal(moves(), before, '没交付不出库');
    f.docs.delivered(out.exportId, actor);
    const shipped = f.docs.complete(out.exportId, out.sha256, actor);
    assert.equal(shipped.deliveryStatus, 'completed');
    assert.equal(f.flow.get(draft.id).status, 'confirmed');
    assert.equal(moves(), before + 1);
    assert.deepEqual(f.docs.complete(out.exportId, out.sha256, actor), shipped);
    assert.equal(moves(), before + 1, '重复确认不再出库');
    assert.equal(audits('download-complete'), 3);
  } finally {
    f.store.close();
  }
});

test('生成失败、生成后采购单改了、采购单已取消，都不误改订货状态', async () => {
  const f = setup();
  try {
    const fail = new BusinessDocuments(f.store, async () => {
      throw new Error('虚构导出失败');
    });
    await assert.rejects(() => fail.generate(f.exp('purchase', f.purchase.id), actor), /导出失败/);
    assert.equal(f.current().businessStatus, '待订货');
    const file = await f.docs.generate(f.exp('purchase', f.purchase.id), actor);
    f.flow.stock.savePurchase(
      { ...f.current(), status: '待订货', notes: '虚构并发修改', version: f.current().version },
      actor,
      f.purchase.id,
    );
    f.docs.delivered(file.exportId, actor);
    assert.throws(() => f.docs.complete(file.exportId, file.sha256, actor), /采购单已变化/);
    assert.equal(f.current().businessStatus, '待订货');
    const cancelled = f.flow.stock.savePurchase(
      { ...f.current(), status: '已取消', version: f.current().version },
      actor,
      f.purchase.id,
    );
    await assert.rejects(() => f.docs.generate(f.exp('purchase', f.purchase.id), actor), /已取消/);
    await f.docs.generate(f.exp('purchase', f.purchase.id, { markOrdered: false }), actor);
    assert.equal(f.current().businessStatus, '已取消');
    assert.equal(cancelled.businessStatus, '已取消');
  } finally {
    f.store.close();
  }
});

test('同一个导出请求再交一次原样返回、不重新排版；同编号换内容拒绝；别的账号查不到也下载不了', async () => {
  const f = setup();
  try {
    let rendered = 0;
    const docs = new BusinessDocuments(f.store, async (form, format) => {
      rendered++;
      return renderBusinessForm(form, format);
    });
    const request = f.exp('purchase', f.purchase.id, { markOrdered: false });
    const first = await docs.generate(request, actor),
      second = await docs.generate(request, actor);
    assert.deepEqual(second, first);
    assert.equal(rendered, 1, '第二次不重新排版');
    await assert.rejects(
      () => docs.generate({ ...request, format: 'xlsx' }, actor),
      failsWith(409, '导出请求编号已用于其他内容。'),
    );
    const other = { ...actor, id: 'fictional-other-user', name: '虚构另一账号' };
    // 摘要里带账号：别人拿同一个请求编号来也算换了内容
    await assert.rejects(() => docs.generate(request, other), /导出请求编号已用于其他内容/);
    assert.equal(rendered, 1);
    assert.equal(count(f.store.db, 'SELECT COUNT(*) n FROM document_exports'), 1);
    for (const call of [
      () => docs.status(first.exportId, other),
      () => docs.file(first.exportId, other),
      () => docs.delivered(first.exportId, other),
      () => docs.complete(first.exportId, first.sha256, other),
    ])
      assert.throws(call, failsWith(403, '导出文件不属于当前账号。'));
    assert.equal(docs.status(first.exportId, actor).deliveredAt, null, '别人碰不到交付状态');
    assert.throws(
      () => docs.status(randomUUID(), actor),
      failsWith(404, '导出文件不存在。'),
    );
  } finally {
    f.store.close();
  }
});

test('生成期间单据改了版本：拒绝交付旧文件，不改订货状态', async () => {
  const f = setup();
  try {
    const concurrent = new BusinessDocuments(f.store, async (form, format) => {
      f.flow.stock.savePurchase(
        {
          ...f.current(),
          version: f.current().version,
          status: '待订货',
          notes: '生成期间发生真实版本变化',
        },
        actor,
        f.purchase.id,
      );
      return renderBusinessForm(form, format);
    });
    await assert.rejects(
      () => concurrent.generate(f.exp('purchase', f.purchase.id), actor),
      /文件生成期间单据已更新/,
    );
    assert.equal(f.current().businessStatus, '待订货');
    assert.equal(count(f.store.db, 'SELECT COUNT(*) n FROM document_exports'), 0);
  } finally {
    f.store.close();
  }
});

test('导出记录单独存表：文件是原始字节、摘要对得上，对外字段名不变，防重复表里不放导出', async () => {
  const f = setup();
  try {
    const file = await f.docs.generate(f.exp('purchase', f.purchase.id, { markOrdered: false }), actor);
    const row = f.store.db.prepare('SELECT * FROM document_exports WHERE id=?').get(file.exportId);
    assert.ok(row);
    assert.ok(row.bytes instanceof Uint8Array, '文件存成原始字节');
    const bytes = Buffer.from(row.bytes);
    assert.equal(bytes.length, file.size);
    assert.equal(row.size, file.size);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
    assert.equal(row.sha256, file.sha256);
    assert.deepEqual(f.docs.file(file.exportId, actor).buffer, bytes);
    assert.deepEqual(
      [row.record_kind, row.record_id, row.actor_id, row.format, row.filename, row.template_id, row.template_revision],
      ['purchase', f.purchase.id, actor.id, 'docx', file.filename, file.templateId, file.templateRevision],
    );
    assert.deepEqual([row.batch_number, row.ship_date, row.delivered_at, row.completed_at], [null, null, null, null]);
    assert.equal(row.created_at, file.createdAt);
    assert.deepEqual(JSON.parse(String(row.template_snapshot)), file.templateSnapshot);
    // 已经有列的字段不在 options 里再存一份
    assert.deepEqual(Object.keys(z.record(z.string(), z.unknown()).parse(JSON.parse(String(row.options)))).sort(), [
      'draft',
      'expectedVersion',
      'markOrdered',
      'markShipped',
      'members',
      'scheduleEntries',
      'statusBefore',
    ]);
    assert.equal(count(f.store.db, "SELECT COUNT(*) n FROM operation_requests WHERE kind='document-export'"), 0);
    // 前端和助手在用的字段一个都不能少，文件内容和账号不往外给
    assert.deepEqual(Object.keys(file).sort(), [
      'batchNumber',
      'businessStatus',
      'completedAt',
      'createdAt',
      'deliveredAt',
      'deliveryStatus',
      'draft',
      'expectedVersion',
      'exportId',
      'fileExpired',
      'filename',
      'format',
      'id',
      'kind',
      'markOrdered',
      'markShipped',
      'members',
      'message',
      'requestId',
      'scheduleEntries',
      'sha256',
      'shipDate',
      'size',
      'statusBefore',
      'templateId',
      'templateRevision',
      'templateSnapshot',
      'url',
      'verified',
    ]);
    assert.deepEqual(
      [file.kind, file.id, file.format, file.requestId, file.url, file.deliveryStatus, file.batchNumber, file.shipDate],
      ['purchase', f.purchase.id, 'docx', file.exportId, '/api/documents/' + file.exportId + '/file', 'ready', null, null],
    );
    assert.deepEqual(file.members, [{ id: f.purchase.id, version: f.current().version }]);
    // 送货单的导出记录没有采购才有的那几项
    const draft = f.saveDelivery(),
      delivery = await f.docs.generate(f.exp('delivery', draft.id), actor);
    for (const key of ['batchNumber', 'members', 'scheduleEntries']) assert.equal(key in delivery, false, key);
    assert.deepEqual([delivery.kind, delivery.id, delivery.shipDate, delivery.draft], ['delivery', draft.id, null, true]);
  } finally {
    f.store.close();
  }
});

test('导出文件过了保存期只清内容：记录和状态还在，再下载提示重新导出；没过期的不受影响', async () => {
  const f = setup();
  try {
    const DAY = 86400_000;
    const old = await f.docs.generate(f.exp('purchase', f.purchase.id, { markOrdered: false }), actor),
      fresh = await f.docs.generate(f.exp('purchase', f.purchase.id, { markOrdered: false, format: 'xlsx' }), actor);
    assert.equal(purgeExportFiles(f.store), 0, '刚导出的不清');
    assert.equal(
      purgeExportFiles(f.store, EXPORT_FILE_KEEP_DAYS, new Date(Date.now() + (EXPORT_FILE_KEEP_DAYS - 1) * DAY)),
      0,
      '差一天到期也不清',
    );
    f.store.db
      .prepare('UPDATE document_exports SET created_at=? WHERE id=?')
      .run(new Date(Date.now() - (EXPORT_FILE_KEEP_DAYS + 1) * DAY).toISOString(), old.exportId);
    assert.equal(purgeExportFiles(f.store), 1);
    assert.equal(purgeExportFiles(f.store), 0, '清过的不再算');
    const row = f.store.db.prepare('SELECT bytes,sha256,size,template_snapshot FROM document_exports WHERE id=?').get(old.exportId);
    assert.ok(row);
    assert.equal(row.bytes, null);
    assert.deepEqual([row.sha256, row.size], [old.sha256, old.size], '摘要和大小留着');
    assert.deepEqual(JSON.parse(String(row.template_snapshot)), old.templateSnapshot, '模板快照留着');
    assert.throws(
      () => f.docs.file(old.exportId, actor),
      failsWith(410, '文件已过期（导出文件只保留 ' + EXPORT_FILE_KEEP_DAYS + ' 天），请重新导出。'),
    );
    const status = f.docs.status(old.exportId, actor);
    assert.deepEqual([status.deliveryStatus, status.sha256, status.filename], ['ready', old.sha256, old.filename], '查状态照常');
    // 查状态就能知道文件还在不在（助手据此换新的请求号重新导出）
    assert.equal(status.fileExpired, true);
    assert.equal(f.docs.status(fresh.exportId, actor).fileExpired, false);
    assert.equal(old.fileExpired, false, '刚导出时文件在');
    assert.equal(f.docs.file(fresh.exportId, actor).buffer.length, fresh.size, '没过期的照常下载');
    assert.equal(count(f.store.db, 'SELECT COUNT(*) n FROM document_exports'), 2, '导出记录本身不删');
  } finally {
    f.store.close();
  }
});

test('采购单删掉以后导出记录还在、文件还能下载；它的订货批次一起删，不留悬空引用', async () => {
  const f = setup();
  try {
    const file = await f.docs.generate(f.exp('purchase', f.purchase.id), actor);
    f.docs.delivered(file.exportId, actor);
    f.docs.complete(file.exportId, file.sha256, actor);
    assert.equal(f.store.db.prepare('SELECT export_id FROM order_batches').get()?.export_id, file.exportId);
    const owner = localAdministratorActor({ ...actor, role: 'super_admin' }),
      service = new DatabaseMaintenanceService(f.store),
      selection = { module: 'purchases', items: [{ id: f.purchase.id, version: f.current().version }] },
      plan = service.preview(selection, owner);
    assert.equal(plan.impact.some((r) => r.table === 'document_exports'), false, '导出记录不在连带范围里');
    service.delete({ ...selection, requestId: randomUUID(), deletionDigest: plan.digest }, owner, 'test-binding');
    assert.equal(f.flow.views.purchases(true).length, 0);
    assert.equal(count(f.store.db, 'SELECT COUNT(*) n FROM order_batches'), 0);
    assert.equal(count(f.store.db, 'SELECT COUNT(*) n FROM document_exports'), 1);
    assert.equal(f.docs.file(file.exportId, actor).buffer.length, file.size);
    // 查状态要读当前单据，单据没了就报不存在（一直是这样）
    assert.throws(() => f.docs.status(file.exportId, actor), /采购单不存在/);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});

test('送货单导出以后取消了：导出记录照样查得到，状态是已取消，不报“不能导出”', async () => {
  const f = setup();
  try {
    const draft = f.saveDelivery();
    const file = await f.docs.generate(f.exp('delivery', draft.id), actor);
    f.flow.cancel(draft.id, { version: f.flow.get(draft.id).version, reason: '虚构客户改期', acknowledged: true }, actor);
    const status = f.docs.status(file.exportId, actor);
    assert.equal(status.businessStatus, 'cancelled');
    assert.equal(status.deliveryStatus, 'ready');
    // 取消的送货单仍不能再导出成有效送货单
    assert.throws(() => f.docs.form('delivery', draft.id), /取消或冲销的送货单不能导出/);
  } finally {
    f.store.close();
  }
});
