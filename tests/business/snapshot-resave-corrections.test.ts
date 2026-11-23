// 更正（到货、送货、完工）和改已下达的生产任务重新保存单据时，服务端抄下的快照字段（名称、单价税率、材质楞型、面积金额……）
// 引用没变的原样保留原单的，引用换了才按新引用取（用户 2026-11-21 定）。快照字段从单据结构派生，
// 每个都先填成虚构的标记值再走一遍（snapshot-fixture.ts）。内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { storedDocument } from '../../server/flow/documents/read.js';
import { viewAs } from '../support/read-result.js';
import { lineMoney } from '../../shared/business/index.js';
import { fixture } from '../support/maintenance-fixture.js';
import { saveDoc } from '../support/receive-fixture.js';
import { assertSnapshots, correct, markSnapshots } from './snapshot-fixture.js';

const reason = '虚构：登记错了';

test('更正到货单：引用没变的快照都留着原单的，只有改了数量的那一行面积、金额按新数量算', () => {
  const f = fixture();
  try {
    const a = f.arrival();
    markSnapshots(f.store, a.id);
    const id = correct(f.store, a.id, { expectedVersion: f.flow.get(a.id).version, reason, lines: [{ index: 0, quantity: '900' }] }, f.who);
    assertSnapshots(storedDocument(f.store, id), { lines: { 0: ['area', 'amount'] } });
  } finally {
    f.store.close();
  }
});

test('更正到货单换了供应商：表头和每一行的供应商名按新供应商取，别的快照照旧', () => {
  const f = fixture();
  try {
    const other = f.base.supplier({ name: '虚构新供应商' });
    const saved = saveDoc(f.flow, 'arrival', {
      date: '2026-10-27',
      supplierId: f.supplier.id,
      reference: randomUUID(),
      lines: [{ stockId: f.raw.id, item: { name: f.raw.name, unit: '张' }, quantity: '50' }],
    }, f.who);
    const a = viewAs(f.base.check(saved), 'arrival');
    markSnapshots(f.store, a.id);
    const id = correct(f.store, a.id, { expectedVersion: f.flow.get(a.id).version, reason, supplierId: other.id, lines: [{ index: 0, quantity: '50' }] }, f.who);
    const after = storedDocument(f.store, id, 'arrival');
    assertSnapshots(after, { doc: ['supplierName'], lines: { 0: ['supplierName'] } });
    assert.deepEqual([after.supplierName, after.lines[0].supplierName], ['虚构新供应商', '虚构新供应商']);
  } finally {
    f.store.close();
  }
});

test('更正送货单：沿用的行品名、规格、单价、税率、材质楞型、尺寸都留着出库时的，金额按新数量乘出库时的单价', () => {
  const f = fixture();
  try {
    f.arrival();
    f.production();
    const d = f.delivery();
    markSnapshots(f.store, d.id);
    const id = correct(f.store, d.id, { expectedVersion: f.flow.get(d.id).version, reason, lines: [{ index: 0, quantity: '80' }] }, f.who);
    const after = storedDocument(f.store, id, 'delivery');
    assertSnapshots(after, { lines: { 0: ['amountExact'] } });
    assert.equal(after.lines[0].amountExact, lineMoney('80', after.lines[0].unitPriceExact ?? null));
  } finally {
    f.store.close();
  }
});

test('更正完工单：产品没换，产品名留着原单的；换了产品按新产品取', () => {
  const f = fixture();
  try {
    f.arrival();
    const p = f.production();
    markSnapshots(f.store, p.id);
    const kept = correct(f.store, p.id, { expectedVersion: f.flow.get(p.id).version, reason, goodQuantity: '850' }, f.who);
    assertSnapshots(storedDocument(f.store, kept));
    const other = f.base.product({ name: '虚构换上的纸箱' });
    const moved = correct(f.store, kept, { expectedVersion: f.flow.get(kept).version, reason, productId: other.id }, f.who);
    const after = storedDocument(f.store, moved, 'production');
    assertSnapshots(after, { doc: ['productName'] });
    assert.equal(after.productName, '虚构换上的纸箱');
  } finally {
    f.store.close();
  }
});

test('改已下达的生产任务：产品没换，产品名留着原来的；换了产品按新产品取', () => {
  const f = fixture();
  try {
    const task = f.task();
    markSnapshots(f.store, task.id);
    const input = { date: '2026-10-27', productId: f.product.id, quantity: '900', unit: '只', orderIds: [f.order.id] };
    f.flow.save('task', { ...input, version: f.flow.get(task.id).version }, f.who, task.id);
    assertSnapshots(storedDocument(f.store, task.id));
    const other = f.base.product({ name: '虚构改做的纸箱' });
    f.flow.save('task', { ...input, productId: other.id, orderIds: [], version: f.flow.get(task.id).version }, f.who, task.id);
    const after = storedDocument(f.store, task.id, 'task');
    assertSnapshots(after, { doc: ['productName'] });
    assert.equal(after.productName, '虚构改做的纸箱');
  } finally {
    f.store.close();
  }
});
