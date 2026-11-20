// 已生效单据的说明编辑（server/flow/document-info.ts）：到货改备注、到货时间，送货改备注、地址联系人、实际时间，
// 完工改批次备注、操作人；不出替代单，库存、流水、金额、财务指纹和财务事件都不动。内存库、虚构数据。
import { pageActor } from './actor-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { flowFixture, clerk } from './flow-fixture.js';
import { correctionFixture, archiveDoc } from './receive-fixture.js';
import { updateDocumentInfo } from '../server/flow/document-info.js';
import { viewOfKind } from '../server/flow/read.js';
import { stockItemBatches } from '../server/flow/stock-batches.js';
import { sourceHash } from '../server/finance/source-fingerprint.js';
import { flowDocumentContent, flowDocumentOfView } from '../shared/business/flow-document.js';
import { FinanceSettings } from '../server/finance/settings.js';
import { FinanceEvents } from '../server/finance/events.js';
import { financePermissions } from '../shared/core/accounts.js';
import { startHttp } from './http-fixture.js';
import { z } from 'zod';
import { AppError } from '../server/core/errors.js';

/** 抛的是给人看的业务错误：状态码对；给了规则的，说明也要对得上 */
const failsWith = (status: number, pattern?: RegExp) => (e: unknown) =>
  e instanceof AppError && e.status === status && (!pattern || pattern.test(e.message));
/** 说明编辑记的审计内容：改前、改后 */
const infoAudit = z.looseObject({ before: z.record(z.string(), z.unknown()), after: z.record(z.string(), z.unknown()) });

/** 一张已入库到货单（correctionFixture）、一张已出库送货单、一张已入库完工单（带批次备注） */
function fixture() {
  const f = flowFixture();
  const c = correctionFixture(f, clerk);
  f.stockIn('100');
  const order = f.order(100);
  const delivery = f.confirm('delivery', { customerId: f.customer.id, address: '虚构旧地址', lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: f.finished.id, quantity: '10' }] });
  const production = f.confirm('production', {
    productId: f.product.id,
    finishedStockId: f.finished.id,
    goodQuantity: '20',
    operator: '虚构机长',
    notes: '虚构：用的国产纸',
    materials: [{ stockId: f.raw.id, issued: '5', returned: '0' }],
  });
  const edit = (id: number, input: Record<string, unknown>, who: Parameters<typeof updateDocumentInfo>[3] = clerk) =>
    updateDocumentInfo(f.store, id, { expectedVersion: f.flow.get(id).version, ...input }, who);
  const audits = (id: number) =>
    f.store.db
      .prepare("SELECT document FROM business_audit WHERE action='edit-info' AND record_id=? ORDER BY id")
      .all(id)
      .map((r) => infoAudit.parse(JSON.parse(String(r.document))));
  const movements = () => f.store.db.prepare('SELECT * FROM stock_movements ORDER BY rowid').all();
  return { ...f, ...c, order, delivery, production, edit, audits, movements };
}

test('到货单：只换备注和到货时间，不出替代单，库存、流水、已到货、金额和财务指纹都不变；版本加一、记改前改后；同样内容再交原样返回', () => {
  const f = fixture();
  try {
    const before = f.flow.get(f.arrivalId, 'arrival'),
      moves = f.movements(),
      fingerprint = sourceHash({ kind: 'arrival', status: 'confirmed', date: before.date }, flowDocumentContent(flowDocumentOfView(before)));
    const r = f.edit(f.arrivalId, { notes: '  虚构：司机说下午才到  ', actualTime: '15:30' }),
      edited = viewOfKind(r, 'arrival');
    assert.deepEqual([r.changed, edited.notes, edited.actualTime, edited.number, edited.version], [true, '虚构：司机说下午才到', '15:30', before.number, before.version + 1]);
    const after = f.flow.get(f.arrivalId, 'arrival');
    const { notes: _n1, actualTime: _t1, version: _v1, updatedAt: _u1, ...restBefore } = before,
      { notes: _n2, actualTime: _t2, version: _v2, updatedAt: _u2, ...restAfter } = after;
    assert.deepEqual(restAfter, restBefore, '别的字段一个不变');
    assert.deepEqual(f.movements(), moves);
    assert.equal(f.current().lines[0].receivedQuantity, '1000');
    assert.equal(sourceHash({ kind: 'arrival', status: 'confirmed', date: after.date }, flowDocumentContent(flowDocumentOfView(after))), fingerprint, '财务的来源指纹不变');
    assert.deepEqual(f.audits(f.arrivalId).map((a) => [a.before, a.after]), [[{ notes: '', actualTime: null }, { notes: '虚构：司机说下午才到', actualTime: '15:30' }]]);
    const again = updateDocumentInfo(f.store, f.arrivalId, { notes: '虚构：司机说下午才到', actualTime: '15:30', expectedVersion: before.version }, clerk);
    assert.deepEqual([again.changed, again.version], [false, after.version]);
    assert.equal(f.audits(f.arrivalId).length, 1);
    assert.equal(viewOfKind(f.edit(f.arrivalId, { actualTime: null }), 'arrival').actualTime, null, '清空到货时间');
  } finally {
    f.store.close();
  }
});

test('送货单：改地址、联系人、联系方式、实际时间、备注，只传要改的几项；库存和订单已发不动', () => {
  const f = fixture();
  try {
    const moves = f.movements();
    const r = viewOfKind(f.edit(f.delivery.id, { address: '虚构新地址', contact: '虚构收货人', phone: '000-0000', actualTime: '09:10' }), 'delivery');
    assert.deepEqual([r.address, r.contact, r.phone, r.actualTime, r.notes], ['虚构新地址', '虚构收货人', '000-0000', '09:10', '']);
    assert.equal(r.status, 'confirmed');
    assert.deepEqual(f.movements(), moves);
    assert.equal(f.store.order(f.order.id, true)?.lines[0].shippedQuantity, 10);
    assert.deepEqual(f.audits(f.delivery.id)[0].before, { address: '虚构旧地址', contact: '', phone: '', actualTime: null });
    assert.throws(() => f.edit(f.delivery.id, { operator: '虚构' }), failsWith(422, /送货单没有“操作人”这一项可改/));
    assert.throws(() => f.edit(f.delivery.id, {}), /请写要改的内容/);
  } finally {
    f.store.close();
  }
});

test('完工单：改批次备注、操作人，批次里读到新备注；改了以后财务事件不新增、不算“来源改过”', () => {
  const f = fixture();
  const maker = pageActor({ id: 'maker', name: '虚构财务', role: 'super_admin' as const, permissions: [...financePermissions, 'business:edit'] });
  new FinanceSettings(f.store).enable(maker, { period: '2026-10', taxpayer: 'general', version: 1, requestId: 'enable', rows: [] });
  const events = new FinanceEvents(f.store);
  const sync = () => {
    for (let i = 0; i < 10 && events.sync(maker, { requestId: randomUUID() }).remaining; i++);
  };
  const snapshot = () =>
    f.store.db.prepare("SELECT id,status,version,source_hash FROM fin_events WHERE source_kind='production' AND source_id=? ORDER BY id").all(String(f.production.id));
  try {
    sync();
    const first = snapshot();
    const r = viewOfKind(f.edit(f.production.id, { notes: '虚构：这批压线浅', operator: '虚构二号机长' }), 'production');
    assert.deepEqual([r.notes, r.operator], ['虚构：这批压线浅', '虚构二号机长']);
    assert.equal(stockItemBatches(f.store, f.finished.id).open.find((b) => b.documentId === f.production.id)?.notes, '虚构：这批压线浅');
    sync();
    assert.deepEqual(snapshot(), first, '财务事件原样');
    assert.equal(f.edit(f.production.id, { notes: '' }).notes, '', '能清空');
    assert.throws(() => f.edit(f.production.id, { operator: '' }), /请填写实际操作人员/);
    assert.throws(() => f.edit(f.production.id, { address: '虚构' }), /完工单没有“地址”这一项可改/);
  } finally {
    f.store.close();
  }
});

test('拦下：版本不对、时间写错、备注超长；待入库的、已被更正替代的、已撤销的、已归档的、生产任务；没登录、没权限', () => {
  const f = fixture();
  try {
    assert.throws(() => f.edit(f.arrivalId, { notes: '虚构', expectedVersion: 99 }), failsWith(409, /已变化.*刷新/));
    assert.throws(() => f.edit(f.arrivalId, { actualTime: '25:00' }), /HH:mm/);
    assert.throws(() => f.edit(f.arrivalId, { notes: '虚'.repeat(2001) }), /2000/);
    assert.throws(() => f.edit(f.arrivalId, { notes: '虚构' }, null), failsWith(401));
    assert.throws(() => f.edit(f.arrivalId, { notes: '虚构' }, { ...clerk, permissions: [] }), failsWith(403));
    const original = f.arrivalId;
    f.correct(original, [{ index: 0, quantity: '900' }]);
    assert.throws(() => f.edit(original, { notes: '虚构' }), /已被更正替代/);
    const waiting = f.receive('10', '虚构待入库', { pending: true }).arrival;
    assert.throws(() => f.edit(waiting.id, { notes: '虚构' }), failsWith(409, /还是待入库，请在编辑窗里整张改/));
    f.flow.reverse(f.delivery.id, { version: f.flow.get(f.delivery.id).version, reason: '虚构发错', acknowledged: true }, clerk);
    assert.throws(() => f.edit(f.delivery.id, { notes: '虚构' }), /已撤销/);
    archiveDoc(f.flow, f.production.id, false, clerk, f.flow.get(f.production.id).version);
    assert.throws(() => f.edit(f.production.id, { notes: '虚构' }), /已归档，请先恢复再改/);
    const task = f.task({ productId: f.product.id, quantity: '10', unit: '只', orderIds: [f.order.id], plannedDate: '2026-10-27' });
    assert.throws(() => f.edit(task.id, { notes: '虚构' }), /生产任务请用“编辑”改/);
    assert.throws(() => updateDocumentInfo(f.store, 99999, { notes: '虚构', expectedVersion: 1 }, clerk), failsWith(404));
  } finally {
    f.store.close();
  }
});

test('编辑接口 /flow/:id/info 要登录和页面凭证，改完读到新内容；批次接口要登录，原材料 400、不存在 404', async () => {
  const f = fixture(),
    h = await startHttp(f.store);
  try {
    const body = () => ({ notes: '虚构：接口改的', expectedVersion: f.flow.get(f.production.id).version });
    const path = '/flow/' + f.production.id + '/info';
    assert.equal((await h.send(path, body())).status, 401);
    assert.equal((await h.send(path, body(), h.cookie, { csrf: null })).status, 403);
    const ok = await h.send(path, body(), h.cookie);
    assert.equal(ok.status, 200);
    assert.equal(z.looseObject({ notes: z.string() }).parse(await ok.json()).notes, '虚构：接口改的');
    assert.equal((await h.send('/flow/stock-batches/' + f.finished.id)).status, 401);
    for (const [batchPath, status] of [
      ['/flow/stock-batches/' + f.finished.id + '?depleted=all', 200],
      ['/flow/stock-batches/' + f.raw.id, 400],
      ['/flow/stock-batches/99999', 404],
    ] as const)
      assert.equal((await h.send(batchPath, undefined, h.cookie)).status, status, batchPath);
    const batches = z
      .looseObject({ open: z.array(z.looseObject({ documentId: z.number().nullable(), documentVersion: z.number().nullable() })) })
      .parse(await (await h.send('/flow/stock-batches/' + f.finished.id, undefined, h.cookie)).json());
    assert.equal(batches.open.find((b) => b.documentId === f.production.id)?.documentVersion, f.flow.get(f.production.id).version);
  } finally {
    await h.close();
    f.store.close();
  }
});
