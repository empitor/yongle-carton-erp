// 数据管理里的客户厂区：用模板新建客户也按联系方式建默认厂区、只改客户厂区不动、送货单按所选厂区写收货信息，
// 编辑窗里厂区候选只列所选客户的、送货单换客户清空厂区（src/admin/field-update.ts）。虚构数据、内存库。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AppError } from '../../server/core/index.js';
import { sales } from '../../server/sales/index.js';
import { DEFAULT_SITE_NAME } from '../../shared/core/index.js';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import DataManagementFields from '../../src/admin/DataManagementFields.js';
import { refOptions } from '../../src/admin/field-rules.js';
import { withField } from '../../src/admin/field-update.js';
import { buildRefs } from '../../src/admin/record-refs.js';
import { manualWrite } from '../support/business-base-fixture.js';
import { basics, command, firstResult } from '../support/data-management-fixture.js';
import { splitDeliveryFixture } from '../support/maintenance-fixture.js';
import { must } from '../support/read-result.js';

const east = { name: '虚构东厂', contact: '王工', phone: '0001', address: '虚构一路', notes: '', isDefault: true };
const west = { name: '虚构西厂', contact: '李工', phone: '0002', address: '虚构二路', notes: '', isDefault: false };
const viaJsonList = (value: unknown) => z.array(z.record(z.string(), z.json())).parse(JSON.parse(JSON.stringify(value)));

test('数据管理用模板新建客户、只填联系方式：和编辑窗一样建一个默认厂区', () => {
  const f = basics();
  try {
    const t = f.service.list('customers', f.who).template;
    const res = f.service.execute(command('customers', 'create', [], { ...t, name: '虚构数据管理客户', contact: '王工', phone: '0001' }), f.who, 's');
    const created = must(sales(f.store).customer(firstResult(res).id), '新建的客户');
    assert.deepEqual(created.sites.map(({ id: _id, ...s }) => s), [
      { name: DEFAULT_SITE_NAME, contact: '王工', phone: '0001', address: '', isDefault: true, notes: '' },
    ]);
  } finally {
    f.store.close();
  }
});

/** 一个有东西两厂的客户、一个只有东厂的别家客户；listed 读数据管理列表里的那条 */
function sitesFixture() {
  const f = splitDeliveryFixture();
  const other = manualWrite(f.store, { entity: 'customers', action: 'create', input: { name: '虚构别家客户', sites: [east] } }, f.who);
  const now = must(sales(f.store).customer(f.customer.id), '客户');
  const customer = manualWrite(f.store, { entity: 'customers', action: 'update', id: now.id, input: { ...now, sites: [east, west] } }, f.who);
  const listed = (m: string, id: number) =>
    must(f.dataManagement.list(m, f.who).records.find((r) => r.record.id === id), m + ' ' + id).record;
  return { ...f, other, customer, listed };
}

test('数据管理里的厂区：只改客户名称厂区不动；待送货单按所选厂区写收货信息，换厂区跟着换，别家客户的厂区报 400', () => {
  const f = sitesFixture(), dm = f.dataManagement, { customer } = f;
  try {
    dm.execute(command('customers', 'update', [f.listed('customers', customer.id)], { name: '虚构改名客户' }), f.who, 's');
    assert.deepEqual(must(sales(f.store).customer(customer.id), '改名后的客户').sites, customer.sites);
    const order = f.order([300]);
    const tpl = dm.list('delivery', f.who).template;
    const input = (siteId: number) => ({
      ...tpl,
      customerId: customer.id,
      siteId,
      lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: f.finished.id, quantity: '10', notes: '' }],
    });
    const destination = (id: number) => {
      const d = f.flow.get(id, 'delivery');
      return [d.siteId, d.siteName, d.address, d.contact, d.phone];
    };
    const id = firstResult(dm.execute(command('delivery', 'create', [], input(customer.sites[1].id)), f.who, 's')).id;
    assert.deepEqual(destination(id), [customer.sites[1].id, west.name, west.address, west.contact, west.phone]);
    dm.execute(command('delivery', 'update', [f.listed('delivery', id)], { siteId: customer.sites[0].id }), f.who, 's');
    assert.deepEqual(destination(id), [customer.sites[0].id, east.name, east.address, east.contact, east.phone]);
    assert.throws(
      () => dm.execute(command('delivery', 'create', [], input(f.other.sites[0].id)), f.who, 's'),
      (e: unknown) => e instanceof AppError && e.status === 400 && /不属于这个客户/.test(e.message),
    );
    // 待送货单直接写收货地址：说清是厂区带出的、去改选收货厂区，不说“系统算出来的”
    assert.throws(
      () => dm.execute(command('delivery', 'update', [f.listed('delivery', id)], { address: '虚构手填地址' }), f.who, 's'),
      (e: unknown) => e instanceof Error && /收货地址：由所选收货厂区带出/.test(e.message) && /改选收货厂区/.test(e.message)
        && !/系统算出来/.test(e.message),
    );
  } finally {
    f.store.close();
  }
});

test('数据管理编辑窗：收货厂区只列这张送货单所选客户的厂区，送货单换了客户清空厂区，别的改动不碰厂区', () => {
  const f = sitesFixture(), { customer } = f;
  try {
    const refs = buildRefs({ customers: viaJsonList(f.dataManagement.list('customers', f.who).records.map((r) => r.record)) });
    const ctx = { module: 'delivery', record: null, refs };
    const sitesOf = (customerId: number) => refOptions('siteId', null, ctx, { customerId }).map((o) => [o.value, o.label]);
    assert.deepEqual(sitesOf(customer.id), [['', '使用默认厂区'], ...customer.sites.map((s) => [String(s.id), s.name])]);
    assert.deepEqual(sitesOf(f.other.id), [['', '使用默认厂区'], [String(f.other.sites[0].id), east.name]]);
    const line = { customerId: customer.id, siteId: customer.sites[1].id, notes: '' };
    assert.deepEqual(withField(line, 'customerId', f.other.id, 'delivery'), { customerId: f.other.id, siteId: null, notes: '' });
    assert.deepEqual(withField(line, 'customerId', customer.id, 'delivery'), line);
    assert.deepEqual(withField(line, 'notes', '虚构备注', 'delivery'), { ...line, notes: '虚构备注' });
    assert.deepEqual(withField(line, 'customerId', f.other.id, 'orders'), { ...line, customerId: f.other.id });
  } finally {
    f.store.close();
  }
});

test('数据管理厂区下拉的空选项按单据说：待送货单“使用默认厂区”，客户没厂区、已生效的单各说各的', () => {
  const f = sitesFixture(), { customer } = f;
  try {
    const bare = manualWrite(f.store, { entity: 'customers', action: 'create', input: { name: '虚构没厂区客户' } }, f.who);
    const refs = buildRefs({ customers: viaJsonList(f.dataManagement.list('customers', f.who).records.map((r) => r.record)) });
    const blankOf = (id: number | null, customerId: number | null) =>
      refOptions('siteId', null, { module: 'delivery', record: id ? f.listed('delivery', id) : null, refs }, { customerId })[0].label;
    // 新建还没选客户：说先选客户，不说这个客户没有厂区
    assert.equal(blankOf(null, null), '先选客户');
    const order = f.order([300]);
    const input = { customerId: customer.id };
    const pending = f.pending([{ order, quantity: '5' }], input), shipped = f.ship([{ order, quantity: '6' }], input);
    assert.deepEqual([blankOf(null, customer.id), blankOf(pending.id, customer.id)], ['使用默认厂区', '使用默认厂区']);
    assert.equal(blankOf(null, bare.id), '这个客户还没有厂区');
    assert.equal(blankOf(shipped.id, customer.id), '未关联厂区（保留单上的收货信息）');
  } finally {
    f.store.close();
  }
});

test('数据管理编辑客户的厂区：每项写“厂区 N”，按钮叫“新增厂区”“删除厂区”，不叫“增加明细”“移除本项”', () => {
  const value = { name: '虚构客户', sites: [{ ...east, id: 1 }, { ...west, id: 2 }] };
  const html = renderToStaticMarkup(h(DataManagementFields, { value, change: () => {}, module: 'customers', record: null, refs: {} }));
  assert.match(html, /厂区 1/);
  assert.match(html, /厂区 2/);
  assert.equal((html.match(/删除厂区/g) || []).length, 2);
  assert.match(html, /新增厂区/);
  assert.doesNotMatch(html, /增加明细|移除本项|第1项/);
});

test('数据管理改订单：明细的产品只列这张订单客户的和没定客户的，原来选的别家产品照名称显示，不写“已找不到”', () => {
  const product = (id: number, name: string, customerId: number | null) =>
    ({ id, name, customerId, customerName: customerId ? '虚构客户' + customerId : null });
  const refs = buildRefs({ products: viaJsonList([product(1, '虚构甲的箱', 1), product(2, '虚构乙的箱', 2), product(3, '虚构通用箱', null)]) });
  const ctx = (customerId: number) => ({ module: 'orders', record: null, refs, form: { customerId, lines: [] } });
  const names = (customerId: number, current: number | null) =>
    refOptions('productId', current, ctx(customerId), { productId: current }).map((o) => o.label);
  assert.deepEqual(names(1, null), ['虚构甲的箱', '虚构通用箱']);
  assert.deepEqual(names(2, null), ['虚构乙的箱', '虚构通用箱']);
  assert.deepEqual(names(1, 2), ['虚构甲的箱', '虚构通用箱', '虚构乙的箱']);
});
