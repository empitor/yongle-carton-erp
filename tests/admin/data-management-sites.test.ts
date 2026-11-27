// 数据管理里的客户厂区：用模板新建客户也按联系方式建默认厂区、只改客户厂区不动、送货单按所选厂区写收货信息，
// 编辑窗里厂区候选只列所选客户的、送货单换客户清空厂区（src/admin/field-update.ts）。虚构数据、内存库。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { AppError } from '../../server/core/index.js';
import { sales } from '../../server/sales/index.js';
import { DEFAULT_SITE_NAME } from '../../shared/core/index.js';
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
