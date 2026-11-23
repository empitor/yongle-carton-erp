// 整张保存核对版本：拿打开时读到的旧版本号保存采购单、库存品、供应商，回 409，库里的记录和审计都不变。
// 走保存入口（单据流转的 FlowService.stock、采购库存的 OperationsService），内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppError, count } from '../../server/core/index.js';
import { actor } from '../support/actor-fixture.js';
import { businessBase, standardRecords } from '../support/business-base-fixture.js';

const conflict = (e: unknown) => e instanceof AppError && e.status === 409;

function setup() {
  const base = businessBase(actor),
    records = standardRecords(base);
  const audits = () => count(base.store.db, 'SELECT count(*) FROM business_audit');
  return { ...base, ...records, audits };
}

test('拿旧版本号整张保存采购单：回 409，采购单和审计都不变', () => {
  const f = setup();
  try {
    const p = f.ops.savePurchase(
      { supplierId: f.supplier.id, status: '待订货', orderDate: '2026-10-01', lines: [{ ...f.raw, stockItemId: f.raw.id, quantity: '100', unitPrice: '1', priceBasis: 'quantity' }] },
      actor,
    );
    const stale = f.flow.views.purchases(true, p.id)[0];
    f.flow.stock.savePurchase({ ...stale, notes: '虚构先改的人' }, actor, p.id);
    const before = f.flow.views.purchases(true, p.id)[0],
      audits = f.audits();
    assert.throws(() => f.flow.stock.savePurchase({ ...stale, notes: '虚构后改的人' }, actor, p.id), conflict);
    assert.deepEqual(f.flow.views.purchases(true, p.id)[0], before);
    assert.equal(f.audits(), audits);
  } finally {
    f.store.close();
  }
});

test('拿旧版本号整张保存库存品：回 409，库存品和审计都不变', () => {
  const f = setup();
  try {
    const stale = f.flow.views.items(true, f.raw.id)[0];
    f.flow.stock.saveItem({ ...stale, notes: '虚构先改的人' }, actor, f.raw.id);
    const before = f.flow.views.items(true, f.raw.id)[0],
      audits = f.audits();
    assert.throws(() => f.flow.stock.saveItem({ ...stale, notes: '虚构后改的人' }, actor, f.raw.id), conflict);
    assert.deepEqual(f.flow.views.items(true, f.raw.id)[0], before);
    assert.equal(f.audits(), audits);
  } finally {
    f.store.close();
  }
});

test('拿旧版本号整张保存供应商：回 409，供应商和审计都不变', () => {
  const f = setup();
  try {
    const stale = f.ops.suppliers(true, f.supplier.id)[0];
    f.ops.saveSupplier({ ...stale, notes: '虚构先改的人' }, actor, f.supplier.id);
    const before = f.ops.suppliers(true, f.supplier.id)[0],
      audits = f.audits();
    assert.throws(() => f.ops.saveSupplier({ ...stale, notes: '虚构后改的人' }, actor, f.supplier.id), conflict);
    assert.deepEqual(f.ops.suppliers(true, f.supplier.id)[0], before);
    assert.equal(f.audits(), audits);
  } finally {
    f.store.close();
  }
});
