// 采购明细的已到货缓存（purchase_lines.received_units）在到货、退货、撤销、更正、管理员改明细、删到货单、数据维护之后
// 都等于按到货单现算的；订货单每行的已到货、还差多少也一样。采购库存自己读采购单、订货单用缓存列，完整视图现算，两者一致是前提。
// 内存库、虚构数据。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { many, rows, type Store } from '../server/core/index.js';
import { OperationsService, OrderBatchService } from '../server/operations/index.js';
import { correctDocument, FlowService, planCorrection, PurchaseReturns } from '../server/flow/index.js';
import { DatabaseMaintenanceService } from '../server/lifecycle/index.js';
import { batchRows } from '../shared/business/index.js';
import { today } from '../shared/core/index.js';
import { clerk, flowFixture, localAdmin } from './flow-fixture.js';
import { ofKind, orderedPurchase, saveDoc } from './receive-fixture.js';

/**
 * 每条采购明细：缓存的已到货（采购库存的基本视图）等于现算的（单据流转的完整视图）；
 * 每份订货单：采购库存按缓存组装的行（订货单视图用的）和按现算组装的行一样
 */
function assertCacheMatches(store: Store, step: string) {
  const ops = new OperationsService(store),
    views = new FlowService(store).views;
  const live = new Map(views.purchases(true).map((p) => [p.id, p]));
  const cached = ops.purchases(true);
  assert.equal(cached.length, live.size, step + '：采购单数');
  for (const p of cached)
    for (const l of p.lines)
      assert.equal(
        l.receivedUnits,
        live.get(p.id)?.lines.find((x) => x.id === l.id)?.receivedUnits,
        step + '：采购单 ' + p.number + ' 明细 ' + l.id + ' 的已到货',
      );
  const batches = new OrderBatchService(store);
  for (const { id } of many(store.db, rows.order_batches.pick({ id: true }), 'SELECT id FROM order_batches')) {
    const view = batches.view(id),
      members = batches.memberIds(id);
    const shape = (list: { key: string; receivedUnits: number; remainingUnits: number }[]) => list.map((r) => [r.key, r.receivedUnits, r.remainingUnits]);
    assert.deepEqual(
      shape(view.rows),
      shape(batchRows(batches.sourceLines(views.purchases(true, members)), view.schedule, today())),
      step + '：订货单 ' + view.number + ' 的行',
    );
  }
}

/** 一张两行的已订货采购单（两种纸板，订货单分两行），和登记、退货要用的几样 */
function setup() {
  const f = flowFixture(clerk);
  const raw2 = f.base.raw({ name: '虚构纸板二', length: 900, width: 700, dimensionUnit: 'mm' });
  const p = orderedPurchase(f, clerk, ['1000', [raw2, '500']]);
  const returns = new PurchaseReturns(f.store);
  const giveBack = (arrivalId: number, quantity: string) =>
    returns.create(clerk, { arrivalId, date: '2026-10-11', reason: '虚构质量问题', requestId: randomUUID(), lines: [{ lineIndex: 0, quantity }] });
  return { f, p, returns, giveBack };
}

test('到货、再到货、退货和撤销退货、撤销到货以后，已到货缓存都等于现算', () => {
  const { f, p, returns, giveBack } = setup();
  try {
    const first = p.receive([{ quantity: '400' }, { quantity: '100' }], '虚构送货单-01');
    assertCacheMatches(f.store, '部分到货');
    const second = p.receive([{ quantity: '600' }, { quantity: '400' }], '虚构送货单-02');
    assertCacheMatches(f.store, '到齐');
    const back = giveBack(first.arrival.id, '50');
    assertCacheMatches(f.store, '退货');
    returns.reverse(localAdmin(), back.id, { version: back.version, reason: '虚构冲销' });
    assertCacheMatches(f.store, '撤销退货');
    f.flow.reverse(second.arrival.id, { version: f.flow.get(second.arrival.id).version, reason: '虚构登记重了', acknowledged: true }, localAdmin());
    assertCacheMatches(f.store, '撤销到货');
  } finally {
    f.store.close();
  }
});

test('更正到货（改数量、换挂另一条采购明细）以后，已到货缓存都等于现算', () => {
  const f = flowFixture(clerk);
  try {
    const p = orderedPurchase(f, clerk, ['10', '10']);
    const [l0, l1] = p.purchase.lines;
    const draft = saveDoc(f.flow, 'arrival', {
      date: '2026-10-10',
      supplierId: f.supplier.id,
      reference: '虚构两行到货',
      lines: [l0, l1].map((l) => ({ stockId: f.raw.id, purchaseLineId: l.id, item: { name: f.raw.name, unit: '张' }, quantity: '5', unitPrice: '2', priceBasis: 'quantity' })),
    }, clerk);
    const a = f.base.check(draft, {}, clerk);
    assertCacheMatches(f.store, '两行到货');
    const correct = (id: number, lines: { index: number; quantity: string; purchaseLineId?: number }[]) => {
      const input = { expectedVersion: f.flow.get(id).version, reason: '虚构更正', lines };
      const plan = planCorrection(f.store, id, input, localAdmin());
      return ofKind(correctDocument(f.store, id, { ...input, previewDigest: plan.previewDigest, requestId: randomUUID() }, localAdmin()), 'arrival').replacementFlowId;
    };
    const first = correct(a.id, [{ index: 0, quantity: '3' }, { index: 1, quantity: '5' }]);
    assertCacheMatches(f.store, '改数量');
    const second = correct(first, [{ index: 1, quantity: '5' }]);
    assertCacheMatches(f.store, '删一行');
    correct(second, [{ index: 0, quantity: '5', purchaseLineId: l0.id }]);
    assertCacheMatches(f.store, '换挂另一条采购明细');
  } finally {
    f.store.close();
  }
});

test('本机管理员改了采购明细（到货解除关联）以后，已到货缓存等于现算', () => {
  const { f, p } = setup();
  try {
    p.receive([{ quantity: '400' }, { quantity: '100' }], '虚构送货单-01');
    const cur = p.current();
    f.flow.stock.savePurchase(
      { ...cur, status: cur.baseStatus, version: cur.version, lines: cur.lines.map((l, i) => (i === 0 ? { ...l, specification: '虚构改过的规格', length: 1200, width: 800, dimensionUnit: 'mm' } : l)) },
      localAdmin(),
      cur.id,
    );
    assert.equal(p.current().lines[0].receivedUnits, 0, '改过的那行解除了到货关联');
    assertCacheMatches(f.store, '管理员改明细');
  } finally {
    f.store.close();
  }
});

test('删掉到货单、数据维护全量重算以后，已到货缓存等于现算', () => {
  const { f, p } = setup();
  try {
    const first = p.receive([{ quantity: '400' }, { quantity: '100' }], '虚构送货单-01');
    p.receive([{ quantity: '100' }, { quantity: '100' }], '虚构送货单-02');
    const maintenance = new DatabaseMaintenanceService(f.store),
      selection = { module: 'arrival', items: [{ id: first.arrival.id, version: f.flow.get(first.arrival.id).version }], inventoryPolicy: 'preserve' };
    const preview = maintenance.preview(selection, localAdmin());
    maintenance.delete({ ...selection, requestId: randomUUID(), deletionDigest: preview.digest }, localAdmin(), 'session');
    assertCacheMatches(f.store, '删到货单');
    f.flow.recomputeAfterMaintenance();
    assertCacheMatches(f.store, '数据维护全量重算');
  } finally {
    f.store.close();
  }
});
