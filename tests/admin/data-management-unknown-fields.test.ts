// 数据管理保存时，提交的内容里有录入结构不收的栏目（不管在第几层）要报错并说清是哪一格，不能保存成功却少了东西
// （server/admin/managed-save.ts、server/admin/input-fields.ts）；订单模板有“金额结算”这一格，带不足一分尾数的单价能建成。
import { sales } from '../../server/sales/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { OperationsService } from '../../server/operations/index.js';
import { FlowService } from '../../server/flow/index.js';
import { unknownFields } from '../../server/admin/input-fields.js';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { editableInput, submittedInput } from '../../src/admin/record-input.js';
import DataManagementFields from '../../src/admin/DataManagementFields.js';
import { basics, command, firstResult } from '../support/data-management-fixture.js';
import { actor } from '../support/actor-fixture.js';

/** 一套虚构数据加一个供应商 */
function withSupplier() {
  const f = basics();
  const supplier = new OperationsService(f.store).saveSupplier({ name: '虚构栏目供应商' }, actor);
  return { ...f, supplier };
}

test('数据管理新建采购单：明细里填了录入结构不收的“种类”“产品”，拒收并说清是哪一格，一张没建', () => {
  const f = withSupplier();
  try {
    const t = f.service.list('purchases', f.who).template;
    const line = { ...t.lines[0], name: '虚构纸板', quantity: '10', unitPrice: '1.5', length: 900, width: 700 };
    const patch = (extra: object) => ({ ...t, supplierId: f.supplier.id, lines: [{ ...line, ...extra }] });
    const before = f.service.list('purchases', f.who).records.length;
    assert.throws(
      () => f.service.execute(command('purchases', 'create', [], patch({ kind: 'finished', productId: f.product.id })), f.who, 's'),
      (e: unknown) => e instanceof Error && /明细第1项的种类/.test(e.message) && /明细第1项的产品/.test(e.message),
    );
    assert.equal(f.service.list('purchases', f.who).records.length, before, '一张也没建出来');
    // 照模板填的（模板里没有这两格）照常建成
    f.service.execute(command('purchases', 'create', [], patch({})), f.who, 's');
    assert.equal(f.service.list('purchases', f.who).records.length, before + 1);
  } finally {
    f.store.close();
  }
});

test('数据管理新建到货单：明细的纸板资料里填了“种类”“产品”，拒收并说清是哪一格，一张没建', () => {
  const f = withSupplier();
  try {
    const t = f.service.list('arrival', f.who).template;
    const item = { ...t.lines[0].item, name: '虚构到货纸板', length: 900, width: 700 };
    const patch = (extra: object) => ({
      ...t,
      supplierId: f.supplier.id,
      reference: '虚构送货单-1',
      lines: [{ ...t.lines[0], quantity: '10', item: { ...item, ...extra } }],
    });
    const flow = new FlowService(f.store);
    assert.throws(
      () => f.service.execute(command('arrival', 'create', [], patch({ kind: 'finished', productId: f.product.id })), f.who, 's'),
      (e: unknown) => e instanceof Error && /明细第1项的纸板的种类/.test(e.message) && /明细第1项的纸板的产品/.test(e.message),
    );
    assert.equal(flow.list('arrival', true).length, 0, '一张也没建出来');
    f.service.execute(command('arrival', 'create', [], patch({})), f.who, 's');
    assert.equal(flow.list('arrival', true).length, 1);
  } finally {
    f.store.close();
  }
});

test('数据管理改订单：明细里多一格拒收（页面和助手发来的都拦），顶层多一格照旧拒收，订单不变', () => {
  const f = basics();
  try {
    const listed = f.service.list('orders', f.who).records.find((r) => r.record.id === f.order.id);
    assert.ok(listed, '列表里有这张订单');
    const nested = { ...listed.input, notes: '不该存上', lines: [{ ...listed.input.lines[0], kind: 'finished' }] };
    for (const origin of ['management-ui', 'management-assistant'] as const)
      assert.throws(() => f.service.execute(command('orders', 'update', [listed.record], nested), f.who, 's', origin), /明细第1项的种类/, origin);
    // 认不出的栏目不露字段代码，只说有不认识的栏目
    assert.throws(
      () => f.service.execute(command('orders', 'update', [listed.record], { status2: '已确认' }), f.who, 's'),
      (e: unknown) => e instanceof Error && /有系统不认识的栏目/.test(e.message) && !/[A-Za-z]/.test(e.message),
    );
    assert.equal(sales(f.store).order(f.order.id, true)?.notes, '', '订单没改');
  } finally {
    f.store.close();
  }
});

test('数据管理新建订单：模板有“金额结算”这一格，单价带不足一分的尾数时选整单四舍五入到分就能建成', () => {
  const f = basics();
  try {
    const t = f.service.list('orders', f.who).template;
    assert.equal(t.roundingPolicy, 'exact-cents', '和订单页编辑窗一样，先是“精确到分，不自动舍入”');
    const order = (roundingPolicy: string) => ({
      ...t,
      roundingPolicy,
      customerId: f.customer.id,
      deliveryDate: '2026-12-31',
      lines: [{ ...t.lines[0], productId: f.product.id, quantity: 3, unitPriceCents: 123, unitPriceExact: '1.2345' }],
    });
    assert.throws(() => f.service.execute(command('orders', 'create', [], order('exact-cents')), f.who, 's'), /金额结算：.*不足一分/);
    const created = firstResult(f.service.execute(command('orders', 'create', [], order('half-up-cent')), f.who, 's'));
    assert.equal(sales(f.store).order(created.id, true)?.roundingPolicy, 'half-up-cent');
  } finally {
    f.store.close();
  }
});

test('数据管理编辑没存金额结算的订单：编辑窗照实显示“未填写”，没动这一格保存就不写；改成带尾数的单价时报错让人选，选了才写', () => {
  const f = basics();
  try {
    assert.equal(sales(f.store).order(f.order.id, true)?.roundingPolicy, undefined, '准备的订单库里没存金额结算');
    const listed = () => {
      const row = f.service.list('orders', f.who).records.find((r) => r.record.id === f.order.id);
      assert.ok(row);
      return row;
    };
    let row = listed();
    const shown = editableInput('orders', row.input);
    assert.equal(shown.roundingPolicy, null, '编辑窗里有这一格，下拉显示“未填写”');
    // 只改备注，整份交回：金额结算照旧没存
    f.service.execute(command('orders', 'update', [row.record], submittedInput('orders', { ...shown, notes: '虚构只改备注' }, row.input)), f.who, 's');
    assert.deepEqual([sales(f.store).order(f.order.id, true)?.notes, sales(f.store).order(f.order.id, true)?.roundingPolicy], ['虚构只改备注', undefined]);
    // 改成带尾数的单价、没选：拦下说去金额结算里选哪一项，不替人填
    row = listed();
    const fractional = { ...editableInput('orders', row.input), lines: [{ ...row.input.lines[0], quantity: 3, unitPriceExact: '1.2345' }] };
    assert.throws(
      () => f.service.execute(command('orders', 'update', [row.record], submittedInput('orders', fractional, row.input)), f.who, 's'),
      /金额结算：精确金额包含不足一分的尾数，请在金额结算里选“明确采用整单四舍五入到分”/,
    );
    f.service.execute(command('orders', 'update', [row.record], submittedInput('orders', { ...fractional, roundingPolicy: 'half-up-cent' }, row.input)), f.who, 's');
    assert.equal(sales(f.store).order(f.order.id, true)?.roundingPolicy, 'half-up-cent');
  } finally {
    f.store.close();
  }
});

/** 编辑窗里“金额结算”下拉的选项文字 */
function roundingOptions(input: Parameters<typeof editableInput>[1]) {
  const html = renderToStaticMarkup(
    h(DataManagementFields, { value: editableInput('orders', input), change: () => {}, module: 'orders', record: null, refs: null }),
  );
  const select = /<select aria-label="数据管理 金额结算"[^>]*>(.*?)<\/select>/.exec(html);
  assert.ok(select, '编辑窗里有金额结算这一格');
  return [...select[1].matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((m) => m[1]);
}

test('金额结算已经选过的订单：编辑窗下拉里没有“未填写”，不能清回没选（选了也存不上，不让人以为改了）；库里本来就空的才有', () => {
  const f = basics();
  try {
    const input = () => {
      const row = f.service.list('orders', f.who).records.find((r) => r.record.id === f.order.id);
      assert.ok(row);
      return row.input;
    };
    assert.deepEqual(roundingOptions(input()), ['未填写', '精确到分，不自动舍入', '明确采用整单四舍五入到分']);
    const row = f.service.list('orders', f.who).records.find((r) => r.record.id === f.order.id);
    assert.ok(row);
    f.service.execute(command('orders', 'update', [row.record], { roundingPolicy: 'exact-cents' }), f.who, 's');
    assert.deepEqual(roundingOptions(input()), ['精确到分，不自动舍入', '明确采用整单四舍五入到分']);
  } finally {
    f.store.close();
  }
});

test('录入结构不收的栏目逐层找：对象、数组每一行、可空和预处理包着的都查，结构里有的放过', () => {
  const schema = z.object({
    name: z.preprocess((v) => v ?? '', z.string()),
    costs: z.object({ basis: z.string() }).nullable().default(null),
    lines: z.array(z.object({ id: z.number().optional(), item: z.object({ name: z.string() }) })),
    tags: z.array(z.string()),
  });
  assert.deepEqual(unknownFields({ name: 'a', costs: null, lines: [{ item: { name: 'b' } }], tags: ['x'] }, schema), []);
  assert.deepEqual(
    unknownFields(
      { name: 'a', extra: 1, costs: { basis: '', other: 1 }, lines: [{ item: { name: 'b' } }, { id: 1, kind: 'raw', item: { name: 'c', productId: 2 } }] },
      schema,
    ),
    [['extra'], ['costs', 'other'], ['lines', 1, 'kind'], ['lines', 1, 'item', 'productId']],
  );
  // 不是对象、不是数组的值不往下查（留给校验去拦）
  assert.deepEqual(unknownFields({ lines: 'x', costs: 3 }, schema), []);
});
