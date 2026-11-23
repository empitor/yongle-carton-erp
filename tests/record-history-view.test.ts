// 修改历史怎么显示（shared/business/overview/record-history.ts 的 historyView）：只列变了的项、引用换成名称、状态用界面叫法、
// 认不出的只说一句。纯函数、虚构数据。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { historyView, historyActionName } from '../shared/business/index.js';
import { HISTORY_NO_CHANGE, HISTORY_UNKNOWN } from '../shared/business/overview/record-history.js';
import { historyActionNames } from '../shared/business/overview/history-fields.js';
import { assertClean, C, F, GONE, ids, L, O, P, refs, row, S, T } from './history-fixture.js';

const production = (over: Record<string, unknown> = {}) => ({
  id: 41,
  kind: 'production',
  number: 'DJ-20261113-00030',
  status: 'draft',
  version: 3,
  date: '2026-11-13',
  notes: '第二批',
  correctionOf: null,
  taskId: T,
  productId: P,
  productName: '虚构五金箱',
  finishedStockId: F,
  goodQuantity: '300',
  scrapQuantity: '3',
  operator: '老王',
  materials: [{ stockId: S, issued: '310', returned: '0' }],
  sourceId: null,
  updatedAt: '2026-11-13T09:50:42.000Z',
  ...over,
});

test('新建：列出主要内容，引用换成名称，状态用界面叫法', () => {
  const view = historyView({ module: 'production', action: 'create-draft', detail: { before: null, after: production() } }, refs);
  assertClean(view, '新建完工单', ids);
  assert.deepEqual(row(view, '状态'), ['待入库']);
  assert.deepEqual(row(view, L('taskId')), ['SC-20261106-00013']);
  assert.deepEqual(row(view, L('productId')), ['虚构五金箱']);
  assert.deepEqual(row(view, L('finishedStockId')), ['虚构五金箱']);
  assert.deepEqual(row(view, L('goodQuantity')), ['300 只']);
  assert.deepEqual(row(view, L('materials')), ['虚构五层纸板 领 310 张']);
  assert.equal(view.note, undefined);
});

test('整条 before/after：只列变了的项，确认只说状态变化', () => {
  const update = historyView(
    { module: 'production', action: 'update-draft', detail: { before: production(), after: production({ scrapQuantity: '0', version: 4 }) } },
    refs,
  );
  assertClean(update, '修改完工单', ids);
  assert.deepEqual(update.items, [{ label: L('scrapQuantity'), value: '3 只 → 0 只' }]);
  const confirm = historyView(
    {
      module: 'production',
      action: 'confirm',
      detail: {
        before: production(),
        after: production({ status: 'confirmed', confirmedBy: '虚构', movements: ['12'], materials: [{ stockId: S, issued: '310', returned: '5' }] }),
        plan: { changes: [{ stockId: S, deltaUnits: -310000 }] },
        previewDigest: 'a'.repeat(64),
        sourceHash: 'abc',
      },
    },
    refs,
  );
  assertClean(confirm, '确认完工单', ids);
  assert.deepEqual(confirm.items, [{ label: '状态', value: '待入库 → 已入库' }]);
});

test('局部修改：改说明（批次备注）、调整计划日期', () => {
  const note = historyView(
    {
      module: 'production',
      action: 'edit-info',
      detail: { number: 'DJ-20261108-00014', before: { notes: '纸板受潮' }, after: { notes: '已和客户说明' }, version: 6 },
    },
    refs,
  );
  assertClean(note, '编辑说明');
  // 完工单的备注和详情一样叫“批次备注”
  assert.deepEqual(note.items, [{ label: '批次备注', value: '纸板受潮 → 已和客户说明' }]);
  const cleared = historyView(
    { module: 'production', action: 'edit-info', detail: { number: 'X', before: { notes: '旧' }, after: { notes: '' }, version: 2 } },
    refs,
  );
  assert.deepEqual(cleared.items, [{ label: '批次备注', value: '旧 → 未填写' }]);
  const task = { id: 5, kind: 'task', status: 'confirmed', productId: P, productName: '虚构五金箱', quantity: '100', unit: '只', orderIds: [O], completed: '0', plannedDate: '2026-11-10' };
  const schedule = historyView(
    { module: 'task', action: 'schedule', detail: { before: task, after: { ...task, plannedDate: '2026-11-12' }, requestId: randomUUID() } },
    refs,
  );
  assertClean(schedule, '调整计划日期', ids);
  // 生产任务的计划日期按单据叫“计划生产日期”，和安排生产窗一样
  assert.deepEqual(schedule.items, [{ label: '计划生产日期', value: '2026-11-10 → 2026-11-12' }]);
});

test('更正：完工单列合格、报废和领料的前后，送货单列送货明细的前后，带原因', () => {
  const done = production({ status: 'confirmed' });
  const view = historyView(
    {
      module: 'production',
      action: 'correct',
      detail: { requestId: randomUUID(), reason: '登记多了', before: done, after: { ...done, goodQuantity: '290', materials: [{ stockId: S, issued: '300', returned: '0' }] } },
    },
    refs,
  );
  assertClean(view, '更正完工单', ids);
  assert.deepEqual(view.items, [
    { label: L('goodQuantity'), value: '300 只 → 290 只' },
    { label: '领料', value: '虚构五层纸板 领 310 张 → 虚构五层纸板 领 300 张' },
    { label: '原因', value: '登记多了' },
  ]);
  assert.equal(historyActionName('correct'), '更正');
  const delivery = { kind: 'delivery', status: 'confirmed', date: '2026-11-13', customerId: C, lines: [{ orderId: O, orderLineId: 3, stockId: F, quantity: '600', notes: '' }] };
  const shipped = historyView(
    { module: 'delivery', action: 'correct', detail: { reason: '点错数量', before: delivery, after: { ...delivery, lines: [{ ...delivery.lines[0], quantity: '550' }] } } },
    refs,
  );
  assertClean(shipped, '更正送货单', ids);
  assert.deepEqual(shipped.items.map((i) => i.label), ['送货明细', '原因']);
  assert.match(shipped.items[0].value, /600 只 → .*550 只/);
});

test('带原因的撤销、取消：写清状态和原因', () => {
  const delivery = {
    id: 9,
    kind: 'delivery',
    status: 'confirmed',
    customerId: C,
    customerName: '虚构客户甲',
    shippedAt: '2026-11-12T04:00:00.000Z',
    lines: [{ orderId: O, orderLineId: 3, stockId: F, quantity: '10', notes: '' }],
  };
  const reverse = historyView(
    {
      module: 'delivery',
      action: 'reverse',
      detail: { before: delivery, after: { ...delivery, status: 'reversed', reversal: { reason: '送错了' } }, reason: '送错了', movements: ['31'] },
    },
    refs,
  );
  assertClean(reverse, '撤销送货单', ids);
  assert.deepEqual(reverse.items, [
    { label: '状态', value: '送货中 → 已撤销' },
    { label: '原因', value: '送错了' },
  ]);
  const cancel = historyView({ module: 'delivery', action: 'cancel', detail: { before: { ...delivery, status: 'draft' }, reason: '客户不要了' } }, refs);
  assertClean(cancel, '取消送货单', ids);
  assert.deepEqual(cancel.items, [
    { label: '状态', value: '待送货 → 已取消' },
    { label: '原因', value: '客户不要了' },
  ]);
});

test('订单改明细和单价：逐行写、金额按元，内部编号和派生字段不露', () => {
  const order = {
    id: O,
    number: 'DD-20261101-00001',
    customerId: C,
    customerName: '虚构客户甲',
    orderDate: '2026-11-01',
    deliveryDate: '2026-11-30',
    status: '已确认',
    notes: '',
    currency: 'CNY',
    totalCents: 15000,
    costs: null,
    lines: [{ id: 77, productId: P, productName: '虚构五金箱', quantity: 100, unit: '只', unitPriceCents: 150, unitPriceExact: '1.5000', shippedQuantity: 0 }],
    version: 2,
  };
  const after = {
    ...order,
    deliveryDate: '2026-12-05',
    totalCents: 24000,
    costs: { material: 12345, processing: 0, waste: 0, other: 0, basis: '按上月' },
    lines: [{ ...order.lines[0], quantity: 120, unitPriceCents: 200, unitPriceExact: '2.0000' }],
    version: 3,
  };
  const view = historyView({ module: 'orders', action: 'update', detail: { before: order, after, beforeArchived: false } }, refs);
  assertClean(view, '改订单', [...ids.filter((n) => n !== O), 77]);
  assert.deepEqual(row(view, L('deliveryDate')), ['2026-11-30 → 2026-12-05']);
  assert.deepEqual(row(view, L('lines')), ['第 1 行（虚构五金箱）' + L('quantity') + '：100 只 → 120 只', '第 1 行（虚构五金箱）' + L('unitPriceExact') + '：1.50 元 → 2.00 元']);
  assert.deepEqual(row(view, L('material', 'costs')), ['未填写 → 123.45 元']);
  assert.deepEqual(row(view, L('basis', 'costs')), ['未填写 → 按上月']);
  // 明细加了一行：整体写改之前、改之后
  const added = historyView(
    { module: 'orders', action: 'update', detail: { before: order, after: { ...order, lines: [...order.lines, { ...order.lines[0], id: 78, productId: GONE, productName: '虚构内衬' }] } } },
    refs,
  );
  assertClean(added, '订单加明细', [...ids.filter((n) => n !== O), 77, 78]);
  assert.deepEqual(row(added, L('lines')), ['虚构五金箱 100 只 × 1.50 元 → 虚构五金箱 100 只 × 1.50 元；虚构内衬 100 只 × 1.50 元']);
});

test('库存流水：出入库写余额前后、日期、订单、备注', () => {
  const movement = historyView(
    {
      module: 'stock_items',
      action: 'in',
      recordId: S,
      detail: {
        movementId: 4321,
        source: { action: 'in', kind: 'manual', date: '2026-11-13', notes: '盘到多的', orderId: O },
        before: '300',
        after: '310',
        deltaUnits: 10000,
      },
    },
    refs,
  );
  assertClean(movement, '手动入库', [4321, ...ids.filter((n) => n !== O)]);
  assert.equal(historyActionName('in'), '手动入库');
  assert.deepEqual(movement.items, [
    { label: '库存', value: '300 张 → 310 张' },
    { label: L('date'), value: '2026-11-13' },
    { label: L('customerOrderId'), value: 'DD-20261101-00001' },
    { label: L('notes'), value: '盘到多的' },
  ]);
});

test('删除、归档、恢复：写清动作；引用查不到时写“已删除的记录”', () => {
  const deleted = historyView(
    { module: 'customers', action: 'delete', detail: { before: { id: C, name: '虚构客户甲', created_at: 'x' }, inventoryPolicy: 'preserve', requestId: randomUUID() } },
    refs,
  );
  assertClean(deleted, '删除客户', ids);
  assert.deepEqual(deleted.items, [
    { label: '删除', value: '虚构客户甲' },
    { label: '库存', value: '数量不动' },
  ]);
  const archived = historyView(
    { module: 'customers', action: 'archive', detail: { before: { id: C, name: '虚构客户甲' }, beforeArchived: false, afterArchived: true } },
    refs,
  );
  assert.deepEqual(archived.items, [{ label: '归档', value: '正常 → 已归档' }]);
  const restored = historyView(
    {
      module: 'stock_items',
      action: 'restore',
      recordId: S,
      detail: { reason: '到货入库时自动恢复已归档的库存品', document: '到货单 DH-20261101-00002', before: { id: S }, beforeArchived: true, afterArchived: false },
    },
    refs,
  );
  assertClean(restored, '自动恢复库存品', ids);
  assert.deepEqual(restored.items, [
    { label: '归档', value: '已归档 → 正常' },
    { label: '相关单据', value: '到货单 DH-20261101-00002' },
    { label: '原因', value: '到货入库时自动恢复已归档的库存品' },
  ]);
  const flowArchive = historyView({ module: 'delivery', action: 'archive', detail: { before: { id: 9, kind: 'delivery', status: 'confirmed' } } }, refs);
  assert.deepEqual(flowArchive.items, [{ label: '归档', value: '正常 → 已归档' }]);
  const gone = historyView(
    { module: 'products', action: 'update', detail: { before: { id: P, name: '甲', parentProductId: null }, after: { id: P, name: '甲', parentProductId: GONE } } },
    refs,
  );
  assertClean(gone, '附属于删掉的产品', ids);
  assert.deepEqual(gone.items, [{ label: L('parentProductId'), value: '无 → 已删除的记录' }]);
});

test('认不出的内容只说一句，不回退成原始数据；没有变化的说没有变化', () => {
  for (const detail of [null, 'oops', 42, ['x'], { foo: 1, bar: { baz: 'draft' } }]) {
    const view = historyView({ module: 'orders', action: 'mystery', detail }, refs);
    assert.deepEqual(view, { items: [], note: HISTORY_UNKNOWN });
    assertClean(view, '认不出的内容');
  }
  assert.equal(historyActionName('mystery'), '其他操作');
  assert.ok(Object.values(historyActionNames).every((name) => !name.includes('数据管理')), '动作名里不写“数据管理”');
  const same = historyView({ module: 'customers', action: 'update', detail: { before: { id: C, name: '甲', version: 1 }, after: { id: C, name: '甲', version: 2 } } }, refs);
  assert.deepEqual(same, { items: [], note: HISTORY_NO_CHANGE });
});

test('产品价格从没定到定了：没定价的那头和全站一样写“单价待定”', () => {
  const priced = historyView(
    { module: 'products', action: 'update', detail: { before: { id: P, name: '甲', priceCents: 0 }, after: { id: P, name: '甲', priceCents: 120 } } },
    refs,
  );
  assert.equal(priced.items.length, 1);
  assert.match(priced.items[0].value, /^单价待定 → /);
});
