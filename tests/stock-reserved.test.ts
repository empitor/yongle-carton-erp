// 库存品的已安排数（OperationsRepository.items 的 reservedUnits、availableUnits，单据那边由 server/flow/arrival-source.ts 的 reservedUnits 算）：
// 只算没归档的待送货送货单、待入库完工单的领料净数；已出库、已入库、已取消、已撤销、已归档的不算。内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { businessFixture } from './flow-fixture.js';
import { saveDoc } from './receive-fixture.js';

function reservedFixture() {
  const f = businessFixture();
  const { flow, base, actor } = f;
  const stockIn = (stockId: number, quantity: string) => base.stockIn({ id: stockId }, { quantity, date: '2026-10-01' });
  stockIn(f.finished.id, '1000');
  stockIn(f.raw.id, '500');
  stockIn(f.glue.id, '100');
  const task = f.task('900');
  const delivery = (quantity: string) =>
    saveDoc(flow, 'delivery', { date: '2026-10-27', customerId: f.customer.id, lines: [{ orderId: f.order.id, orderLineId: f.order.lines[0].id, stockId: f.finished.id, quantity }] }, actor);
  const production = (materials: { stockId: number; issued: string; returned: string }[]) =>
    saveDoc(flow, 'production', { date: '2026-10-27', taskId: task.id, productId: f.product.id, finishedStockId: f.finished.id, goodQuantity: '10', operator: '虚构员工', materials }, actor);
  const confirm = (id: number) => base.check({ id }, {}, actor);
  const cancel = (id: number) => flow.cancel(id, { version: flow.get(id).version, reason: '虚构取消', acknowledged: true }, actor);
  const reverse = (id: number) => flow.reverse(id, { version: flow.get(id).version, reason: '虚构撤销', acknowledged: true }, actor);
  /** 待核对的单据不能从页面归档，这里直接记一条归档，守“归档的不算”这一条 */
  const archive = (kind: string, id: number) =>
    f.store.db
      .prepare('INSERT INTO record_lifecycle(entity,record_id,archived_at,actor_id) VALUES(?,?,?,?)')
      .run('flow_' + kind, id, '2026-10-28T00:00:00.000Z', actor.id);
  return { ...f, delivery, production, confirm, cancel, reverse, archive };
}

test('已安排只算没归档的待送货、待入库单据；已出库、已入库、已取消、已撤销、已归档的不算；按库存品圈不圈结果一样', () => {
  const f = reservedFixture();
  try {
    // 送货：待送货 30 只算；已取消 20、已出库 40、出库后撤销 5、归档的待送货 7 都不算
    f.delivery('30');
    f.cancel(f.delivery('20').id);
    f.confirm(f.delivery('40').id);
    const back = f.delivery('5');
    f.confirm(back.id);
    f.reverse(back.id);
    f.archive('delivery', f.delivery('7').id);
    // 完工：待入库的领料按领用减退回算（纸板 10−3、衬板 4）；已取消、已入库、入库后撤销、归档的都不算；成品产出不算已安排
    f.production([{ stockId: f.raw.id, issued: '10', returned: '3' }, { stockId: f.glue.id, issued: '4', returned: '0' }]);
    f.cancel(f.production([{ stockId: f.raw.id, issued: '6', returned: '0' }]).id);
    f.confirm(f.production([{ stockId: f.raw.id, issued: '8', returned: '0' }]).id);
    const undone = f.production([{ stockId: f.raw.id, issued: '2', returned: '0' }]);
    f.confirm(undone.id);
    f.reverse(undone.id);
    f.archive('production', f.production([{ stockId: f.glue.id, issued: '9', returned: '1' }]).id);

    // 每个库存品：[编号, 结余, 已安排, 已安排（文字）, 可用]，列表按编号从大到小
    const facts = (ids?: number | number[]) =>
      f.ops.repo.items(true, ids).map((i) => [i.id, i.balanceUnits, i.reservedUnits, i.reserved, i.availableUnits]);
    const finished = [f.finished.id, 970000, 30000, '30', 940000],
      glue = [f.glue.id, 100000, 4000, '4', 96000],
      raw = [f.raw.id, 492000, 7000, '7', 485000];
    assert.deepEqual(facts(), [finished, glue, raw]);
    assert.deepEqual(facts([f.raw.id, f.glue.id, f.finished.id]), [finished, glue, raw]);
    assert.deepEqual(facts(f.raw.id), [raw]);
    assert.deepEqual(facts([f.glue.id]), [glue]);
  } finally {
    f.store.close();
  }
});
