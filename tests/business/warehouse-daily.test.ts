// 仓库每日记录（server/flow/daily.ts）：到货、送货按日期归属，待入库、待送货和完成分开算。内存库、虚构数据。
import { trackedOrder } from '../../server/orders/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setup } from '../support/document-fixture.js';
import { applyCorrection, previewCorrection } from '../support/receive-fixture.js';
import { actor } from '../support/actor-fixture.js';

test('每日到货按到货日期归属：待入库列在登记那天、核对入库前不算完成，取消和更正不重复计算', () => {
  const f = setup();
  try {
    f.ordered();
    const waiting = f.pendingArrival(),
      cancelled = f.pendingArrival('2026-11-02', '1000');
    f.flow.cancel(
      cancelled.id,
      { version: cancelled.version, reason: '虚构取消', acknowledged: true },
      actor,
    );
    assert.equal(f.ops.balance(f.raw.id), 0);
    // 到货没有计划日（安排在订货单上）：待入库的列在登记那天，不计“已完成”
    const day = f.daily.get({ kind: 'arrival', date: '2026-10-30' });
    if (day.kind !== 'arrival') throw new Error('预期到货台账');
    assert.deepEqual(day.summary, { planned: 0, completed: 0, pending: 0 });
    assert.deepEqual(day.records.map((r) => [r.flowId, r.pending]), [[waiting.id, true]]);
    // 取消的待入库到货单哪天都不列
    assert.deepEqual(f.daily.get({ kind: 'arrival', date: '2026-11-02' }).records, []);
    const first = f.receive('4000');
    assert.deepEqual(f.daily.get({ kind: 'arrival', date: '2026-10-29' }).summary, {
      planned: 0,
      completed: 1,
      pending: 0,
    });
    f.receive('1000');
    const firstDay = f.daily.get({ kind: 'arrival', date: '2026-10-29' }).summary;
    assert.ok(firstDay);
    assert.equal(firstDay.completed, 2);
    const receipt = f.current().receipts.find((r) => r.id === 'flow-' + first.arrival.id);
    assert.ok(receipt);
    const correctionLine = receipt.correctionLines[0];
    assert.ok(correctionLine);
    const input = {
      expectedVersion: receipt.version,
      reason: '虚构实收更正',
      items: [{ index: 0, lineId: correctionLine.lineId, quantity: '3500' }],
    };
    const preview = previewCorrection(f.ops.store, receipt.id, input, actor);
    applyCorrection(f.ops.store,
      receipt.id,
      { ...input, requestId: randomUUID(), previewDigest: preview.previewDigest },
      actor,
    );
    const correctedDay = f.daily.get({ kind: 'arrival', date: '2026-10-29' }).summary;
    assert.ok(correctedDay);
    assert.equal(correctedDay.completed, 2);
    assert.equal(f.ops.balance(f.raw.id), 4500 * 1000);
  } finally {
    f.store.close();
  }
});

test('每日送货按计划日和实际出库日分别归属，分批送货的已发、未发和流水对得上', () => {
  const f = setup();
  try {
    const p = f.saveDelivery();
    assert.equal(f.ops.balance(f.stock.id), 10000000);
    const pendingDay = f.daily.get({ kind: 'delivery', date: '2026-10-30' }).summary;
    assert.ok(pendingDay);
    assert.equal(pendingDay.pending, 1);
    const adjusted = f.flow.schedule(
      p.id,
      {
        plannedDate: '2026-11-02',
        plannedTime: '16:00',
        expectedVersion: p.version,
        requestId: randomUUID(),
      },
      actor,
    ).document;
    assert.equal(adjusted.actualDate, null);
    assert.equal(adjusted.plannedTime, '16:00');
    f.confirm(adjusted);
    const first = f.daily.get({ kind: 'delivery', date: '2026-10-29' });
    assert.ok(first.kind === 'delivery');
    assert.ok(first.summary);
    assert.equal(first.summary.completed, 1);
    assert.equal(first.summary.planned, 0);
    assert.equal(first.records[0].lines[0].shippedQuantity, 4000);
    assert.equal(first.records[0].lines[0].remainingQuantity, 6000);
    assert.equal(first.records[0].lines[0].movements.length, 1);
    f.confirm(f.saveDelivery('6000', { date: '2026-10-30', plannedDate: null }));
    assert.equal(trackedOrder(f.store, f.order.id)?.shippingProgress, '已发完');
    assert.equal(f.ops.balance(f.stock.id), 0);
    const secondDay = f.daily.get({ kind: 'delivery', date: '2026-10-30' }).summary;
    assert.ok(secondDay);
    assert.equal(secondDay.completed, 1);
  } finally {
    f.store.close();
  }
});
