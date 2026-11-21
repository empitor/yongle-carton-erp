// 本机管理员直接改数据时单据流转的连带处理，直接调用：库存品改名对齐到货单、采购明细解除关联、整份替换单据
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { flowFixture, clerk, localAdmin } from './flow-fixture.js';
import { alignStock, detachPurchaseLines } from '../server/flow/maintenance-cascade.js';
import { replaceFlowDocument } from '../server/flow/maintenance-writes.js';
import { get } from '../server/flow/read.js';
import { receiveLines } from './receive-fixture.js';

test('库存品改名对齐到货单、采购明细解除关联、整份替换单据', () => {
  const f = flowFixture();
  try {
    const done = f.arrive('虚构送货单-对齐', '10');
    const item = f.ops.items(true, f.raw.id)[0];
    alignStock(f.flow, item, { ...item, name: '虚构纸板改名' }, localAdmin());
    assert.equal(get(f.store, done.id, 'arrival').lines[0].item.name, '虚构纸板改名');
    // 采购明细解除关联：挂在上面的到货单不再指向它
    const purchase = f.ops.savePurchase(
      { supplierId: f.supplier.id, status: '已订货', orderDate: '2026-10-01', lines: [{ ...f.raw, stockItemId: f.raw.id, quantity: '100', unitPrice: '1', priceBasis: 'quantity' }] },
      clerk,
    );
    const lineId = purchase.lines[0].id;
    const received = receiveLines(
      f.store,
      purchase.id,
      { requestId: randomUUID(), reference: '虚构送货单-解除', date: '2026-10-10', items: [{ lineId, quantity: '50' }] },
      clerk,
    );
    detachPurchaseLines(f.flow, purchase.id, [lineId], localAdmin());
    assert.equal(get(f.store, received.arrival.id, 'arrival').lines[0].purchaseLineId, null);
    assert.equal(f.flow.views.purchases(true, purchase.id)[0].lines[0].receivedQuantity, '0');
    // 整份替换单据：版本号加一
    const version = get(f.store, done.id).version;
    replaceFlowDocument(f.store, done.id, { ...get(f.store, done.id), notes: '虚构备注' });
    assert.equal(get(f.store, done.id).version, version + 1);
    assert.equal(get(f.store, done.id).notes, '虚构备注');
  } finally {
    f.store.close();
  }
});
