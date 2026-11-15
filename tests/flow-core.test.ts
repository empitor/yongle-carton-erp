// 单据流转的核心规则直接调用：校验、读单据、关联表、核对预览、确认、取消撤销（内存库，不经路由、不起整个系统）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { flowFixture, clerk } from './flow-fixture.js';
import { documentInput, validateFlow } from '../server/flow/validate.js';
import { checkArrival } from '../server/flow/validate-arrival.js';
import { checkDelivery } from '../server/flow/validate-delivery.js';
import { draftIds, get, list, waitingGood } from '../server/flow/read.js';
import { receiptKey, rewriteRefs } from '../server/flow/refs.js';
import { examine, preview } from '../server/flow/preview.js';
import { confirm } from '../server/flow/confirm.js';
import { cancel, reverse } from '../server/flow/undo.js';
import type { Check } from '../server/flow/base.js';

const check = (f: ReturnType<typeof flowFixture>): Check => ({
  flow: f.flow,
  actor: clerk,
  maintenance: false,
  confirm: true,
  skipRemaining: false,
  registered: false,
  item: (id) => f.ops.repo.items(true, id === null ? [] : [id])[0],
  change() {},
  changes: [],
  warnings: [],
});

test('单据校验直接调用：送货超过订单剩余数量拦下，按种类分派到货单、送货单的校验', () => {
  const f = flowFixture();
  try {
    const order = f.order(100);
    f.stockIn('500');
    const delivery = documentInput('delivery', {
      date: '2026-10-27',
      customerId: f.customer.id,
      lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: f.finished.id, quantity: '150' }],
    });
    assert.throws(() => validateFlow(f.flow, delivery, clerk, false), /超过订单剩余数量/);
    const ok = validateFlow(f.flow, { ...delivery, lines: [{ ...delivery.lines[0], quantity: '100' }] }, clerk, true);
    assert.deepEqual(ok.changes.map((c) => [c.stockId, c.deltaUnits, c.reason]), [[f.finished.id, -100000, '客户发货']]);
    // 到货、送货各自的校验函数也能单独调
    const arrival = { kind: 'arrival' as const, date: '2026-10-27', notes: '', supplierId: 999999, reference: '虚构', sourceId: null, lines: [] };
    assert.throws(() => checkArrival({ ...check(f), lines: [] }, arrival), /供应商不存在/);
    assert.throws(() => checkDelivery({ ...check(f), lines: [] }, { ...delivery, customerId: 999999, lines: [] }), /客户不存在/);
    // 完工合格和报废都是 0 的拦下
    assert.throws(
      () =>
        validateFlow(
          f.flow,
          { kind: 'production', date: '2026-10-27', notes: '', taskId: null, productId: f.product.id, finishedStockId: f.finished.id, goodQuantity: '0', scrapQuantity: '0', operator: '虚构机长', materials: [] },
          clerk,
          false,
        ),
      /请登记合格成品或报废数量/,
    );
  } finally {
    f.store.close();
  }
});

test('读单据直接调用：按主键读、按编号列、待核对编号、待入库良品；关联表重写；送货单号的查重写法', () => {
  const f = flowFixture();
  try {
    const done = f.arrive('虚构送货单-读', '10');
    const pending = f.draft('arrival', {
      supplierId: f.supplier.id,
      reference: '虚构送货单-待核对',
      lines: [{ stockId: f.raw.id, item: { name: f.raw.name, unit: '张' }, quantity: '5' }],
    });
    assert.equal(get(f.store, done.id).status, 'confirmed');
    assert.deepEqual(list(f.store, 'arrival', false, undefined, [done.id, pending.id]).map((d) => d.id).sort(), [done.id, pending.id].sort());
    assert.deepEqual(draftIds(f.store, 'arrival'), [pending.id]);
    assert.equal(waitingGood(f.store).size, 0);
    // 关联表：供应商一行，每条明细一行
    rewriteRefs(f.store, pending.id, get(f.store, pending.id));
    assert.deepEqual(
      f.store.db.prepare('SELECT supplier_id,stock_id,purchase_id FROM flow_refs WHERE document_id=? ORDER BY rowid').all(pending.id).map((r) => [r.supplier_id, r.stock_id, r.purchase_id]),
      [[f.supplier.id, null, null], [null, f.raw.id, null]],
    );
    assert.equal(receiptKey('  ａｂ－1 '), 'AB-1');
  } finally {
    f.store.close();
  }
});

test('核对、确认、取消、撤销直接调用：预览给出摘要（按当前数据重算一样），确认入库，撤销把库存扣回', () => {
  const f = flowFixture();
  try {
    const stock = () => f.ops.repo.items(true, f.raw.id)[0].balanceUnits;
    const d = f.draft('arrival', {
      supplierId: f.supplier.id,
      reference: '虚构送货单-确认',
      lines: [{ stockId: f.raw.id, item: { name: f.raw.name, unit: '张' }, quantity: '5' }],
    });
    const p = preview(f.flow, d.id, clerk);
    assert.equal(examine(f.flow, get(f.store, d.id)).previewDigest, p.previewDigest);
    assert.equal(p.changes[0].deltaUnits, 5000);
    const done = confirm(f.flow, d.id, { previewDigest: p.previewDigest, requestId: randomUUID(), acknowledged: true }, clerk);
    assert.equal(done.status, 'confirmed');
    assert.equal(stock(), 5000);
    const other = f.draft('arrival', {
      supplierId: f.supplier.id,
      reference: '虚构送货单-取消',
      lines: [{ stockId: f.raw.id, item: { name: f.raw.name, unit: '张' }, quantity: '3' }],
    });
    cancel(f.flow, other.id, { version: other.version, reason: '虚构取消', acknowledged: true }, clerk);
    assert.equal(get(f.store, other.id).status, 'cancelled');
    reverse(f.flow, done.id, { version: get(f.store, done.id).version, reason: '虚构核错', acknowledged: true }, clerk);
    assert.equal(get(f.store, done.id).status, 'reversed');
    assert.equal(stock(), 0);
  } finally {
    f.store.close();
  }
});
