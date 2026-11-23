// 助手按模块读流水（server/assistant/tools/modules.ts）：流水行上补的客户、供应商编号取自订单、采购明细或来源单据，
// 来源单据只读流水用到的那几张。虚构数据、内存库。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ctxOf } from '../support/assistant-fixture.js';
import { recordRows } from '../../server/assistant/tools/modules.js';
import { clerk, flowFixture } from '../support/flow-fixture.js';

test('流水行的客户、供应商编号照旧取自来源；没被流水用到的单据不读（内容坏了也不影响）', () => {
  const f = flowFixture();
  const arrival = f.arrive('虚构到货单', '100');
  f.stockIn('50');
  const order = f.order(20),
    waiting = f.order(5);
  const delivery = f.confirm('delivery', {
    customerId: f.customer.id,
    lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: f.finished.id, quantity: '20' }],
  });
  // 一张待送货单：没有出入库，读流水用不到它；把它的内容弄坏，读全部单据就会报错
  const idle = f.draft('delivery', {
    customerId: f.customer.id,
    lines: [{ orderId: waiting.id, orderLineId: waiting.lines[0].id, stockId: f.finished.id, quantity: '5' }],
  });
  f.store.db.prepare("UPDATE flow_documents SET document=json_set(document,'$.虚构的坏内容',1) WHERE id=?").run(idle.id);
  const ctx = { ...ctxOf(f.store), ops: f.ops, flow: f.flow };
  const rows = recordRows(ctx, 'movements', clerk);
  const parties = (id: number) => rows.filter((r) => Number(r.source_id) === id).map((r) => [r.customerId, r.supplierId]);
  assert.deepEqual(parties(arrival.id), [[undefined, f.supplier.id]], '到货：供应商取自到货单');
  assert.deepEqual(parties(delivery.id), [[f.customer.id, undefined]], '送货：客户取自订单');
  assert.equal(rows.length, 3, '到货、手工入库、送货各一笔');
});
