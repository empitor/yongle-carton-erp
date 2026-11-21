// 修改历史和服务端写的审计对得上：服务端每个动作都有中文名和样例（样例里的动作服务端也都还在写），
// 真实业务、数据管理改单据留下的历史都能逐项中文显示。内存库、虚构数据。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { updateDocumentInfo } from '../server/flow/document-info.js';
import { changeLifecycle } from '../server/lifecycle/index.js';
import { recordContext } from '../server/business/record-context.js';
import { DataManagementService } from '../server/admin/data-management-service.js';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { businessBase } from './business-base-fixture.js';
import { dataManagementCommandSchema } from '../shared/business/data-management-modules.js';
import { AUDIT_SOURCE } from '../shared/core/audit-sources.js';
import { movementSchema } from '../shared/business/operations.js';
import { recordStatusActions } from '../shared/business/record-status.js';
import { HISTORY_UNKNOWN, historyView, type HistoryView } from '../shared/business/record-history.js';
import { historyActionName, historyActionNames } from '../shared/business/history-fields.js';
import { HistoryList } from '../src/recordkit/RecordContext.js';
import { archiveDoc } from './receive-fixture.js';
import { firstResult } from './data-management-fixture.js';
import { assertClean, C, F, GONE, ids, L, O, P, refs, row, S, SUP } from './history-fixture.js';
import { actor, superActor } from './actor-fixture.js';
import { must } from './read-result.js';

/**
 * server/ 下所有 .ts 文件里的 audit(store, actor, { action, entity, id, document }) 调用，拆出对象里每个字段的写法
 * （简写的字段写法就是变量名）。第三个参数不是对象字面量的认不出，单独列出来
 */
function auditCalls() {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name).replace(/\\/g, '/')] : [],
    );
  const calls: { file: string; fields: Record<string, string> }[] = [],
    unreadable: string[] = [];
  for (const file of files('server')) {
    if (file === 'server/core/audit.ts') continue; // audit 本身的定义
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/(?<![\w.$])audit\(/g)) {
      const entry = callArgs(text, m.index + m[0].length)[2] ?? '';
      if (entry.startsWith('{')) calls.push({ file, fields: objectFields(entry) });
      else unreadable.push(file + '：' + entry);
    }
  }
  return { calls, unreadable };
}
/** 对象字面量 { a: x, b } 按顶层逗号拆成 { a: 'x', b: 'b' } */
function objectFields(literal: string) {
  return Object.fromEntries(
    callArgs(literal, 1)
      .filter(Boolean)
      .map((entry) => {
        const colon = entry.indexOf(':');
        return colon < 0 ? [entry, entry] : [entry.slice(0, colon).trim(), entry.slice(colon + 1).trim()];
      }),
  );
}
/** 从左括号后面 from 处起，按顶层逗号拆出这次调用的参数（跳过字符串里的括号和逗号），到配对的右括号为止 */
function callArgs(text: string, from: number) {
  const args: string[] = [];
  let depth = 0,
    quote = '',
    current = '';
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      if (ch === '\\') current += text[++i];
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) {
      if (depth === 0) {
        args.push(current.trim());
        break;
      }
      depth--;
    }
    if (ch === ',' && depth === 0) {
      args.push(current.trim());
      current = '';
    } else current += ch;
  }
  return args;
}
const literals = (expr: string) => [...expr.matchAll(/'([^']*)'/g)].map((m) => m[1]);
/** 修改历史只查这几类记录（server/business/record-context.ts：六类业务档案和 flow_ 开头的四类单据） */
const historyEntities = new Set(['customers', 'products', 'orders', 'suppliers', 'purchases', 'stock_items']);
const shownEntity = (expr: string) =>
  !/^'[^']*'$/.test(expr) && !literals(expr).length
    ? true // 变量：由调用方决定，按会显示算
    : literals(expr).some((e) => historyEntities.has(e) || e.startsWith('flow_'));
/** 动作是变量的几处，可能的值 */
const dynamicActions: Record<string, string[]> = {
  // 本机管理员数据管理：命令里的动作
  'v.action': [...dataManagementCommandSchema.shape.action.options],
  // 归档 / 恢复（server/lifecycle/lifecycle.ts）
  'input.action': ['archive', 'restore'],
  // 出入库（recordMovement）：手工的 in / out / adjust，到货更正补记的 purchase / out
  'source.action': [...movementSchema.shape.action.options, 'purchase'],
  // 页面上的客户、产品、订单保存（server/app.ts）
  'command.action': ['create', 'update'],
  // 订单的状态动作（server/business/order-status.ts）：确认、退回、取消、恢复
  action: [...recordStatusActions],
};

/** 每个动作一份照服务端写法造的审计内容，确认能逐项显示 */
const delivery = { id: 9, kind: 'delivery', status: 'draft', customerId: C, lines: [{ orderId: O, orderLineId: 3, stockId: F, quantity: '10', notes: '' }] };
const stock = { id: S, name: '虚构五层纸板', kind: 'raw', unit: '张', specification: '', notes: '', quantity: '300' };
const samples: Record<string, { module: string; detail: unknown }> = {
  create: { module: 'customers', detail: { before: null, after: { id: C, name: '虚构客户甲', contact: '王', phone: '', address: '', notes: '' } } },
  update: { module: 'suppliers', detail: { before: { id: SUP, name: '甲', phone: '1' }, after: { id: SUP, name: '甲', phone: '2' } } },
  archive: { module: 'customers', detail: { before: { id: C }, beforeArchived: false, afterArchived: true } },
  restore: { module: 'customers', detail: { reason: '误归档', before: { id: C }, result: { results: [] }, requestId: randomUUID() } },
  delete: { module: 'orders', detail: { before: { id: O, number: 'DD-1' }, inventoryPolicy: 'recalculate' } },
  confirm: { module: 'delivery', detail: { before: delivery, after: { ...delivery, status: 'confirmed' } } },
  cancel: { module: 'delivery', detail: { before: delivery, reason: '不要了' } },
  reverse: { module: 'delivery', detail: { before: { ...delivery, status: 'confirmed' }, after: { ...delivery, status: 'reversed' }, reason: '送错' } },
  'create-draft': { module: 'delivery', detail: { before: null, after: delivery } },
  // 订单、采购单的状态动作（server/business/order-status.ts、server/operations/purchase-status.ts）
  revert: { module: 'orders', detail: { before: { id: O, status: '已确认' }, after: { id: O, status: '待确认' } } },
  reinstate: { module: 'orders', detail: { before: { id: O, status: '已取消' }, after: { id: O, status: '待确认' } } },
  'update-draft': { module: 'delivery', detail: { before: delivery, after: { ...delivery, address: '新地址' } } },
  'issue-task': {
    module: 'task',
    detail: { before: null, after: { kind: 'task', status: 'confirmed', productId: P, quantity: '100', unit: '只' } },
  },
  'update-confirmed-task': {
    module: 'task',
    detail: { before: { kind: 'task', status: 'confirmed', productId: P, quantity: '100', unit: '只' }, after: { kind: 'task', status: 'confirmed', productId: P, quantity: '120', unit: '只' } },
  },
  schedule: { module: 'delivery', detail: { before: { ...delivery, plannedDate: '2026-11-01' }, after: { ...delivery, plannedDate: '2026-11-02' }, requestId: randomUUID() } },
  delivered: { module: 'delivery', detail: { before: { ...delivery, status: 'confirmed' }, after: { ...delivery, status: 'confirmed', deliveredAt: '2026-11-13T01:00:00Z' } } },
  'edit-info': { module: 'production', detail: { number: 'DJ-1', before: { notes: '' }, after: { notes: '受潮' }, version: 2 } },
  correct: {
    module: 'purchases',
    detail: {
      requestId: randomUUID(),
      reason: '少点了十张',
      before: { id: 'flow-3', reference: '送货单甲', date: '2026-11-01', lines: [{ stockId: S, quantity: '100', item: { name: '虚构五层纸板', unit: '张' } }] },
      after: { id: 'flow-4', reference: '送货单甲', date: '2026-11-01', lines: [{ stockId: S, quantity: '90', item: { name: '虚构五层纸板', unit: '张' } }] },
      result: {},
    },
  },
  'edit-related-stock': { module: 'stock_items', detail: { before: stock, after: { ...stock, specification: '1250×1000' } } },
  'remove-delivery-lines': {
    module: 'delivery',
    detail: { before: { ...delivery, lines: [...delivery.lines, { ...delivery.lines[0], orderId: O }] }, after: delivery, movedMovements: ['1'], movedTo: { id: 12, number: 'SH-2' } },
  },
  'change-delivery-customer': { module: 'delivery', detail: { before: delivery, after: { ...delivery, customerId: GONE } } },
  'split-delivery': { module: 'delivery', detail: { from: { id: 9, number: 'SH-1' }, after: { ...delivery, status: 'confirmed' }, movements: ['1'] } },
  in: { module: 'stock_items', detail: { movementId: 1, source: { action: 'in', kind: 'manual', date: '2026-11-13', notes: '入' }, before: '0', after: '10', deltaUnits: 10000 } },
  out: { module: 'stock_items', detail: { movementId: 1, source: { action: 'out', kind: 'manual', date: '2026-11-13', notes: '出' }, before: '10', after: '0', deltaUnits: -10000 } },
  adjust: { module: 'stock_items', detail: { movementId: 1, source: { action: 'adjust', kind: 'manual', date: '2026-11-13', notes: '盘' }, before: '10', after: '8', deltaUnits: -2000 } },
  purchase: { module: 'stock_items', detail: { movementId: 1, source: { action: 'purchase', kind: 'flow_arrival', date: '2026-11-13', notes: '更正' }, before: '10', after: '20', deltaUnits: 10000 } },
  generate: { module: 'purchases', detail: { exportId: randomUUID(), filename: '采购单-CG-1.docx', sha256: 'a'.repeat(64), markOrdered: true, markShipped: false, version: 3 } },
  'download-complete': { module: 'delivery', detail: { exportId: randomUUID(), sha256: 'a'.repeat(64), before: 'draft', after: 'confirmed' } },
};

test('服务端写修改历史的每个动作都有中文名，内容都能逐项显示', () => {
  const { calls, unreadable } = auditCalls();
  assert.ok(calls.length > 30, '没找到 audit 调用，检查器坏了');
  assert.deepEqual(unreadable, [], 'audit 的第三个参数要直接写对象字面量 { action, entity, id, document }，本检查才认得出');
  const actions = new Set<string>();
  const unknownDynamic: string[] = [];
  for (const { file, fields } of calls) {
    const { action, entity, id } = fields;
    if (id === 'null') continue; // 不挂在某条记录上的审计不进修改历史
    if (file === 'server/finance/core.ts') continue; // 财务的审计（financeAudit）挂在财务表上
    if (!shownEntity(entity)) continue;
    const found = literals(action);
    if (found.length) found.forEach((a) => actions.add(a));
    else if (dynamicActions[action]) dynamicActions[action].forEach((a) => actions.add(a));
    else unknownDynamic.push(file + '：' + action);
  }
  assert.deepEqual(unknownDynamic, [], '动作是变量的审计要在 dynamicActions 里登记可能的值');
  for (const action of actions) {
    assert.ok(historyActionNames[action], '动作 ' + action + ' 没有中文名（shared/business/history-fields.ts 的 historyActionNames）');
    assertClean({ items: [{ label: historyActionName(action), value: '' }] }, '动作名 ' + action);
    const sample = samples[action];
    assert.ok(sample, '动作 ' + action + ' 没有照服务端写法的样例，补进本文件的 samples');
    const view = historyView({ module: sample.module, action, detail: sample.detail, recordId: sample.module === 'stock_items' ? S : undefined }, refs);
    assertClean(view, '动作 ' + action, [...ids.filter((n) => ![O].includes(n)), 4321]);
    assert.notEqual(view.note, HISTORY_UNKNOWN, '动作 ' + action + ' 的内容认不出');
    assert.ok(view.items.length, '动作 ' + action + ' 没有列出任何内容');
  }
  // 反过来：样例里的动作服务端都还在写，删掉的动作不留样例（也不留显示它的代码）
  const stale = Object.keys(samples).filter((a) => !actions.has(a));
  assert.deepEqual(stale, [], '样例里有服务端已经不写（或不进修改历史）的动作：' + stale.join('、'));
});

// ---------- 真实写出来的审计：走一遍业务服务，再按接口给的样子显示 ----------

/**
 * 走一遍业务留下修改历史：供应商改电话后归档，纸板期初入库，生产任务安排、改备注、排期，完工核对后改批次备注，
 * 送货单改备注、出库、送达、撤销后归档，另一张送货单取消。
 */
function historyWorld() {
  const base = businessBase(actor),
    { store, ops, flow } = base;
  try {
    const customer = base.customer({ name: '虚构历史客户' });
    const product = base.product({ name: '虚构历史产品', length: 300, width: 200, height: 100, dimensionUnit: 'mm' });
    const supplier = base.supplier({ name: '虚构历史供应商' });
    ops.saveSupplier({ name: '虚构历史供应商', phone: '0574-0000', version: supplier.version }, actor, supplier.id);
    const raw = base.raw({ name: '虚构历史纸板' });
    const finished = base.finished(product, { name: '虚构历史成品' });
    const order = base.order(customer, [base.line(product, 100, { unitPriceCents: 150 })], {
      number: '虚构历史单1',
      orderDate: '2026-11-01',
      deliveryDate: '2026-11-30',
    });
    const purchase = ops.savePurchase(
      {
        supplierId: supplier.id,
        customerOrderId: order.id,
        orderDate: '2026-11-01',
        status: '已订货',
        lines: [{ stockItemId: raw.id, name: raw.name, unit: '张', quantity: '100', unitPrice: '1.2', priceBasis: 'quantity' }],
      },
      actor,
    );
    base.stockIn(raw, { quantity: '500', date: '2026-11-02', notes: '期初' });
    const confirm = (id: number) => base.check({ id });
    // 安排生产即下达，没有核对这一步
    const task = flow.save('task', { date: '2026-11-03', productId: product.id, quantity: '100', unit: '只', orderIds: [order.id] }, actor);
    flow.save('task', { date: '2026-11-03', productId: product.id, quantity: '100', unit: '只', orderIds: [order.id], notes: '加急', version: task.version }, actor, task.id);
    flow.schedule(task.id, { plannedDate: '2026-11-05', expectedVersion: flow.get(task.id).version, requestId: randomUUID() }, actor);
    const done = flow.save(
      'production',
      { date: '2026-11-06', taskId: task.id, productId: product.id, goodQuantity: '100', scrapQuantity: '2', operator: '虚构员工', materials: [{ stockId: raw.id, issued: '110', returned: '0' }] },
      actor,
    );
    confirm(done.id);
    updateDocumentInfo(store, done.id, { notes: '纸板受潮，已挑出', expectedVersion: flow.get(done.id).version }, actor);
    const deliveryInput = { date: '2026-11-07', customerId: customer.id, lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: finished.id, quantity: '10' }] };
    const delivery = flow.save('delivery', deliveryInput, actor);
    flow.save('delivery', { ...deliveryInput, notes: '先改个备注', version: delivery.version }, actor, delivery.id);
    confirm(delivery.id);
    flow.markDelivered(delivery.id, { version: flow.get(delivery.id).version }, actor);
    flow.reverse(delivery.id, { version: flow.get(delivery.id).version, reason: '客户退回重送', acknowledged: true }, actor);
    const second = flow.save(
      'delivery',
      { date: '2026-11-08', customerId: customer.id, lines: [{ orderId: order.id, orderLineId: order.lines[0].id, stockId: finished.id, quantity: '5' }] },
      actor,
    );
    flow.cancel(second.id, { version: second.version, reason: '客户改期', acknowledged: true }, actor);
    archiveDoc(flow, delivery.id, false, superActor(), flow.get(delivery.id).version);
    changeLifecycle(store, 'suppliers', { action: 'archive', acknowledged: true, items: [{ id: supplier.id, version: ops.suppliers(true, supplier.id)[0].version }] }, actor);
    return { store, customer, product, supplier, raw, finished, order, purchase, task, done, delivery, second };
  } catch (error) {
    store.close(); // 造数据失败也关库，错误照样抛给测试
    throw error;
  }
}

test('真实业务操作留下的修改历史：每条都能逐项显示，没有英文、草稿和内部编号', () => {
  const { store, customer, product, supplier, raw, finished, order, purchase, task, done, delivery, second } = historyWorld();
  try {
    const records: [string, number][] = [
      ['suppliers', supplier.id],
      ['stock_items', raw.id],
      ['purchases', purchase.id],
      ['task', task.id],
      ['production', done.id],
      ['delivery', delivery.id],
      ['delivery', second.id],
    ];
    const seen = new Set<string>();
    const internal = [raw.id, finished.id, product.id, customer.id, order.id, supplier.id, purchase.id, task.id, done.id, delivery.id, second.id].filter(
      (n) => n > 9, // 一位数的编号会和数量、日期里的数字撞上，只查不会撞的
    );
    for (const [module, id] of records) {
      const ctx = recordContext(store, module, id, superActor());
      assert.ok(ctx.history.length, module + ' 没有修改历史');
      for (const entry of ctx.history as { action: string; detail: unknown }[]) {
        seen.add(entry.action);
        assert.notEqual(historyActionName(entry.action), '其他操作', module + ' 的动作 ' + entry.action + ' 没有中文名');
        const view = historyView({ module, action: entry.action, detail: entry.detail, recordId: id }, ctx.historyRefs);
        assertClean(view, module + ' ' + entry.action, internal);
        assert.notEqual(view.note, HISTORY_UNKNOWN, module + ' 的 ' + entry.action + ' 认不出：' + JSON.stringify(entry.detail).slice(0, 200));
      }
    }
    for (const action of ['create', 'update', 'archive', 'in', 'create-draft', 'update-draft', 'confirm', 'schedule', 'edit-info', 'delivered', 'reverse', 'cancel'])
      assert.ok(seen.has(action), '没走到动作 ' + action);
  } finally {
    store.close();
  }
});

test('真实业务操作留下的修改历史：批次备注、送货单状态和原因、新建的客户和明细、入库、改电话按中文逐项写', () => {
  const { store, supplier, raw, done, delivery } = historyWorld();
  try {
    /** 这条记录某个动作的那条修改历史（第一条），按接口给的样子显示 */
    const viewOf = (module: string, id: number, action: string) => {
      const ctx = recordContext(store, module, id, superActor());
      const entry = must(ctx.history.find((e) => e.action === action), module + ' 的 ' + action + ' 历史');
      return historyView({ module, action, detail: entry.detail, recordId: id }, ctx.historyRefs);
    };
    assert.deepEqual(viewOf('production', done.id, 'edit-info').items, [{ label: '批次备注', value: '未填写 → 纸板受潮，已挑出' }]);
    assert.deepEqual(viewOf('delivery', delivery.id, 'confirm').items, [{ label: '状态', value: '待送货 → 送货中' }]);
    assert.deepEqual(viewOf('delivery', delivery.id, 'delivered').items, [{ label: '状态', value: '送货中 → 已送达' }]);
    assert.deepEqual(viewOf('delivery', delivery.id, 'reverse').items, [
      { label: '状态', value: '已送达 → 已撤销' },
      { label: '原因', value: '客户退回重送' },
    ]);
    const created = viewOf('delivery', delivery.id, 'create-draft');
    assert.deepEqual(created.items.find((i) => i.label === L('customerId')), { label: L('customerId'), value: '虚构历史客户' });
    assert.deepEqual(created.items.find((i) => i.label === L('lines')), { label: L('lines'), value: '虚构历史产品 10 只' });
    assert.deepEqual(viewOf('stock_items', raw.id, 'in').items[0], { label: '库存', value: '0 张 → 500 张' });
    assert.deepEqual(viewOf('suppliers', supplier.id, 'update').items, [{ label: L('phone'), value: '未填写 → 0574-0000' }]);
  } finally {
    store.close();
  }
});

// ---------- 本机管理员在数据管理里改单据：留在单据自己的修改历史里 ----------

/**
 * 本机管理员在数据管理里办生产任务：新建一张（created）再改数量、撤销、归档；另一张（other）取消。
 * run(动作, 选中的单据, 改的内容, 原因) 照数据管理窗口发的命令（带 entry 标记）执行。
 */
function maintenanceWorld() {
  const owner = localAdministratorActor(superActor()),
    base = businessBase(owner),
    { store, flow } = base,
    service = new DataManagementService(store);
  try {
    const customer = base.customer({ name: '虚构维护客户' });
    const product = base.product({ name: '虚构维护纸箱' });
    const order = base.order(customer, [base.line(product, 100, { unitPriceCents: 150 })], {
      number: '虚构维护单1',
      orderDate: '2026-11-01',
      deliveryDate: '2026-11-30',
    });
    // 数据管理窗口发的命令带 entry 标记（src/admin/data-api.ts 的 dataManagementCommand）
    const run = (action: string, items: { id: number; version: number }[], patch: Record<string, unknown> = {}, reason = '虚构维护验收') =>
      service.execute({ requestId: randomUUID(), module: 'task', action, items: items.map(({ id, version }) => ({ id, version })), patch, reason, entry: AUDIT_SOURCE.dataManagement }, owner, 's');
    const created = firstResult(run('create', [], { date: '2026-11-03', productId: product.id, quantity: '100', unit: '只', orderIds: [order.id] }));
    run('update', [flow.get(created.id)], { quantity: '120', notes: '数据管理改数量' });
    run('reverse', [flow.get(created.id)], {}, '数量下错了');
    run('archive', [flow.get(created.id)]);
    const other = flow.save('task', { date: '2026-11-04', productId: product.id, quantity: '50', unit: '只', orderIds: [order.id] }, superActor());
    run('cancel', [flow.get(other.id)], {}, '客户不要了');
    return { store, flow, service, owner, customer, product, order, run, created, other };
  } catch (error) {
    store.close(); // 造数据失败也关库，错误照样抛给测试
    throw error;
  }
}

test('数据管理改单据（新建、改内容、确认、撤销、取消、归档）：出现在单据的修改历史里，逐项中文显示', () => {
  const { store, flow, customer, product, order, run, created, other } = maintenanceWorld();
  try {
    // 失败的那次也记审计，挂在同一个名字上，但不挂在某张单据上（不进修改历史）
    assert.throws(() => run('confirm', [flow.get(other.id)]));
    assert.deepEqual(
      store.db.prepare('SELECT DISTINCT entity FROM business_audit WHERE source=?').all(AUDIT_SOURCE.dataManagement).map((r) => r.entity),
      ['flow_task'],
      '数据管理对单据记的审计统一挂在 flow_<模块> 上',
    );
    assert.deepEqual(
      store.db.prepare("SELECT entity,record_id FROM business_audit WHERE action='failed-confirm'").all().map((r) => [r.entity, r.record_id]),
      [['flow_task', null]],
    );
    /** 数据管理记的那几条（带原因的那条比下层服务记的晚、排在前面），按动作取出要显示的样子 */
    const adminHistory = (id: number) => {
      const ctx = recordContext(store, 'task', id, superActor());
      const views = new Map<string, HistoryView>();
      for (const e of ctx.history as { sourceLabel?: string; action: string; detail: unknown }[]) {
        const view = historyView({ module: 'task', action: e.action, detail: e.detail, recordId: id }, ctx.historyRefs);
        assertClean(view, '数据管理 ' + e.action, [order.id, product.id, customer.id, id].filter((n) => n > 9));
        assert.notEqual(view.note, HISTORY_UNKNOWN, e.action + ' 认不出');
        if (e.sourceLabel === '数据管理' && !views.has(e.action)) views.set(e.action, view);
      }
      assert.ok(!ctx.history.some((e) => e.action.startsWith('failed-')), '失败的审计不进修改历史');
      return views;
    };
    const first = adminHistory(created.id);
    const shown = (action: string, views = first) => must(views.get(action), '数据管理记的 ' + action);
    // 安排即下达：数据管理新建的任务就是已下达，没有“确认”这一步
    // 数据管理记的（带原因）和下层单据流转自己记的都是数据管理，新的在前
    assert.deepEqual([...first.keys()], ['archive', 'reverse', 'update', 'update-confirmed-task', 'create', 'issue-task'], '新的在前');
    assert.deepEqual(shown('update').items, [
      { label: L('notes'), value: '未填写 → 数据管理改数量' },
      { label: L('quantity'), value: '100 只 → 120 只' },
      { label: '原因', value: '虚构维护验收' },
    ]);
    assert.deepEqual(shown('reverse').items, [
      { label: '状态', value: '待生产 → 已撤销' },
      { label: '原因', value: '数量下错了' },
    ]);
    assert.deepEqual(shown('archive').items, [
      { label: '归档', value: '正常 → 已归档' },
      { label: '原因', value: '虚构维护验收' },
    ]);
    assert.deepEqual(row(shown('create'), L('quantity')), ['100 只']);
    assert.deepEqual(row(shown('create'), L('productId')), ['虚构维护纸箱']);
    assert.deepEqual(shown('cancel', adminHistory(other.id)).items, [
      { label: '状态', value: '待生产 → 已取消' },
      { label: '原因', value: '客户不要了' },
    ]);
  } finally {
    store.close();
  }
});

test('数据管理改的单据：界面每条都标“数据管理”、不露来源代码；别的页面借接口做的标“页面”；助手不认这个标记', () => {
  const { store, flow, service, owner, product, order, created } = maintenanceWorld();
  try {
    // 界面：同一次维护两条都留着（下层服务记的、数据管理记的带原因那条），每条都加中性小标签写来源，这里都是“数据管理”
    const ctx = recordContext(store, 'task', created.id, superActor());
    const html = renderToStaticMarkup(h(HistoryList, { module: 'task', id: created.id, history: ctx.history, refs: ctx.historyRefs }));
    const rows = html.split('<li>').slice(1);
    assert.equal(rows.length, ctx.history.length);
    const tag = '<span class="status-chip tone-neutral">数据管理</span>';
    assert.ok(rows.length >= 8, '新建、修改、撤销、归档各两条：单据流转自己记的和数据管理记的');
    rows.forEach((li, i) => assert.ok(li.includes(tag), '第 ' + (i + 1) + ' 条（' + ctx.history[i].action + '）没标“数据管理”'));
    assert.ok(!html.includes(AUDIT_SOURCE.dataManagement), '来源代码不露给用户');
    // 给界面和助手的历史里没有审计来源代码，也没有记审计用的 origin 标记
    const shown = JSON.stringify(ctx.history);
    for (const code of [AUDIT_SOURCE.dataManagement, 'management-ui'])
      assert.ok(!shown.includes(code), '历史里露出了 ' + code);
    assert.ok(ctx.history.every((e) => !('source' in e)));
    // 别的页面借本机管理员接口做的（生产页、仓库页、到货识别，不带标记）照样记两条，但不标成“数据管理”
    const third = flow.save('task', { date: '2026-11-05', productId: product.id, quantity: '30', unit: '只', orderIds: [order.id] }, superActor());
    const t3 = flow.get(third.id);
    service.execute({ requestId: randomUUID(), module: 'task', action: 'cancel', items: [{ id: t3.id, version: t3.version }], patch: {}, reason: '生产页取消剩余' }, owner, 's');
    const pageHistory = recordContext(store, 'task', third.id, superActor()).history;
    const reasonOf = (detail: unknown) => (typeof detail === 'object' && detail !== null && 'reason' in detail ? detail.reason : undefined);
    assert.ok(pageHistory.some((e) => e.action === 'cancel' && reasonOf(e.detail) === '生产页取消剩余'), '借接口做的那条照样记了');
    assert.ok(pageHistory.every((e) => e.sourceLabel === '页面'), '不带标记的记成页面，不标成“数据管理”');
    // 助手的命令不认这个标记（带了也拒收），助手做的不会被标成“数据管理”
    assert.throws(() =>
      service.execute(
        { requestId: randomUUID(), module: 'task', action: 'archive', items: [{ id: third.id, version: flow.get(third.id).version }], patch: {}, reason: '助手', entry: AUDIT_SOURCE.dataManagement },
        owner,
        's',
        'management-assistant',
      ),
    );
  } finally {
    store.close();
  }
});
