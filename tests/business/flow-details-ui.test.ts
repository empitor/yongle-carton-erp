// 单据的详情（src/flow/FlowDetails.tsx、FlowDocSections.tsx）：库存页、归档、单据窗口、核对窗同一份。
// 到货明细的入库数、到货送货有台账记录时的验收入库和流水、正文顺序、生产任务的完工进度。只渲染，不碰数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { flowViewSchema, type ArrivalDaily, type FlowDocView } from '../../shared/business/index.js';
import FlowDetails, { flowSubtitle } from '../../src/flow/FlowDetails.js';
import { uniqueMovementRows } from '../../src/flow/FlowDocSections.js';

/** 单据行上的列：编号、单号、经手人、时间、没归档 */
const row = (id: number, number: string, status: string) => ({
  id,
  number,
  status,
  version: 1,
  actorName: '虚构经办人',
  createdAt: '2026-11-01T02:00:00.000Z',
  updatedAt: '2026-11-01T02:00:00.000Z',
  archived: false,
});

test('已取消的待入库到货单：明细的入库数写“—”，不写“核对时算”（不会再核对了）', () => {
  const arrival = (status: string) =>
    flowViewSchema('arrival').parse({
      ...row(5, 'DH-虚构-5', status),
      kind: 'arrival',
      date: '2026-11-01',
      supplierId: 3,
      reference: 'SD-虚构-1',
      lines: [{ item: { name: '虚构E三层' }, quantity: '100' }],
    });
  const render = (status: string) => renderToStaticMarkup(h(FlowDetails, { doc: arrival(status), data: {} }));
  assert.match(render('draft'), /核对时算/);
  const cancelled = render('cancelled');
  assert.doesNotMatch(cancelled, /核对时算/);
  assert.match(cancelled, /— \/ — \/ —/);
});

test('生产任务登记了待入库的完工单：完工进度后面写明另有多少已登记、待核对入库', () => {
  const task = (completed: string, pendingCompleted: string) =>
    flowViewSchema('task').parse({
      ...row(7, 'SC-虚构-7', 'confirmed'),
      kind: 'task',
      date: '2026-11-01',
      plannedDate: '2026-11-03',
      productId: 2,
      quantity: '100',
      actualDate: null,
      hasProduction: true,
      actualStartDate: null,
      actualCompletionDate: null,
      completed,
      pendingCompleted,
      progress: Number(completed),
    });
  const render = (completed: string, pending: string) =>
    renderToStaticMarkup(h(FlowDetails, { doc: task(completed, pending), data: {} }));
  assert.match(render('0', '60'), /0 \/ 100 只（另有 60 只已登记、待核对入库）/);
  // 没有待入库的照旧，不加括号
  assert.doesNotMatch(render('40', '0'), /另有/);
});

/** 已入库的到货单（挂采购单 CG-虚构-2），和它在台账里的样子：两行，第二行万一也挂了同一笔入库流水 */
function stockedArrival(archived: boolean) {
  const doc = flowViewSchema('arrival').parse({
    ...row(6, 'DH-虚构-6', 'confirmed'),
    archived,
    kind: 'arrival',
    date: '2026-11-02',
    supplierId: 3,
    supplierName: '虚构供应商',
    reference: 'SD-虚构-2',
    lines: [0, 1].map(() => ({
      item: { name: '虚构E三层' },
      quantity: '100',
      acceptedQuantity: '100',
      rejectedQuantity: '0',
      stockedQuantity: '100',
      purchaseLineId: 4,
      purchaseId: 2,
      purchaseNumber: 'CG-虚构-2',
    })),
  });
  const { id: _id, number: _number, status, version, actorName, createdAt, updatedAt: _u, archived: _a, ...document } = doc;
  const movement = { id: 31, date: '2026-11-02', delta_units: 100_000, notes: '' };
  const line = {
    index: 0,
    lineId: 4,
    purchaseId: 2,
    stockId: 1,
    quantity: '100',
    acceptedQuantity: '100',
    rejectedQuantity: '0',
    stockedQuantity: '100',
    item: doc.lines[0].item,
    unitPrice: null,
    priceBasis: 'area' as const,
    amount: null,
    inventoryMismatch: false,
    purchaseNumber: 'CG-虚构-2',
    orderedQuantity: '200',
    receivedQuantity: '200',
    remainingQuantity: '0',
    arrivalStatus: '已到齐' as const,
    movements: [movement],
  };
  const record: ArrivalDaily = {
    id: 'flow-6',
    flowId: 6,
    number: doc.number,
    version,
    reference: doc.reference,
    date: doc.date,
    status,
    effective: true,
    supplierId: 3,
    supplierName: '虚构供应商',
    actorName,
    createdAt,
    correctionOf: null,
    replacedBy: null,
    reversal: null,
    document,
    actualTime: null,
    movements: [movement],
    inspectionStatus: '全部合格',
    inventoryStatus: '已入库',
    actualDate: doc.date,
    plannedDate: null,
    completed: true,
    cancelled: false,
    pending: false,
    lines: [line, { ...line, index: 1 }],
  };
  return { doc, record };
}

test('已归档的到货单详情和在用的一样：有验收 / 入库、采购单链接和入库流水，同一笔流水只列一次', () => {
  for (const archived of [false, true]) {
    const { doc, record } = stockedArrival(archived);
    const html = renderToStaticMarkup(h(FlowDetails, { doc, data: {}, record }));
    assert.match(html, /验收 \/ 入库.*全部合格 · 已入库/, '归档 ' + archived);
    assert.match(html, /<a class="nowrap" href="#purchases\?record=2">CG-虚构-2<\/a> · 订 200 · 已到 200/);
    const flows = html.split('入库流水')[1] || '';
    assert.equal((flows.match(/<tr[ >]/g) || []).length, 2, '表头一行 + 一笔流水');
  }
  assert.deepEqual(uniqueMovementRows([{ m: { id: 'x' } }, { m: { id: 'x' } }, { m: { id: 'y' } }]).map((r) => r.m.id), ['x', 'y']);
});

test('到货单详情的顺序照界面总规矩：明细 → 基本信息 → 流水；核对窗里没有台账记录，不列验收入库和流水，到货日期写明待核对入库', () => {
  const { doc, record } = stockedArrival(false);
  const html = renderToStaticMarkup(h(FlowDetails, { doc, data: {}, record }));
  const at = (text: string) => html.indexOf(text);
  assert.ok(at('到货明细') < at('基本信息') && at('基本信息') < at('入库流水'));
  const draft = flowViewSchema('arrival').parse({ ...doc, status: 'draft', lines: [{ item: { name: '虚构E三层' }, quantity: '100' }] });
  const review = renderToStaticMarkup(h(FlowDetails, { doc: draft, data: {} }));
  assert.doesNotMatch(review, /验收 \/ 入库|入库流水/);
  assert.match(review, /2026-11-02<\/span> · 待核对入库/);
});

test('到货单、送货单的经办人：有确认人写确认人，没有（待入库、待送货）才写登记人', () => {
  const { doc } = stockedArrival(false);
  const person = (d: FlowDocView) => /经办人<\/dt><dd[^>]*>([^<]+)</.exec(renderToStaticMarkup(h(FlowDetails, { doc: d, data: {} })))?.[1];
  assert.equal(person({ ...doc, confirmedBy: '虚构确认人' }), '虚构确认人');
  assert.equal(person({ ...doc, status: 'draft' }), '虚构经办人');
});

test('送货单详情标题下面那行写客户和几种产品（和到货写供应商和几种纸板一样）', () => {
  const delivery: FlowDocView = flowViewSchema('delivery').parse({
    ...row(9, 'SH-虚构-9', 'draft'),
    kind: 'delivery',
    date: '2026-11-01',
    plannedDate: '2026-11-01',
    actualDate: null,
    customerId: 1,
    customerName: '虚构客户',
    address: '虚构地址',
    lines: [{ orderId: 1, orderLineId: 1, stockId: 1, quantity: '1' }],
  });
  assert.equal(flowSubtitle(delivery, {}), '虚构客户 · 1 种产品');
});
