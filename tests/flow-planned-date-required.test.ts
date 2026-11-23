// 生产任务、送货单的计划日：保存时没写就按单据日期补上（server/flow/rules/validate.ts），所以库里一定有；
// 建表（server/core/schema/tables/flow.ts）也约束这两种单据的 planned_date 不能为空，到货单、完工单照旧没有。
// 内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/core/index.js';
import { accepts, rejects } from './schema-fixture.js';
import { flowFixture } from './flow-fixture.js';

test('保存生产任务、送货单时没写计划日：按单据日期补上，单据内容和计划日列都是这一天', () => {
  const f = flowFixture();
  try {
    const order = f.order(10);
    const task = f.task({ productId: f.product.id, quantity: '10', unit: '只', orderIds: [order.id] });
    const delivery = f.draft('delivery', {
      customerId: f.customer.id,
      lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: f.finished.id, quantity: '10' }],
    });
    const plannedColumn = f.store.db.prepare('SELECT planned_date FROM flow_documents WHERE id=?');
    assert.equal(f.flow.get(task.id, 'task').plannedDate, '2026-10-27');
    assert.equal(f.flow.get(delivery.id, 'delivery').plannedDate, '2026-10-27');
    for (const id of [task.id, delivery.id]) assert.deepEqual({ ...plannedColumn.get(id) }, { planned_date: '2026-10-27' });
    const scheduled = f.task({ productId: f.product.id, quantity: '5', unit: '只', orderIds: [order.id], plannedDate: '2026-11-02' });
    assert.equal(f.flow.get(scheduled.id, 'task').plannedDate, '2026-11-02', '写了计划日的照写的存');
  } finally {
    f.store.close();
  }
});

test('库里的生产任务、送货单不能没有计划日；到货单、完工单没有计划日照常写得进', () => {
  const store = new Store(':memory:');
  try {
    const insert = `INSERT INTO flow_documents(kind,number,date,status,document,actor_id,actor_name,created_at,updated_at)
      VALUES(?,?,'2026-10-27','confirmed',?,'fixture','虚构','2026-10-27','2026-10-27')`;
    let n = 0;
    const row = (kind: string, document: Record<string, unknown>) => [kind, 'FICT-PLAN-' + ++n, JSON.stringify(document)];
    rejects(store.db, insert, row('task', { unit: '只' }));
    rejects(store.db, insert, row('delivery', {}));
    accepts(store.db, insert, row('arrival', {}));
    accepts(store.db, insert, row('production', {}));
  } finally {
    store.close();
  }
});
