// 按模块读记录只有一份（server/business/module-records.ts）：数据管理的列表和助手查记录补的名称一样——
// 单据上记了名字的用记的，没记的按档案补；到货单另补订货单号和原件文件名。助手的模块名和全站记录种类的对照只有一份
// （shared/assistant/assistant-modules.ts），页面报全站记录种类，助手换成自己的模块。内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { actor } from './actor-fixture.js';
import { businessBase } from './business-base-fixture.js';
import { toolsOf } from './assistant-fixture.js';
import { readAs, must } from './read-result.js';
import { receiveLines } from './receive-fixture.js';
import { namedDocuments } from '../server/business/index.js';
import { DataManagementService } from '../server/admin/index.js';
import { insertSource } from '../server/flow/index.js';
import { assistantModules, moduleOfRecord, recordKindOf, stockKindOf } from '../shared/assistant/index.js';
import { dataManagementModules } from '../shared/business/index.js';
import { productSchema, stockKinds } from '../shared/core/index.js';

const got = { record: z.looseObject({}), url: z.string() };

function setup() {
  const base = businessBase(actor);
  const supplier = base.supplier({ name: '虚构供应商甲' }),
    product = base.product({ name: '虚构纸箱甲' }),
    raw = base.raw({ name: '虚构纸板甲' });
  return { base, store: base.store, flow: base.flow, tools: toolsOf(base.store), supplier, product, raw };
}

test('没记名字的单据（待入库的到货单、生产任务）按档案补名称：数据管理的列表和助手读到的一样', (t) => {
  const { base, store, flow, tools, supplier, product, raw } = setup();
  t.after(() => store.close());
  const arrival = flow.save('arrival', { date: '2026-10-20', supplierId: supplier.id, reference: '虚构样品', lines: [{ stockId: raw.id, item: { name: raw.name, unit: '张' }, quantity: '3' }] }, actor);
  const task = flow.save('task', { date: '2026-10-20', productId: product.id, quantity: '10', unit: '只', orderIds: [], notes: '' }, actor);
  assert.equal(must(namedDocuments(flow, 'arrival', true, [arrival.id])[0], '到货单').supplierName, '虚构供应商甲');
  const listed = new DataManagementService(store).records.list('arrival').find((r) => r.record.id === arrival.id);
  assert.equal(must(listed, '数据管理里的到货单').record.supplierName, '虚构供应商甲');
  const taskName = must(namedDocuments(flow, 'task', true, [task.id])[0], '生产任务').productName;
  assert.equal(taskName, '虚构纸箱甲');
  const viaAssistant = readAs(tools.read('records.get', { module: 'production_tasks', id: task.id }, actor), { record: z.looseObject({ productName: z.string() }) });
  assert.equal(viaAssistant.record.productName, taskName);
  assert.equal(base.ops.items(true, raw.id)[0].name, '虚构纸板甲');
});

test('单据上记了名字的用记的：产品改名以后，生产任务在数据管理和助手里都还是单据上记的那个名字', (t) => {
  const { store, flow, tools, product } = setup();
  t.after(() => store.close());
  const task = flow.save('task', { date: '2026-10-20', productId: product.id, quantity: '10', unit: '只', orderIds: [], notes: '' }, actor);
  assert.equal(flow.get(task.id, 'task').productName, '虚构纸箱甲', '生产任务下达时记下产品名');
  store.saveProduct(productSchema.parse({ name: '虚构改名后的纸箱' }), product.id, product.version);
  const expected = '虚构纸箱甲';
  assert.equal(must(namedDocuments(flow, 'task', true, [task.id])[0], '生产任务').productName, expected);
  const viaAssistant = readAs(tools.read('records.get', { module: 'production_tasks', id: task.id }, actor), { record: z.looseObject({ productName: z.string() }) });
  assert.equal(viaAssistant.record.productName, expected);
});

test('到货单补订货单号和原件文件名（编辑窗显示单号和文件名，不露内部编号）', (t) => {
  const { base, store, flow, supplier, raw } = setup();
  t.after(() => store.close());
  const purchase = z
    .looseObject({ id: z.number(), lines: z.array(z.looseObject({ id: z.number() })) })
    .parse(base.ops.savePurchase({ supplierId: supplier.id, status: '已订货', orderDate: '2026-11-01', lines: [{ ...raw, stockItemId: raw.id, quantity: '100', unitPrice: '1', priceBasis: 'quantity' }] }, actor));
  receiveLines(store, purchase.id, { date: '2026-11-02', items: [{ lineId: purchase.lines[0].id, quantity: '10' }] }, actor);
  const sourceId = randomUUID();
  const bytes = new Uint8Array([1, 2, 3]);
  insertSource(store, { id: sourceId, kind: 'arrival', fileName: '虚构送货单.png', hash: createHash('sha256').update(bytes).digest('hex'), format: 'png', bytes, document: { result: null, kind: 'arrival' }, actor });
  flow.save('arrival', { date: '2026-11-03', supplierId: supplier.id, reference: '虚构识别', sourceId, lines: [{ stockId: raw.id, item: { name: raw.name, unit: '张' }, quantity: '2' }] }, actor);
  const arrivals = new DataManagementService(store).records.list('arrival');
  const batched = must(arrivals.find((r) => r.record.orderBatchId != null), '登记到货的到货单');
  assert.match(String(batched.record.orderBatchNumber), /\S/);
  assert.equal(must(arrivals.find((r) => r.record.sourceId === sourceId), '识别来的到货单').record.sourceFileName, '虚构送货单.png');
});

test('助手按编号读一笔流水：和列表里那一笔一样；没有这笔流水按读不到报', (t) => {
  const { base, store, tools, raw } = setup();
  t.after(() => store.close());
  base.stockIn(raw, { quantity: '5', date: '2026-10-20' });
  base.stockIn(raw, { quantity: '7', date: '2026-10-20' });
  base.stockIn(raw, { quantity: '9', date: '2026-10-21' });
  const listed = readAs(tools.read('records.search', { module: 'movements' }, actor), { results: z.array(z.object(got)) }).results;
  assert.equal(listed.length, 3);
  for (const row of listed) {
    const id = String(row.record.id);
    assert.deepEqual(readAs(tools.read('records.get', { module: 'movements', id }, actor), got), row);
  }
  assert.throws(() => tools.read('records.get', { module: 'movements', id: randomUUID() }, actor), /记录不存在/);
});

test('页面报全站记录种类：库存品按这一条是原材料还是成品换成助手的模块，单据按种类换', (t) => {
  const { base, store, flow, tools, product, raw } = setup();
  t.after(() => store.close());
  const finished = base.finished(product, { name: '虚构成品甲' });
  const task = flow.save('task', { date: '2026-10-20', productId: product.id, quantity: '10', unit: '只', orderIds: [], notes: '' }, actor);
  const urlOf = (record: (typeof dataManagementModules)[number], id: number) => readAs(tools.pageRecord(record, id, actor), got).url;
  assert.match(urlOf('stock_items', raw.id), /^#warehouse\?kind=raw&/);
  assert.match(urlOf('stock_items', finished.id), /^#warehouse\?kind=finished&/);
  assert.equal(urlOf('task', task.id), '#production?doc=' + task.id);
  assert.match(urlOf('products', product.id), /^#products\?q=/);
  assert.throws(() => tools.pageRecord('stock_items', raw.id + 999, actor), /记录不存在/);
});

test('模块叫法对照只有一份：每个助手模块换成全站记录种类再换回来还是它，页面会报的每种记录都有助手模块', () => {
  for (const m of assistantModules) assert.equal(moduleOfRecord(recordKindOf(m), stockKindOf(m)), m);
  for (const record of dataManagementModules) {
    const kinds = record === 'stock_items' ? stockKinds : [undefined];
    for (const kind of kinds) assert.ok(moduleOfRecord(record, kind), record + (kind ?? ''));
  }
});
