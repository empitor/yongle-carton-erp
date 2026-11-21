// 确认卡片上给人看的内容（server/assistant/tools/card-summary.ts）：动的是哪条、会发生什么，一个字段都不漏。
// 改数据必须人点确认是唯一的保险，卡片要让人一眼看清；安全复审 rb-2、rb-3、rb-4、rb-7、rb-8 的场景都在这里。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { SQLOutputValue } from 'node:sqlite';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { cardChanges, dataManagementFieldName } from '../shared/business/index.js';
import type { HistoryRefs } from '../shared/business/index.js';
import type { ToolPlan } from '../server/assistant/plan-rules.js';
import type { ToolContext } from '../server/assistant/tools/context.js';
import { businessBase } from './business-base-fixture.js';
import { editableFields, UNLISTED } from '../server/assistant/tools/card-summary.js';
import { autoConfirmAssistant, ctxOf } from './assistant-fixture.js';
import { superActor } from './actor-fixture.js';

const owner = () => localAdministratorActor(superActor());
/** 卡片上逐行给人看的内容；没有就让测试失败 */
function summaryOf(plan: ToolPlan) {
  assert.ok(plan.summary, plan.tool + ' 的卡片没有逐行内容');
  return plan.summary;
}
const text = (plan: ToolPlan) => {
  const t = plan.label + '\n' + summaryOf(plan).map((l) => l.label + '：' + l.value).join('\n');
  // 有改动却列不出明细：去补字段叫法，不能出一张说不清的卡片
  assert.ok(!t.includes(UNLISTED), '卡片上有“' + UNLISTED + '”，去补叫法：\n' + t);
  return t;
};

function setup() {
  const f = autoConfirmAssistant(),
    who = owner(),
    tools = f.manager.tools,
    prepare = (tool: string, args: Record<string, unknown>) => tools.prepare(tool, args, who, 'card'),
    base = businessBase(who, f.store);
  const customer = (name: string) => base.customer({ name, phone: '222' });
  const product = (name: string) => base.product({ name });
  const order = (customerId: number, productId: number) =>
    base.order({ id: customerId }, [base.line({ id: productId }, 100)], { orderDate: '2026-10-01', deliveryDate: '2026-11-30' });
  return { f, who, tools, prepare, base, customer, product, order };
}

test('说甲动乙：改订单交期、改客户电话，卡片标题和第一行写着真正动的那条（单号、客户名）', () => {
  const { f, prepare, customer, product, order } = setup();
  try {
    const p = product('虚构纸箱甲'),
      a = order(customer('虚构客户甲').id, p.id),
      b = order(customer('虚构客户乙').id, p.id);
    const plan = prepare('records.propose_save', { module: 'orders', id: b.id, patch: { deliveryDate: '2026-11-20' } });
    assert.match(plan.label, new RegExp(b.number));
    assert.match(summaryOf(plan)[0].value, new RegExp(b.number + '.*虚构客户乙'));
    assert.doesNotMatch(text(plan), new RegExp(a.number));
    assert.ok(summaryOf(plan).some((l) => /交货日期/.test(l.label) && /2026-11-30 → 2026-11-20/.test(l.value)), text(plan));
    const c = customer('虚构客户丙');
    const phone = prepare('records.propose_save', { module: 'customers', id: c.id, patch: { phone: '13800000000' } });
    assert.match(text(phone), /客户 虚构客户丙/);
    assert.match(text(phone), /222 → 13800000000/);
  } finally {
    f.close();
  }
});

test('订单明细夹带的改动（换产品、产品名称、行备注、客户料号、行税率、计税方式、行交期）每样都有一行，只改这些时卡片也不空', () => {
  const { f, prepare, customer, product, order } = setup();
  try {
    const p = product('虚构纸箱甲'),
      other = product('虚构纸箱乙'),
      o = order(customer('虚构客户甲').id, p.id);
    const changes: Record<string, unknown> = {
      productId: other.id,
      productName: '虚构改名',
      notes: '虚构行备注',
      customerProductCode: 'FICT-9',
      taxRate: '13',
      taxMode: 'exclusive',
      deliveryDate: '2026-12-01',
    };
    for (const [key, value] of Object.entries(changes)) {
      const plan = prepare('records.propose_save', {
        module: 'orders',
        id: o.id,
        patch: { lines: o.lines.map((l) => ({ ...l, [key]: value })) },
      });
      const label = dataManagementFieldName(key, 'lines');
      assert.ok(summaryOf(plan).some((l) => l.value.includes(label)), key + ' 没有列出：\n' + text(plan));
    }
    // 换产品写的是新产品的名称
    const swap = prepare('records.propose_save', { module: 'orders', id: o.id, patch: { lines: o.lines.map((l) => ({ ...l, productId: other.id })) } });
    assert.match(text(swap), /虚构纸箱乙/);
  } finally {
    f.close();
  }
});

test('产品的原文尺寸单位、附属于哪个产品改了也有一行', () => {
  const { f, prepare, product } = setup();
  try {
    const parent = product('虚构母产品'),
      p = product('虚构子产品');
    const parentPlan = prepare('records.propose_save', { module: 'products', id: p.id, patch: { parentProductId: parent.id } });
    assert.match(text(parentPlan), /附属于.*虚构母产品/);
    const raw = prepare('records.propose_save', { module: 'products', id: p.id, patch: { dimensionUnitRaw: '公分' } });
    assert.match(text(raw), /原文尺寸单位.*公分/);
  } finally {
    f.close();
  }
});

test('入库、出库、盘点调整：卡片写明单据号、每行品名和数量、库存从多少变成多少', () => {
  const { f, prepare, tools, who, base } = setup();
  try {
    const supplier = base.supplier({ name: '虚构供应商' }),
      raw = base.raw({ name: '虚构纸板' });
    const arrival = tools.flow.save('arrival', { date: '2026-10-20', supplierId: supplier.id, reference: '虚构样品', lines: [{ stockId: raw.id, item: { name: raw.name, unit: '张' }, quantity: '30' }] }, who);
    const confirm = prepare('flow.propose_confirmation', { id: arrival.id });
    assert.match(confirm.label, new RegExp(arrival.number));
    assert.match(text(confirm), /虚构纸板 30 张/);
    assert.match(text(confirm), /虚构纸板：0 张 → 30 张/);
    tools.commit(confirm, who, 'card');
    const item = tools.ops.items(true, raw.id)[0];
    const move = prepare('inventory.propose_movement', { id: raw.id, action: 'adjust', quantity: '24', date: '2026-10-21', notes: '虚构盘点' });
    assert.match(move.label, /^盘点调整：原材料 虚构纸板/);
    assert.match(text(move), /虚构纸板：30 张 → 24 张/);
    assert.doesNotMatch(text(move) + text(confirm), /未填写|已删除的记录|纸板 产品/, text(move) + ' / ' + text(confirm));
    assert.equal(item.version > 0, true);
    const out = prepare('inventory.propose_movement', { id: raw.id, action: 'out', quantity: '5', date: '2026-10-21', notes: '虚构领用' });
    assert.match(text(out), /30 张 → 25 张（减 5 张）/);
  } finally {
    f.close();
  }
});

test('批量归档三个客户：写成“归档：甲、乙、丙（不删除，可以恢复）”，不列成一排“→ 未填写”', () => {
  const { f, prepare, customer } = setup();
  try {
    const ids = ['虚构客户甲', '虚构客户乙', '虚构客户丙'].map((n) => customer(n).id);
    const plan = prepare('records.propose_batch_lifecycle', { module: 'customers', ids, action: 'archive' });
    assert.match(plan.label, /^批量归档客户：客户 虚构客户甲 等 3 条$/);
    assert.deepEqual(plan.warnings, ['要么全部归档，要么一条都不动；历史记录照常保留。']);
    assert.ok(summaryOf(plan).some((l) => l.label === '归档' && l.value === '客户 虚构客户甲、客户 虚构客户乙、客户 虚构客户丙（不删除，可以恢复）'), text(plan));
    assert.doesNotMatch(text(plan), /未填写/);
  } finally {
    f.close();
  }
});

test('兜底：订单、明细、产品、客户、供应商、采购单、库存品参数结构里每个能改的字段，改了卡片上都有一行、用中文叫法', () => {
  const skip = new Set(['id', 'version', 'kind', 'lines', 'length', 'width', 'height', 'dimensionUnit', 'status']);
  const valueOf = (key: string, side: 0 | 1) => (/Id$/.test(key) ? side + 1 : typeof side === 'number' && /^(is|has|allow)/.test(key) ? !!side : 'v' + side);
  const refs: HistoryRefs = { customers: { 1: { name: '甲' }, 2: { name: '乙' } }, suppliers: { 1: { name: '甲' }, 2: { name: '乙' } }, products: { 1: { name: '甲' }, 2: { name: '乙' } }, stock_items: { 1: { name: '甲' }, 2: { name: '乙' } }, orders: { 1: { name: '甲' }, 2: { name: '乙' } } };
  for (const module of ['orders', 'products', 'customers', 'suppliers', 'purchases', 'stock_items']) {
    const editable = editableFields(module);
    assert.ok(editable.top.size > 0, module);
    for (const key of editable.top) {
      if (skip.has(key)) continue;
      const lines = cardChanges(module, { [key]: valueOf(key, 0) }, { [key]: valueOf(key, 1) }, refs, editable);
      assert.ok(lines.length, module + '.' + key + ' 改了没有列出');
      assert.ok(lines.every((l) => l.label !== key), module + '.' + key + ' 没有中文叫法');
    }
    for (const key of editable.lines) {
      if (skip.has(key)) continue;
      const lines = cardChanges(module, { lines: [{ [key]: valueOf(key, 0) }] }, { lines: [{ [key]: valueOf(key, 1) }] }, refs, editable);
      assert.ok(lines.length, module + ' 明细.' + key + ' 改了没有列出');
      assert.ok(lines.every((l) => !l.value.includes(key + '：')), module + ' 明细.' + key + ' 没有中文叫法：' + JSON.stringify(lines));
    }
  }
  assert.ok(editableFields('orders').lines.has('taxRate'), '订单明细的字段读出来了');
});

test('其余写入命令：卡片标题或第一行里有目标记录的单号或名称', async () => {
  const { f, prepare, tools, who, base, customer, product } = setup();
  try {
    const titled = (plan: ToolPlan, name: string) => assert.ok(plan.label.includes(name) || summaryOf(plan)[0]?.value.includes(name), plan.tool + ' 看不出动的是 ' + name + '：\n' + text(plan));
    const c = customer('虚构客户丁');
    titled(prepare('records.propose_lifecycle', { module: 'customers', id: c.id, action: 'archive' }), '虚构客户丁');
    titled(prepare('management.execute', { requestId: randomUUID(), module: 'customers', action: 'update', items: [{ id: c.id, version: c.version }], patch: { notes: '虚构' }, reason: '虚构' }), '虚构客户丁');
    const task = tools.flow.save('task', { date: '2026-10-20', productId: product('虚构纸箱丁').id, quantity: '10', unit: '只', orderIds: [], notes: '' }, who);
    titled(prepare('flow.schedule', { id: task.id, expectedVersion: task.version, plannedDate: '2026-11-02', requestId: randomUUID() }), task.number);
    titled(prepare('flow.propose_cancel', { id: task.id, reason: '虚构取消' }), task.number);
    const supplier = base.supplier({ name: '虚构供应商丁' }),
      raw = base.raw({ name: '虚构纸板丁' });
    const arrival = tools.flow.save('arrival', { date: '2026-10-20', supplierId: supplier.id, reference: '虚构丁', lines: [{ stockId: raw.id, item: { name: raw.name, unit: '张' }, quantity: '8' }] }, who);
    tools.commit(prepare('flow.propose_confirmation', { id: arrival.id }), who, 'card');
    const reversal = prepare('flow.propose_reversal', { id: arrival.id, reason: '虚构登记重了' });
    titled(reversal, arrival.number);
    assert.match(text(reversal), /虚构纸板丁：8 张 → 0 张/);
    const { InboxService } = await import('../server/inbox/service.js');
    const item = new InboxService(f.store).ingest({ channel: 'manual', externalId: randomUUID(), kind: 'text', text: '虚构收件内容', receivedAt: new Date().toISOString() });
    titled(prepare('inbox.set_status', { id: Number(item.id), status: 'ignored', expectedVersion: item.version }), '虚构收件内容');
  } finally {
    f.close();
  }
});

test('说甲出库乙：两张待送货的送货单，卡片上写着真正出库的那张的单号、品名数量和库存前后', () => {
  const { f, prepare, tools, who, base, customer, product, order } = setup();
  try {
    const p = product('虚构纸箱乙'),
      stock = base.finished(p, { name: '虚构纸箱乙成品' }, { quantity: '500', date: '2026-10-20', notes: '虚构入库' });
    const draft = (name: string, quantity: string) => {
      const o = order(customer(name).id, p.id);
      return tools.flow.save('delivery', { date: '2026-11-08', customerId: o.customerId, lines: [{ orderId: o.id, orderLineId: o.lines[0].id, stockId: stock.id, quantity }] }, who);
    };
    const a = draft('虚构客户甲', '10'),
      b = draft('虚构客户乙', '90');
    const plan = prepare('flow.propose_confirmation', { id: b.id });
    assert.match(plan.label, new RegExp('^不导出直接出库：.*' + b.number));
    assert.doesNotMatch(text(plan), new RegExp(a.number));
    assert.match(text(plan), /虚构客户乙/);
    assert.match(text(plan), /90 只/);
    assert.match(text(plan), /虚构纸箱乙.*：500 只 → 410 只（减 90 只）/);
    assert.doesNotMatch(text(plan), /未填写/);
  } finally {
    f.close();
  }
});

/** 待送货的送货单，核对出库：甲订了 100 只，送 10 只，库存 500 → 490 */
function shipped(s: ReturnType<typeof setup>) {
  const { tools, who, base, customer, product, order, prepare } = s;
  const p = product('虚构纸箱甲'),
    stock = base.finished(p, { name: '虚构纸箱甲成品' }, { quantity: '500', date: '2026-10-20', notes: '虚构入库' });
  const o = order(customer('虚构客户甲').id, p.id);
  const d = tools.flow.save('delivery', { date: '2026-11-08', customerId: o.customerId, lines: [{ orderId: o.id, orderLineId: o.lines[0].id, stockId: stock.id, quantity: '10' }] }, who);
  tools.commit(prepare('flow.propose_confirmation', { id: d.id }), who, 'card');
  return { p, stock, o, d: tools.flow.get(d.id) };
}
/** 订单读回来（换客户要带当前版本号）；读不到就让测试失败 */
function storedOrder(s: ReturnType<typeof setup>, id: number) {
  const order = s.f.store.order(id, true);
  assert.ok(order, '订单 ' + id + ' 不在库里');
  return order;
}
const mgmt = (module: string, action: string, items: { id: number; version: number }[], extra: Record<string, unknown> = {}) => ({
  requestId: randomUUID(),
  module,
  action,
  items: items.map((r) => ({ id: r.id, version: r.version })),
  reason: '虚构维护',
  ...extra,
});

test('数据管理新建：建的是什么（客户、明细、数量、单价）卡片上列全，不只一行原因', () => {
  const s = setup();
  try {
    const c = s.customer('虚构客户乙'),
      p = s.product('虚构纸箱乙');
    const plan = s.prepare('management.execute', mgmt('orders', 'create', [], { patch: { customerId: c.id, orderDate: '2026-11-14', deliveryDate: '2026-12-01', status: '待确认', notes: '', lines: [{ productId: p.id, quantity: 777, unit: '只', unitPriceCents: 12345 }] } }));
    assert.match(plan.label, /虚构客户乙/);
    assert.match(text(plan), /新建：订单（虚构客户乙）/);
    assert.match(text(plan), /虚构纸箱乙/);
    assert.match(text(plan), /777 只/);
    assert.match(text(plan), /123\.45/);
    const customerPlan = s.prepare('management.execute', mgmt('customers', 'create', [], { patch: { name: '虚构新客户', contact: '', phone: '555', address: '', notes: '' } }));
    assert.match(text(customerPlan), /新建：客户 虚构新客户/);
    assert.match(text(customerPlan), /555/);
  } finally {
    s.f.close();
  }
});

test('更正已出库的送货单：卡片写库存前后；本机管理员把这一行换挂到同一客户的另一张订单，两张订单的已发都列', () => {
  const s = setup();
  try {
    const { p, o, d } = shipped(s);
    const correct = (lines: Record<string, unknown>[]) => s.prepare('delivery.correct', { id: d.id, expectedVersion: d.version, reason: '虚构点错', lines });
    assert.match(text(correct([{ index: 0, quantity: '30' }])), /虚构纸箱甲.*：490 只 → 470 只（减 20 只）/);
    const o2 = s.order(o.customerId, p.id);
    const swap = text(correct([{ index: 0, quantity: '10', orderLineId: o2.lines[0].id }]));
    assert.match(swap, new RegExp('订单 ' + o.number + ' 已发：.*10 只 → 0 只'), swap);
    assert.match(swap, new RegExp('订单 ' + o2.number + ' 已发：.*0 只 → 10 只'), swap);
  } finally {
    s.f.close();
  }
});

test('连带改到的别的记录也列：订单换客户带着已出库的送货单换客户；采购单换供应商把订货单删掉重建', () => {
  const s = setup();
  try {
    const { o, d } = shipped(s);
    const b = s.customer('虚构客户乙');
    const plan = s.prepare('management.execute', mgmt('orders', 'update', [storedOrder(s, o.id)], { patch: { customerId: b.id } }));
    assert.ok(summaryOf(plan).some((l) => l.label.startsWith('连带：送货单 ' + d.number) && /虚构客户甲 → 虚构客户乙/.test(l.value)), text(plan));
    const supplierA = s.base.supplier({ name: '虚构纸板厂甲' }),
      supplierB = s.base.supplier({ name: '虚构纸板厂乙' }),
      raw = s.base.raw({ name: '虚构纸板甲' });
    const purchase = s.tools.ops.savePurchase({ supplierId: supplierA.id, status: '已订货', orderDate: '2026-11-01', lines: [{ ...raw, stockItemId: raw.id, quantity: '1000', unitPrice: '2', priceBasis: 'quantity' }] }, s.who);
    const change = s.prepare('records.propose_save', { module: 'purchases', id: purchase.id, patch: { supplierId: supplierB.id } });
    assert.match(text(change), /连带：删除：订货单 .*（虚构纸板厂甲）/);
    assert.match(text(change), /连带：新建：订货单（虚构纸板厂乙）：虚构纸板甲 1000 张/);
    assert.ok(summaryOf(change).filter((l) => l.label.startsWith('连带：')).length <= 3, text(change));
  } finally {
    s.f.close();
  }
});

test('订货单的到货安排、登记到货：标题带供应商，列出新安排的数量日期、实到、不合格、到货日期、送货单号和已到前后', async () => {
  const s = setup();
  try {
    const supplier = s.base.supplier({ name: '虚构纸板厂乙' }),
      raw = s.base.raw({ name: '虚构纸板乙' });
    const purchase = s.tools.ops.savePurchase({ supplierId: supplier.id, status: '已订货', orderDate: '2026-11-01', lines: [{ ...raw, stockItemId: raw.id, quantity: '1000', unitPrice: '2', priceBasis: 'quantity' }] }, s.who);
    const { OrderBatchService } = await import('../server/operations/index.js');
    const batchId = new OrderBatchService(s.f.store).batchIdOf(purchase.id);
    assert.ok(batchId !== null, '采购单进了订货单');
    const version = new OrderBatchService(s.f.store).view(batchId).version;
    const schedule = s.prepare('order_batch.schedule', { id: batchId, expectedVersion: version, schedule: [{ row: 1, quantity: '600', dueDate: '2026-12-01' }, { row: 1, quantity: '400', dueDate: '2026-12-20' }] });
    assert.match(schedule.label, /虚构纸板厂乙/);
    assert.match(text(schedule), /到货安排：.* → 600 在 2026-12-01 前；400 在 2026-12-20 前/);
    const receive = s.prepare('order_batch.receive', { id: batchId, expectedVersion: version, requestId: randomUUID(), date: '2026-11-14', reference: 'RCV-1', rows: [{ row: 1, quantity: '400', rejectedQuantity: '10' }] });
    assert.match(receive.label, /虚构纸板厂乙/);
    assert.match(text(receive), /本次到货（虚构纸板乙）：实到 400 张，不合格 10 张/);
    assert.match(text(receive), /到货日期：2026-11-14/);
    assert.match(text(receive), /送货单号：RCV-1/);
    assert.match(text(receive), /已到：0 → 400 张/);
    assert.match(text(receive), /虚构纸板乙：0 张 → 390 张（加 390 张）/);
    // 连带新建的到货单一行摘要（品名、实到、不合格），不逐个字段罗列
    const created = summaryOf(receive).filter((l) => l.label === '连带：新建');
    assert.equal(created.length, 1, text(receive));
    assert.match(created[0].value, /^到货单（虚构纸板厂乙）：虚构纸板乙 400 张（不合格 10 张/);
    assert.ok(!summaryOf(receive).some((l) => l.label.startsWith('连带：到货单')), text(receive));
  } finally {
    s.f.close();
  }
});

/**
 * 兜底：试执行前后，业务表里任何一行有变化（新加、删掉、改了版本和时间以外的内容），卡片上都得写着它的单号或名称。
 * 在回滚点里按确认后同一个执行函数试一遍，前后各读一遍这几张表比。
 */
type Row = Record<string, SQLOutputValue>;
async function assertCovered(s: ReturnType<typeof setup>, plan: ToolPlan) {
  const { rehearseChanges } = await import('../server/assistant/tools/card-rehearsal.js');
  const tables: Record<string, string> = { orders: 'number', purchases: 'number', flow_documents: 'number', order_batches: 'number', purchase_returns: 'number', customers: 'name', suppliers: 'name', products: 'name', stock_items: 'name' };
  const clean = (row: Row) => JSON.stringify(row, (k: string, v: unknown): unknown => (['version', 'updated_at', 'updatedAt', 'confirmedAt'].includes(k) ? undefined : typeof v === 'string' && v.startsWith('{') ? JSON.parse(v) : v));
  const dump = () =>
    Object.fromEntries(
      Object.keys(tables).map((t) => [t, new Map(s.f.store.db.prepare('SELECT * FROM ' + t).all().map((r): [SQLOutputValue, Row] => [r.id, r]))]),
    );
  const before = dump();
  const ctx: ToolContext = { ...ctxOf(s.tools.store), ops: s.tools.ops, flow: s.tools.flow, tools: s.tools };
  const after = rehearseChanges(ctx, () => {
    s.tools.commit(plan, s.who, 'card');
    return dump();
  }, () => undefined).result;
  const shownText = text(plan);
  for (const [table, key] of Object.entries(tables))
    for (const id of new Set([...before[table].keys(), ...after[table].keys()])) {
      const b = before[table].get(id),
        a = after[table].get(id);
      if (b && a && clean(b) === clean(a)) continue;
      // 新建的还没占号（确认时才定），卡片上写“新建”和内容，不写单号
      if (!b && key === 'number') {
        assert.match(shownText, /新建/, table + ' 新建了一条，卡片上没有：\n' + shownText);
        continue;
      }
      const row = a ?? b;
      assert.ok(row);
      const name = String(row[key]);
      assert.ok(shownText.includes(name), table + ' ' + name + ' 变了，卡片上没有：\n' + shownText);
    }
}

test('兜底：试执行前后哪张业务表有变化，卡片上都有对应的那一条', async () => {
  const s = setup();
  try {
    const { o, d } = shipped(s);
    await assertCovered(s, s.prepare('delivery.correct', { id: d.id, expectedVersion: d.version, reason: '虚构点错', lines: [{ index: 0, quantity: '30' }] }));
    await assertCovered(s, s.prepare('management.execute', mgmt('orders', 'update', [storedOrder(s, o.id)], { patch: { customerId: s.customer('虚构客户乙').id } })));
    await assertCovered(s, s.prepare('flow.propose_reversal', { id: d.id, reason: '虚构撤销' }));
    const supplierA = s.base.supplier({ name: '虚构纸板厂甲' }),
      raw = s.base.raw({ name: '虚构纸板甲' });
    const purchase = s.tools.ops.savePurchase({ supplierId: supplierA.id, status: '已订货', orderDate: '2026-11-01', lines: [{ ...raw, stockItemId: raw.id, quantity: '1000', unitPrice: '2', priceBasis: 'quantity' }] }, s.who);
    await assertCovered(s, s.prepare('records.propose_save', { module: 'purchases', id: purchase.id, patch: { supplierId: s.base.supplier({ name: '虚构纸板厂乙' }).id } }));
    await assertCovered(s, s.prepare('management.execute', mgmt('customers', 'create', [], { patch: { name: '虚构新客户', contact: '', phone: '', address: '', notes: '' } })));
  } finally {
    s.f.close();
  }
});

test('待入库的到货单改明细的验收合格、拒收、入库数量，卡片上逐项列出', () => {
  const { f, prepare, tools, who, base } = setup();
  try {
    const supplier = base.supplier({ name: '虚构纸板厂甲' }),
      raw = base.raw({ name: '虚构纸板甲' });
    const a = tools.flow.save('arrival', { date: '2026-10-20', supplierId: supplier.id, reference: '虚构验收', lines: [{ stockId: raw.id, item: { name: raw.name, unit: '张' }, quantity: '50' }] }, who);
    const plan = prepare('records.propose_save', { module: 'arrivals', id: a.id, patch: { lines: [{ ...a.lines[0], acceptedQuantity: '40', rejectedQuantity: '10', stockedQuantity: '40' }] } });
    const t = text(plan);
    assert.match(t, /验收合格数量：未填写 → 40 张/);
    assert.match(t, /拒收数量：未填写 → 10 张/);
    assert.match(t, /入库数量：未填写 → 40 张/);
  } finally {
    f.close();
  }
});

test('同一轮出两张新建生产任务卡片：卡片上不写没占住的单号（会撞号），写产品和数量', () => {
  const { f, prepare, product } = setup();
  try {
    const p = product('虚构纸箱丙');
    const make = () => prepare('records.propose_save', { module: 'production_tasks', patch: { date: '2026-11-14', productId: p.id, quantity: '120', unit: '只', orderIds: [] } });
    const [one, two] = [make(), make()];
    for (const plan of [one, two]) {
      assert.doesNotMatch(text(plan), /SC-\d/, '新建卡片上不该有单号：\n' + text(plan));
      assert.match(plan.label, /生产任务：虚构纸箱丙 120 只/);
    }
  } finally {
    f.close();
  }
});
