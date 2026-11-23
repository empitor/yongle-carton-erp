// 数据管理改单据、订单时，补丁和读出来的记录怎么对上（server/admin/input-fields.ts、managed-save.ts）：
// 照原样带回的格子不算改了（已生效单据整条读出来、只改备注能存）；明细带编号的按编号对行，没编号的按内容对
// （和记录里哪一行一样的格子最多就是哪一行，一样多才按第几行）；
// 已生效单据删行、对调这类动了明细的，说“请用更正”，不说成改了算出来的栏目。虚构数据。
import { sales } from '../server/sales/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ManagedModule } from '../server/admin/managed-records.js';
import { orderSchema } from '../shared/core/domain.js';
import { fixture } from './maintenance-fixture.js';
import { command } from './data-management-fixture.js';

type F = ReturnType<typeof fixture>;
/** 读到的那条记录（数据管理列表的 record，和助手 records.get 读到的明细同一份）和编辑窗的内容 */
function listed<M extends ManagedModule>(f: F, module: M, id: number) {
  const row = f.dataManagement.list(module, f.who).records.find((r) => r.record.id === id);
  assert.ok(row, '列表里有这一条');
  return row;
}
const send = (f: F, module: ManagedModule, row: { id: number; version: number }, patch: object) =>
  f.dataManagement.execute(command(module, 'update', [row], patch), f.who, 's', 'management-assistant');
/** 一张两行的已确认订单（同一个产品，100 只、200 只） */
const twoLineOrder = (f: F) =>
  sales(f.store).saveOrder(
    orderSchema.parse({
      customerId: f.customer.id,
      orderDate: '2026-10-01',
      deliveryDate: '2026-10-30',
      status: '已确认',
      lines: [100, 200].map((quantity) => ({ productId: f.product.id, quantity, unit: '只', unitPriceCents: 100 })),
    }),
  );
/** 一张两行的送货单（订单两行各送一些），confirmed 为真时核对出库 */
function twoLineDelivery(f: F, confirmed: boolean) {
  const order = twoLineOrder(f);
  const lines = order.lines.map((l, i) => ({ orderId: order.id, orderLineId: l.id, stockId: f.finished.id, quantity: String(10 * (i + 1)) }));
  const d = f.flow.save('delivery', { date: '2026-10-27', customerId: f.customer.id, lines }, f.who);
  if (confirmed) f.base.check(d, {}, f.who);
  return d.id;
}
const CORRECT = /改数量请用“更正送货单”/;
const quantities = (f: F, id: number) => f.flow.get(id, 'delivery').lines.map((l) => l.quantity);

test('已生效的送货单：整条读出来只改备注、只带单号状态改备注、编辑窗整份交回改备注都能存；改了日期说请用更正', () => {
  const f = fixture();
  try {
    f.arrival();
    f.production();
    const id = f.delivery().id;
    let row = listed(f, 'delivery', id);
    send(f, 'delivery', row.record, { ...row.record, notes: '虚构整条带回' });
    row = listed(f, 'delivery', id);
    send(f, 'delivery', row.record, { number: row.record.number, status: row.record.status, notes: '虚构只带单号状态' });
    row = listed(f, 'delivery', id);
    send(f, 'delivery', row.record, { ...row.input, notes: '虚构编辑窗整份' });
    assert.equal(f.flow.get(id, 'delivery').notes, '虚构编辑窗整份');
    row = listed(f, 'delivery', id);
    assert.throws(() => send(f, 'delivery', row.record, { ...row.record, date: '2026-10-28' }), CORRECT);
  } finally {
    f.store.close();
  }
});

test('订单明细按编号对行：照读到的明细插一行、删一行都能存；挪了位置的行改了已发数量照样拦', () => {
  const f = fixture();
  try {
    const order = twoLineOrder(f);
    let row = listed(f, 'orders', order.id);
    const added = { productId: f.product.id, quantity: 50, unit: '只', unitPriceCents: 100 };
    send(f, 'orders', row.record, { lines: [added, ...row.record.lines] });
    const savedLines = sales(f.store).order(order.id, true)?.lines;
    assert.ok(savedLines);
    assert.deepEqual(savedLines.map((l) => l.quantity), [100, 200, 50]);
    assert.deepEqual(savedLines.slice(0, 2).map((l) => l.id), order.lines.map((l) => l.id));
    row = listed(f, 'orders', order.id);
    send(f, 'orders', row.record, { lines: row.record.lines.filter((l) => l.id !== savedLines[2].id) });
    assert.deepEqual(sales(f.store).order(order.id, true)?.lines.map((l) => l.quantity), [100, 200]);
    row = listed(f, 'orders', order.id);
    const [first, second] = row.record.lines;
    assert.throws(() => send(f, 'orders', row.record, { lines: [{ ...second, shippedQuantity: 5 }, first] }), /明细第1项的已发数量：是系统算出来的/);
  } finally {
    f.store.close();
  }
});

test('单据明细没编号按内容对行：待送货的删行、对调能存；已生效的删行、对调说请用更正，不说成改了算出来的栏目', () => {
  const f = fixture();
  try {
    f.arrival();
    f.production();
    const draft = twoLineDelivery(f, false);
    let row = listed(f, 'delivery', draft);
    send(f, 'delivery', row.record, { lines: [...row.record.lines].reverse() });
    assert.deepEqual(quantities(f, draft), ['20', '10']);
    row = listed(f, 'delivery', draft);
    send(f, 'delivery', row.record, { lines: row.record.lines.slice(1) });
    assert.deepEqual(quantities(f, draft), ['10']);
    const confirmed = twoLineDelivery(f, true);
    row = listed(f, 'delivery', confirmed);
    for (const lines of [[...row.record.lines].reverse(), row.record.lines.slice(1)])
      assert.throws(
        () => send(f, 'delivery', row.record, { lines }),
        (e: unknown) => e instanceof Error && CORRECT.test(e.message) && !/系统算出来/.test(e.message),
      );
    assert.deepEqual(quantities(f, confirmed), ['10', '20'], '已生效的送货单没动');
  } finally {
    f.store.close();
  }
});
