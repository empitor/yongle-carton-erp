// 采购单状态动作的结果按采购单的完整结构存进防重复记录：有到货记录的采购单，同一请求号重发也原样返回（内存库、虚构数据）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { clerk, flowFixture } from './flow-fixture.js';
import { orderedPurchase } from './receive-fixture.js';

test('有到货记录的采购单取消后，同一请求号重发原样返回整张采购单（明细、到货记录都在）', () => {
  const f = flowFixture();
  try {
    const p = orderedPurchase(f, clerk);
    p.receive('400', '虚构送货单-重发');
    const before = p.current();
    assert.equal(before.receipts.length, 1);
    const once = { expectedVersion: before.version, requestId: randomUUID(), reason: '虚构取消原因' };
    const first = f.flow.stock.changePurchaseStatus(before.id, 'cancel', once, clerk);
    assert.equal(first.baseStatus, '已取消');
    assert.equal(first.receipts.length, 1);
    assert.deepEqual(f.flow.stock.changePurchaseStatus(before.id, 'cancel', once, clerk), first);
  } finally {
    f.store.close();
  }
});
