// 数据管理保存时读出来才有的栏目（已发数量、金额、单号这类系统算出来的）：照读到的记录原样带回来不算错，
// 改了值、或带了记录里根本没有的栏目才拦，报错一律中文（server/admin/input-fields.ts、field-rejection.ts）。
// 助手 records.get 读到的订单、采购单是业务总览的记录，单据是单据视图（明细和数据管理列表的 record 同一份），这里用后者代替。
import { sales } from '../server/sales/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inputSchemas, type ManagedModule } from '../server/admin/managed-records.js';
import { unknownFields } from '../server/admin/input-fields.js';
import { rejectionText } from '../server/admin/field-rejection.js';
import { fixture } from './maintenance-fixture.js';
import { command } from './data-management-fixture.js';

type F = ReturnType<typeof fixture>;
/** 读到的那条记录（数据管理列表的 record） */
function record<M extends ManagedModule>(f: F, module: M, id: number) {
  const row = f.dataManagement.list(module, f.who).records.find((r) => r.record.id === id);
  assert.ok(row, '列表里有这一条');
  return row.record;
}
/** 明细第一行照原样带回、只改数量，以助手的身份交（management.execute） */
function resend(f: F, module: ManagedModule, id: number, quantity: string | number) {
  const r = record(f, module, id);
  assert.ok('lines' in r && Array.isArray(r.lines));
  const lines = [{ ...r.lines[0], quantity }, ...r.lines.slice(1)];
  return f.dataManagement.execute(command(module, 'update', [r], { lines }), f.who, 's', 'management-assistant');
}
const NO_LATIN = /[A-Za-z]/;

test('助手照读到的记录原样带回明细、只改一格能存：订单、采购单、待入库的到货单、待送货的送货单', () => {
  const f = fixture();
  try {
    resend(f, 'orders', f.order.id, 900);
    assert.equal(sales(f.store).order(f.order.id, true)?.lines[0].quantity, 900);
    resend(f, 'purchases', f.purchase.id, '900');
    assert.equal(f.flow.views.purchases(true, [f.purchase.id])[0].lines[0].quantity, '900');
    const arrival = f.flow.save(
      'arrival',
      { date: '2026-10-27', supplierId: f.supplier.id, reference: '虚构派生栏目到货', lines: [{ stockId: f.raw.id, item: { name: f.raw.name, unit: '张' }, quantity: '10', purchaseLineId: f.purchase.lines[0].id }] },
      f.who,
    );
    resend(f, 'arrival', arrival.id, '20');
    assert.equal(f.flow.get(arrival.id, 'arrival').lines[0].quantity, '20');
    const orderLine = sales(f.store).order(f.order.id, true)?.lines[0];
    assert.ok(orderLine);
    const delivery = f.flow.save(
      'delivery',
      { date: '2026-10-27', customerId: f.customer.id, lines: [{ orderId: f.order.id, orderLineId: orderLine.id, stockId: f.finished.id, quantity: '50' }] },
      f.who,
    );
    resend(f, 'delivery', delivery.id, '60');
    assert.equal(f.flow.get(delivery.id, 'delivery').lines[0].quantity, '60');
  } finally {
    f.store.close();
  }
});

test('改了读出来才有的栏目：拒收，用中文说是哪一格，订单不变', () => {
  const f = fixture();
  try {
    const r = record(f, 'orders', f.order.id);
    const lines = [{ ...r.lines[0], shippedQuantity: 999 }];
    assert.throws(
      () => f.dataManagement.execute(command('orders', 'update', [r], { lines, totalCents: 1 }), f.who, 's', 'management-assistant'),
      (e: unknown) => e instanceof Error && /明细第1项的已发数量：是系统算出来的/.test(e.message) && /订单金额/.test(e.message) && !NO_LATIN.test(e.message),
    );
    assert.equal(sales(f.store).order(f.order.id, true)?.version, r.version, '订单没改');
  } finally {
    f.store.close();
  }
});

test('读出来的记录里录入不收的每一格都有中文说法：改了、或新建时带上，报错都不露字段代码', () => {
  const f = fixture();
  try {
    f.arrival();
    f.production(f.task().id);
    f.delivery();
    for (const module of Object.keys(inputSchemas).filter((m): m is ManagedModule => m in inputSchemas))
      for (const { record: r } of f.dataManagement.list(module, f.who).records) {
        const paths = unknownFields(r, inputSchemas[module]);
        for (const text of [rejectionText(module, { changed: paths, unknown: [] }), rejectionText(module, { changed: [], unknown: paths })])
          assert.doesNotMatch(text, NO_LATIN, module + ' ' + r.id + '：' + text);
      }
  } finally {
    f.store.close();
  }
});

test('不收的栏目的提示后半句：库存数量、单据状态才说去哪办，别的只说去掉或改回', () => {
  const tail = (module: string, path: (string | number)[]) => rejectionText(module, { changed: [path], unknown: [] });
  assert.match(tail('stock_items', ['balanceUnits']), /库存数量请登记盘点/);
  assert.match(tail('delivery', ['status']), /单据状态请用确认、取消、撤销/);
  const plain = tail('orders', ['lines', 0, 'shippedQuantity']);
  assert.doesNotMatch(plain, /盘点|撤销|冲销/);
  assert.match(plain, /没有保存，请去掉或改回这几项再提交。$/);
});

test('顶层几格的叫法不借别的格子：编号不叫“明细”，采购单按明细汇总的关联订单和单头的“关联订单”分开叫', () => {
  const said = (module: string, key: string) => rejectionText(module, { changed: [[key]], unknown: [] });
  assert.match(said('orders', 'id'), /^编号：/);
  assert.match(said('purchases', 'orderIds'), /^各行关联的订单：/);
  assert.match(rejectionText('purchases', { changed: [], unknown: [['customerOrderId']] }), /^关联订单：/);
  assert.match(said('stock_items', 'quantity'), /^库存数量：/);
  assert.match(said('delivery', 'kind'), /^单据种类：/);
});
