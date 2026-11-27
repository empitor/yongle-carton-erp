// 订单换客户时连带改的送货单收货信息（server/flow/rules/order-edit-cascade.ts，用户 2026-11-27 定）：
// 已出库、已取消、已撤销的留着当时的厂区名、地址、联系人、联系方式，只清厂区编号；待送货单取新客户默认厂区。
// 内存库、虚构数据；拆单的流水和经办记录见 order-edit-cascade.test.ts。
import { test } from 'node:test';
// 删除引擎要各模块登记的删除规则
import '../../server/import/index.js';
import assert from 'node:assert/strict';
import { sales } from '../../server/sales/index.js';
import { updateDocumentInfo } from '../../server/flow/index.js';
import { customerSchema } from '../../shared/core/domain.js';
import type { FlowDocView } from '../../shared/business/index.js';
import { splitDeliveryFixture } from '../support/maintenance-fixture.js';

/** 送货单的收货信息：厂区编号、厂区名、地址、联系人、联系方式 */
const destination = (d: Pick<FlowDocView<'delivery'>, 'siteId' | 'siteName' | 'address' | 'contact' | 'phone'>) => [
  d.siteId,
  d.siteName,
  d.address,
  d.contact,
  d.phone,
];
const east = { name: '虚构东厂', contact: '虚构王工', phone: '0001', address: '虚构一路', notes: '', isDefault: true };

/** 原客户带一个默认厂区“虚构东厂” */
function withSite(f: ReturnType<typeof splitDeliveryFixture>) {
  const own = sales(f.store).customer(f.customer.id);
  assert.ok(own);
  sales(f.store).updateCustomer(customerSchema.parse({ ...own, sites: [east] }), own.id, own.version);
}

test('订单换客户：已出库、已取消、已撤销的送货单留着当时的收货信息只清厂区编号，待送货单取新客户默认厂区；新客户没有厂区也一样', () => {
  const f = splitDeliveryFixture();
  try {
    withSite(f);
    const a = f.order([300, 300, 300, 300]);
    const shipped = f.ship([{ order: a }]);
    // 出库后用“编辑”改过收货地址、联系人、联系方式：改订单客户也要原样留着
    updateDocumentInfo(f.store, shipped.id, { expectedVersion: shipped.version, address: '虚构手写地址', contact: '虚构收货人', phone: '9999' }, f.who);
    const cancelled = f.pending([{ order: a, line: 1 }]);
    f.flow.cancel(cancelled.id, { version: cancelled.version, reason: '虚构：不送了', acknowledged: true }, f.who);
    const reversed = f.ship([{ order: a, line: 2 }]);
    f.undo(reversed.id);
    const waiting = f.pending([{ order: a, line: 3 }]);
    const kept = [shipped, cancelled, reversed].map((d) => destination(f.flow.get(d.id, 'delivery')));
    assert.deepEqual(kept[0].slice(1), ['虚构东厂', '虚构手写地址', '虚构收货人', '9999']);
    const bare = sales(f.store).createCustomer(customerSchema.parse({ name: '虚构没有厂区的客户' }));
    f.editOrder(a.id, { customerId: bare.id });
    [shipped, cancelled, reversed].forEach((d, i) =>
      assert.deepEqual(destination(f.flow.get(d.id, 'delivery')), [null, ...kept[i].slice(1)], d.number + ' 留着当时的收货信息'),
    );
    assert.deepEqual(destination(f.flow.get(waiting.id, 'delivery')), [null, '', '', '', ''], '待送货单取新客户默认厂区（没有就空）');
    const next = sales(f.store).createCustomer(customerSchema.parse({ name: '虚构有厂区的客户', address: '虚构新厂地址', contact: '虚构新联系人' }));
    f.editOrder(a.id, { customerId: next.id });
    const s = next.sites[0];
    assert.deepEqual(destination(f.flow.get(waiting.id, 'delivery')), [s.id, s.name, s.address, s.contact, s.phone]);
    assert.deepEqual(destination(f.flow.get(shipped.id, 'delivery')), [null, ...kept[0].slice(1)]);
  } finally {
    f.store.close();
  }
});

test('订单换客户拆合送单：拆出的已出库新单带原单的收货信息、厂区编号为空，拆出的待送货新单取新客户默认厂区', () => {
  const f = splitDeliveryFixture();
  try {
    withSite(f);
    const a = f.order([100, 100]),
      b = f.order([100, 100]);
    const shipped = f.ship([{ order: a }, { order: b }]);
    updateDocumentInfo(f.store, shipped.id, { expectedVersion: shipped.version, address: '虚构合送地址', contact: '虚构合送人', phone: '8888' }, f.who);
    f.pending([{ order: a, line: 1 }, { order: b, line: 1 }]);
    const original = destination(f.flow.get(shipped.id, 'delivery'));
    const other = sales(f.store).createCustomer(customerSchema.parse({ name: '虚构拆单客户', address: '虚构拆单厂址' }));
    f.editOrder(a.id, { customerId: other.id });
    const split = f.deliveries().filter((d) => d.customerId === other.id);
    const fromShipped = split.find((d) => d.status === 'confirmed'),
      fromWaiting = split.find((d) => d.status === 'draft');
    assert.ok(fromShipped && fromWaiting);
    assert.deepEqual(destination(fromShipped), [null, '虚构东厂', '虚构合送地址', '虚构合送人', '8888']);
    assert.deepEqual(destination(f.flow.get(shipped.id, 'delivery')), original, '原单留下的那张不动');
    const s = other.sites[0];
    assert.deepEqual(destination(fromWaiting), [s.id, s.name, s.address, s.contact, s.phone]);
  } finally {
    f.store.close();
  }
});
