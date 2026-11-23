// 确认卡片上的字逐字固定（server/assistant/tools/card-summary.ts）：几种典型卡片的标题和每一行原样比对。
// 卡片是人点确认前唯一看到的东西，改写法（拆函数、补类型）不能改一个字、一行的先后，也不能多列或少列字段。
import { sales } from '../server/sales/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { today } from '../shared/core/domain.js';
import { businessBase } from './business-base-fixture.js';
import { editableFields } from '../server/assistant/tools/card-summary.js';
import { InboxService } from '../server/inbox/service.js';
import { OrderBatchService } from '../server/operations/index.js';
import { FlowService } from '../server/flow/index.js';
import { autoConfirmAssistant } from './assistant-fixture.js';
import { superActor } from './actor-fixture.js';

type Line = { label: string; value: string };
const shown = (plan: { label: string; summary?: Line[] }) => [plan.label, ...(plan.summary ?? []).map((l) => l.label + '：' + l.value)];
const shownCard = (card: { title: string; lines: Line[] }) => [card.title, ...card.lines.map((l) => l.label + '：' + l.value)];
const saved = z.looseObject({ id: z.number(), version: z.number(), name: z.string() });
const numbered = z.looseObject({ id: z.number(), number: z.string() });

function setup() {
  const f = autoConfirmAssistant(),
    who = localAdministratorActor(superActor()),
    tools = f.manager.tools;
  const prepare = (tool: string, args: unknown) => tools.prepare(tool, args, who, 'card');
  const base = businessBase(who, f.store);
  const customer = (name: string) => base.customer({ name, phone: '222' });
  const product = (name: string) => base.product({ name });
  const order = (customerId: number, productId: number) =>
    base.order({ id: customerId }, [base.line({ id: productId }, 100)], { orderDate: '2026-10-01', deliveryDate: '2026-11-30' });
  // 采购库存的保存函数没有写返回类型，按用到的几列读出来
  const supplier = (name: string) => saved.parse(base.supplier({ name }));
  const rawItem = (name: string) => saved.parse(base.raw({ name }));
  const purchase = (fields: Record<string, unknown>) => numbered.parse(tools.ops.savePurchase(fields, who));
  return { f, who, tools, prepare, base, customer, product, order, supplier, rawItem, purchase };
}

test('每种记录人能改的字段（卡片上一个都不能漏）按参数结构读出来，字段和先后不变', () => {
  const fields = (module: string) => {
    const e = editableFields(module);
    return [[...e.top], [...e.lines]];
  };
  const party = ['name', 'contact', 'phone', 'address', 'notes'];
  assert.deepEqual(fields('customers'), [party, []]);
  assert.deepEqual(fields('suppliers'), [party, []]);
  assert.deepEqual(fields('products'), [
    ['name', 'length', 'width', 'height', 'dimensionUnit', 'dimensionUnitRaw', 'material', 'flute', 'requirements', 'priceCents', 'priceExact', 'customerProductCode', 'customerId', 'parentProductId'],
    [],
  ]);
  assert.deepEqual(fields('orders'), [
    ['customerId', 'orderDate', 'deliveryDate', 'status', 'notes', 'lines', 'costs', 'externalPurchaseOrder', 'supplierName', 'currency', 'taxRate', 'taxMode', 'terms', 'roundingPolicy'],
    ['id', 'productId', 'productName', 'specification', 'notes', 'quantity', 'unitPriceCents', 'unitPriceExact', 'customerProductCode', 'unit', 'taxRate', 'taxMode', 'deliveryDate'],
  ]);
  assert.deepEqual(fields('purchases'), [
    ['supplierId', 'customerOrderId', 'orderDate', 'expectedDate', 'status', 'notes', 'lines'],
    ['name', 'unit', 'specification', 'length', 'width', 'height', 'dimensionUnit', 'material', 'flute', 'notes', 'id', 'stockItemId', 'customerOrderId', 'quantity', 'priceBasis', 'unitPrice'],
  ]);
  assert.deepEqual(fields('stock_items'), [['name', 'kind', 'unit', 'specification', 'length', 'width', 'height', 'dimensionUnit', 'material', 'flute', 'notes', 'productId'], []]);
  assert.deepEqual(fields('arrival'), [
    ['date', 'notes', 'actualTime', 'supplierId', 'reference', 'sourceId', 'orderBatchId', 'lines'],
    ['stockId', 'purchaseLineId', 'item', 'quantity', 'acceptedQuantity', 'rejectedQuantity', 'stockedQuantity', 'statedQuantity', 'unitPrice', 'priceBasis', 'statedArea', 'differenceReason'],
  ]);
  assert.deepEqual(fields('delivery'), [
    ['date', 'notes', 'plannedDate', 'plannedTime', 'actualTime', 'customerId', 'address', 'contact', 'phone', 'allowOverdelivery', 'overdeliveryReason', 'lines'],
    ['orderId', 'orderLineId', 'stockId', 'quantity', 'notes'],
  ]);
  assert.deepEqual(fields('production'), [
    ['date', 'notes', 'taskId', 'productId', 'finishedStockId', 'goodQuantity', 'scrapQuantity', 'operator', 'materials'],
    ['stockId', 'issued', 'returned'],
  ]);
  assert.deepEqual(fields('task'), [['date', 'notes', 'plannedDate', 'plannedTime', 'productId', 'quantity', 'unit', 'orderIds'], []]);
  assert.deepEqual(fields('inbox'), [[], []]);
});

test('改档案和订单、归档恢复、数据管理的改：卡片逐字不变', () => {
  const { f, prepare, customer, product, order } = setup();
  try {
    const p = product('虚构纸箱甲'),
      other = product('虚构纸箱乙');
    const ca = customer('虚构客户甲'),
      oa = order(ca.id, p.id),
      ob = order(customer('虚构客户乙').id, p.id);
    assert.deepEqual(shown(prepare('records.propose_save', { module: 'orders', id: ob.id, patch: { deliveryDate: '2026-11-20' } })), [
      '修改订单：订单 ' + ob.number + '（虚构客户乙）',
      '记录：订单 ' + ob.number + '（虚构客户乙）',
      '交货日期：2026-11-30 → 2026-11-20',
    ]);
    assert.deepEqual(shown(prepare('records.propose_save', { module: 'customers', id: ca.id, patch: { phone: '13800000000' } })), [
      '修改客户：客户 虚构客户甲',
      '记录：客户 虚构客户甲',
      '联系方式：222 → 13800000000',
    ]);
    const lines = oa.lines.map((l) => ({ ...l, productId: other.id, taxRate: '13', notes: '虚构行备注' }));
    assert.deepEqual(shown(prepare('records.propose_save', { module: 'orders', id: oa.id, patch: { lines } })), [
      '修改订单：订单 ' + oa.number + '（虚构客户甲）',
      '记录：订单 ' + oa.number + '（虚构客户甲）',
      '明细：第 1 行（虚构纸箱乙）产品：虚构纸箱甲 → 虚构纸箱乙',
      '明细：第 1 行（虚构纸箱乙）备注：未填写 → 虚构行备注',
      '明细：第 1 行（虚构纸箱乙）本项税率：未填写 → 13%',
    ]);
    assert.deepEqual(shown(prepare('records.propose_save', { module: 'products', id: other.id, patch: { parentProductId: p.id, dimensionUnitRaw: '公分' } })), [
      '修改产品：产品 虚构纸箱乙',
      '记录：产品 虚构纸箱乙',
      '原文尺寸单位：未填写 → 公分',
      '附属于：无 → 虚构纸箱甲',
    ]);
    const ids = ['虚构客户丙', '虚构客户丁', '虚构客户戊'].map((n) => customer(n).id);
    assert.deepEqual(shown(prepare('records.propose_batch_lifecycle', { module: 'customers', ids, action: 'archive' })), [
      '批量归档客户：客户 虚构客户丙 等 3 条',
      '归档：客户 虚构客户丙、客户 虚构客户丁、客户 虚构客户戊（不删除，可以恢复）',
    ]);
    const archive = prepare('records.propose_lifecycle', { module: 'customers', id: ids[0], action: 'archive' });
    assert.deepEqual(shown(archive), ['归档客户：客户 虚构客户丙', '归档：客户 虚构客户丙（不删除，可以恢复）']);
    f.manager.tools.commit(archive, localAdministratorActor(superActor()), 'card');
    assert.deepEqual(shown(prepare('records.propose_lifecycle', { module: 'customers', id: ids[0], action: 'restore' })), [
      '恢复客户：客户 虚构客户丙',
      '恢复：客户 虚构客户丙（恢复后照常使用）',
    ]);
    const items = [{ id: ids[1], version: sales(f.store).customer(ids[1], true)?.version }];
    assert.deepEqual(shown(prepare('management.execute', { requestId: randomUUID(), module: 'customers', action: 'update', items, patch: { notes: '虚构' }, reason: '虚构维护' })), [
      '数据管理：修改客户 1 条：客户 虚构客户丁',
      '记录：客户 虚构客户丁',
      '备注：未填写 → 虚构',
      '原因：虚构维护',
    ]);
  } finally {
    f.close();
  }
});

test('新建：数据管理新建订单和客户、新建生产任务，卡片列全内容、不写单号，逐字不变', () => {
  const { f, prepare, customer, product } = setup();
  try {
    const c = customer('虚构客户乙'),
      p = product('虚构纸箱乙');
    const patch = { customerId: c.id, orderDate: '2026-11-14', deliveryDate: '2026-12-01', status: '待确认', notes: '', lines: [{ productId: p.id, quantity: 777, unit: '只', unitPriceCents: 12345 }] };
    assert.deepEqual(shown(prepare('management.execute', { requestId: randomUUID(), module: 'orders', action: 'create', items: [], reason: '虚构维护', patch })), [
      '数据管理：新建订单：订单（虚构客户乙）',
      '新建：订单（虚构客户乙）',
      '状态：待确认',
      '客户：虚构客户乙',
      '下单日期：2026-11-14',
      '交货日期：2026-12-01',
      '币种：人民币',
      '明细：虚构纸箱乙 777 只 × 123.45 元',
      '原因：虚构维护',
    ]);
    const party = { name: '虚构新客户', contact: '', phone: '555', address: '', notes: '' };
    assert.deepEqual(shown(prepare('management.execute', { requestId: randomUUID(), module: 'customers', action: 'create', items: [], reason: '虚构维护', patch: party })), [
      '数据管理：新建客户：客户 虚构新客户',
      '新建：客户 虚构新客户',
      '名称：虚构新客户',
      '联系方式：555',
      '原因：虚构维护',
    ]);
    assert.deepEqual(shown(prepare('records.propose_save', { module: 'production_tasks', patch: { date: '2026-11-14', productId: p.id, quantity: '120', unit: '只', orderIds: [] } })), [
      '新建生产任务：生产任务：虚构纸箱乙 120 只',
      '新建：生产任务：虚构纸箱乙 120 只',
      '状态：待生产',
      '登记日期：2026-11-14',
      '计划生产日期：2026-11-14',
      '产品：虚构纸箱乙',
      '数量：120 只',
    ]);
  } finally {
    f.close();
  }
});

test('到货、库存、生产任务、收件的卡片：单据每行、库存前后、状态和原因逐字不变', () => {
  const { f, who, tools, prepare, product, supplier, rawItem } = setup();
  try {
    const supplierId = supplier('虚构供应商').id,
      raw = rawItem('虚构纸板');
    const save = (quantity: string) =>
      tools.flow.save('arrival', { date: '2026-10-20', supplierId, reference: '虚构样品', lines: [{ stockId: raw.id, item: { name: raw.name, unit: '张' }, quantity }] }, who);
    const arrival = save('30'),
      title = '到货单 ' + arrival.number + '（虚构供应商）';
    const confirm = prepare('flow.propose_confirmation', { id: arrival.id });
    assert.deepEqual(shown(confirm), ['核对入库：' + title, '记录：' + title, '状态：待入库 → 已入库', '第 1 行：虚构纸板 30 张', '库存：虚构纸板：0 张 → 30 张（加 30 张）']);
    tools.commit(confirm, who, 'card');
    assert.deepEqual(shown(prepare('flow.edit_info', { id: arrival.id, notes: '虚构改备注' })), [
      '编辑到货单的说明（不动库存和金额）：' + title,
      '记录：' + title,
      '备注：未填写 → 虚构改备注',
      '第 1 行：虚构纸板 30 张',
    ]);
    assert.deepEqual(shown(prepare('inventory.propose_movement', { id: raw.id, action: 'adjust', quantity: '24', date: '2026-10-21', notes: '虚构盘点' })), [
      '盘点调整：原材料 虚构纸板',
      '记录：原材料 虚构纸板',
      '库存：虚构纸板：30 张 → 24 张（减 6 张）',
    ]);
    assert.deepEqual(shown(prepare('inventory.propose_movement', { id: raw.id, action: 'out', quantity: '5', date: '2026-10-21', notes: '虚构领用' })), [
      '手工出库：原材料 虚构纸板',
      '记录：原材料 虚构纸板',
      '库存：虚构纸板：30 张 → 25 张（减 5 张）',
    ]);
    assert.deepEqual(shown(prepare('flow.propose_reversal', { id: arrival.id, reason: '虚构登记重了' })), [
      '撤销这次到货：' + title,
      '记录：' + title,
      '状态：已入库 → 已撤销',
      '第 1 行：虚构纸板 30 张',
      '库存：虚构纸板：30 张 → 0 张（减 30 张）',
      '原因：虚构登记重了',
    ]);
    const pending = save('50'),
      pendingTitle = '到货单 ' + pending.number + '（虚构供应商）';
    const accepted = [{ ...pending.lines[0], acceptedQuantity: '40', rejectedQuantity: '10', stockedQuantity: '40' }];
    assert.deepEqual(shown(prepare('records.propose_save', { module: 'arrivals', id: pending.id, patch: { lines: accepted } })), [
      '修改到货：' + pendingTitle,
      '记录：' + pendingTitle,
      '明细：第 1 行（虚构纸板）验收合格数量：未填写 → 40 张',
      '明细：第 1 行（虚构纸板）拒收数量：未填写 → 10 张',
      '明细：第 1 行（虚构纸板）入库数量：未填写 → 40 张',
      '第 1 行：虚构纸板 50 张',
    ]);
    const task = tools.flow.save('task', { date: '2026-10-20', productId: product('虚构纸箱甲').id, quantity: '10', unit: '只', orderIds: [], notes: '' }, who);
    assert.deepEqual(shown(prepare('flow.schedule', { id: task.id, expectedVersion: task.version, plannedDate: '2026-11-02', requestId: randomUUID() })), [
      '调整计划日期：生产任务 ' + task.number,
      '记录：生产任务 ' + task.number,
      '计划生产日期：2026-10-20 → 2026-11-02',
      '产品：虚构纸箱甲 10 只',
    ]);
    assert.deepEqual(shown(prepare('flow.propose_cancel', { id: task.id, reason: '虚构取消' })), [
      '取消生产任务的剩余计划：生产任务 ' + task.number,
      '记录：生产任务 ' + task.number,
      '状态：待生产 → 已取消',
      '产品：虚构纸箱甲 10 只',
      '原因：虚构取消',
    ]);
    const item = new InboxService(f.store).ingest({ channel: 'manual', externalId: randomUUID(), kind: 'text', text: '虚构收件内容', receivedAt: '2026-11-01T00:00:00.000Z' });
    assert.deepEqual(shown(prepare('inbox.set_status', { id: Number(item.id), status: 'ignored', expectedVersion: item.version })), [
      '更新收件箱状态：收件 虚构收件内容',
      '记录：收件 虚构收件内容',
      '改成：已忽略',
    ]);
  } finally {
    f.close();
  }
});

test('送货出库、更正送货单、换订单、订单换客户：连带改到的记录和库存前后逐字不变', () => {
  const { f, who, tools, prepare, base, customer, product, order } = setup();
  try {
    const p = product('虚构纸箱甲'),
      ca = customer('虚构客户甲'),
      oa = order(ca.id, p.id);
    const stock = base.finished(p, { name: '虚构纸箱甲成品' }, { quantity: '500', date: '2026-10-20', notes: '虚构入库' });
    const draft = tools.flow.save('delivery', { date: today(), customerId: ca.id, lines: [{ orderId: oa.id, orderLineId: oa.lines[0].id, stockId: stock.id, quantity: '10' }] }, who);
    const title = '送货单 ' + draft.number + '（虚构客户甲）',
      orderTitle = '订单 ' + oa.number + '（虚构客户甲）';
    const ship = () => new FlowService(f.store).shipDelivery(draft.id, draft.version, who);
    assert.deepEqual(shownCard(tools.recordCard('delivery', draft.id, who, ship)), [title, '第 1 行：虚构纸箱甲 10 只', '库存：虚构纸箱甲：500 只 → 490 只（减 10 只）']);
    const confirm = prepare('flow.propose_confirmation', { id: draft.id });
    assert.deepEqual(shown(confirm), [
      '不导出直接出库：' + title,
      '记录：' + title,
      '状态：待送货 → 送货中',
      '第 1 行：虚构纸箱甲 10 只',
      '连带：' + orderTitle + ' 状态：已确认 → 部分发货',
      '库存：虚构纸箱甲：500 只 → 490 只（减 10 只）',
    ]);
    tools.commit(confirm, who, 'card');
    const d = tools.flow.get(draft.id);
    const correct = (line: Record<string, unknown>) => shown(prepare('delivery.correct', { id: d.id, expectedVersion: d.version, reason: '虚构点错', lines: [line] }));
    assert.deepEqual(correct({ index: 0, quantity: '30' }), [
      '更正送货单：' + title,
      '记录：' + title,
      '状态：送货中 → 已更正',
      '第 1 行：虚构纸箱甲 10 只 → 30 只',
      '订单 ' + oa.number + ' 已发：虚构纸箱甲 10 只 → 30 只（订货 100 只）',
      '送货金额：10.00 元 → 30.00 元',
      '连带：新建：送货单（虚构客户甲）：虚构纸箱甲 30 只',
      '连带：' + orderTitle + '：跟着更新（进度、合计这类由单据算出的内容）',
      '库存：虚构纸箱甲：490 只 → 470 只（减 20 只）',
      '原因：虚构点错',
    ]);
    const o2 = order(ca.id, p.id);
    assert.deepEqual(correct({ index: 0, quantity: '10', orderLineId: o2.lines[0].id }), [
      '更正送货单：' + title,
      '记录：' + title,
      '状态：送货中 → 已更正',
      '第 1 行：虚构纸箱甲 10 只（不变）',
      '订单 ' + oa.number + ' 已发：虚构纸箱甲 10 只 → 0 只（订货 100 只）',
      '订单 ' + o2.number + ' 已发：虚构纸箱甲 0 只 → 10 只（订货 100 只）',
      '连带：新建：送货单（虚构客户甲）：虚构纸箱甲 10 只',
      '连带：订单 ' + o2.number + '（虚构客户甲） 状态：已确认 → 部分发货',
      '连带：' + orderTitle + ' 状态：部分发货 → 已确认',
      '原因：虚构点错',
    ]);
    const items = [{ id: oa.id, version: sales(f.store).order(oa.id, true)?.version }];
    const patch = { customerId: customer('虚构客户乙').id };
    assert.deepEqual(shown(prepare('management.execute', { requestId: randomUUID(), module: 'orders', action: 'update', items, reason: '虚构维护', patch })), [
      '数据管理：修改订单 1 条：' + orderTitle,
      '记录：' + orderTitle,
      '客户：虚构客户甲 → 虚构客户乙',
      '连带：' + title + ' 客户：虚构客户甲 → 虚构客户乙',
      '原因：虚构维护',
    ]);
  } finally {
    f.close();
  }
});

test('采购单换供应商、订货单的到货安排和登记到货、一键清空：卡片逐字不变', () => {
  const { f, who, tools, prepare, supplier, rawItem, purchase: savePurchase } = setup();
  try {
    const supplierA = supplier('虚构纸板厂甲'),
      supplierB = supplier('虚构纸板厂乙'),
      raw = rawItem('虚构纸板甲');
    const purchase = savePurchase({ supplierId: supplierA.id, status: '已订货', orderDate: '2026-11-01', lines: [{ ...raw, stockItemId: raw.id, quantity: '1000', unitPrice: '2', priceBasis: 'quantity' }] });
    const title = '采购单 ' + purchase.number + '（虚构纸板厂甲）';
    assert.deepEqual(shownCard(tools.recordCard('purchases', purchase.id, who)), [title, '第 1 行：虚构纸板甲 1000 张']);
    const batches = new OrderBatchService(f.store),
      batchId = batches.batchIdOf(purchase.id) ?? 0,
      batch = batches.view(batchId),
      batchTitle = '订货单 ' + batch.number + '（虚构纸板厂甲）';
    assert.deepEqual(shown(prepare('records.propose_save', { module: 'purchases', id: purchase.id, patch: { supplierId: supplierB.id } })), [
      '修改采购单：' + title,
      '记录：' + title,
      '供应商：虚构纸板厂甲 → 虚构纸板厂乙',
      '连带：删除：' + batchTitle,
      '连带：新建：订货单（虚构纸板厂乙）：虚构纸板甲 1000 张',
    ]);
    const schedule = [{ row: 1, quantity: '600', dueDate: '2026-12-01' }, { row: 1, quantity: '400', dueDate: '2026-12-20' }];
    assert.deepEqual(shown(prepare('order_batch.schedule', { id: batchId, expectedVersion: batch.version, schedule })), [
      '改订货单 ' + batch.number + ' 的到货安排（不动库存）：' + batchTitle,
      '记录：' + batchTitle,
      '第 1 行（虚构纸板甲） 到货安排：1000 在 日期待定 前 → 600 在 2026-12-01 前；400 在 2026-12-20 前',
    ]);
    const receive = { id: batchId, expectedVersion: batch.version, requestId: randomUUID(), date: '2026-11-14', reference: 'RCV-1', rows: [{ row: 1, quantity: '400', rejectedQuantity: '10' }] };
    assert.deepEqual(shown(prepare('order_batch.receive', receive)), [
      '按订货单 ' + batch.number + ' 登记到货并入库：' + batchTitle,
      '记录：' + batchTitle,
      '第 1 行（虚构纸板甲） 已到：0 → 400 张',
      '本次到货（虚构纸板甲）：实到 400 张，拒收 10 张',
      '到货日期：2026-11-14',
      '供应商送货单号：RCV-1',
      '连带：新建：到货单（虚构纸板厂甲）：虚构纸板甲 400 张（拒收 10 张，入库 390 张）',
      '连带：' + title + ' 状态：待到货 → 部分到货',
      '库存：虚构纸板甲：0 张 → 390 张（加 390 张）',
    ]);
    assert.deepEqual(shown(prepare('management.reset', { scope: 'business' })), ['一键清空业务数据', '清空：一键清空业务数据，共 7 条记录']);
  } finally {
    f.close();
  }
});

test('采购退货和撤销退货：卡片逐字不变', () => {
  const { f, who, tools, prepare, supplier, rawItem } = setup();
  try {
    const raw = rawItem('虚构退货纸板');
    const arrival = tools.flow.save('arrival', { date: '2026-10-20', supplierId: supplier('虚构退货供应商').id, reference: '虚构退货', lines: [{ stockId: raw.id, item: { name: raw.name, unit: '张' }, quantity: '30' }] }, who);
    tools.commit(prepare('flow.propose_confirmation', { id: arrival.id }), who, 'card');
    const create = prepare('purchase_return.create', { arrivalId: arrival.id, date: '2026-10-22', reason: '虚构退货原因', lines: [{ lineIndex: 0, quantity: '5' }] });
    const title = '到货单 ' + arrival.number + '（虚构退货供应商）';
    assert.deepEqual(shown(create), [
      '采购退货：到货单 ' + arrival.number + ' 退 虚构退货纸板 5 张：' + title,
      '记录：' + title,
      '第 1 行：虚构退货纸板 30 张',
      '连带：新建：采购退货',
      '库存：虚构退货纸板：30 张 → 25 张（减 5 张）',
      '原因：虚构退货原因',
    ]);
    tools.commit(create, who, 'card');
    const returned = numbered.extend({ version: z.number() }).parse(f.store.db.prepare('SELECT id,number,version FROM purchase_returns').get());
    // 采购退货的状态在修改历史那套里还没有叫法：卡片上写的是“有改动但列不出明细”那句
    const name = '采购退货 ' + returned.number;
    assert.deepEqual(shown(prepare('purchase_return.reverse', { id: returned.id, version: returned.version, reason: '虚构退错了' })), [
      '撤销' + name,
      '记录：' + name,
      name + '：有改动但列不出明细',
      '库存：虚构退货纸板：25 张 → 30 张（加 5 张）',
      '原因：虚构退错了',
    ]);
  } finally {
    f.close();
  }
});
