// 删除影响清单给人看的样子：每种表的叫法、顶部汇总、库存说明、确认窗口的标题和按钮、订货单怎么列。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../server/core/db.js';
import { z } from 'zod';
import { DatabaseMaintenanceService } from '../server/business/database-maintenance.js';
import { impactRowSchema } from '../shared/business/index.js';
import { FlowService } from '../server/flow/service.js';
import { businessBase } from './business-base-fixture.js';
import { OperationsRepository } from '../server/operations/repository.js';
import { deletionDoneMessage, deletionImpactView } from '../src/recordkit/deletion-impact.js';
import { deletionHeadline, deletionInternalTables as internalTables } from '../shared/business/deletion-headline.js';
// 解除的字段的叫法表只给这里核对登记全不全，不在接口里列
import { deletionTableLabel as tableLabel, deletionFieldLabels as fieldLabels } from '../shared/business/deletion-words.js';
import { AssistantTools } from '../server/assistant/tools.js';
import { inventoryOptions } from '../shared/business/index.js';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { saveDoc } from './receive-fixture.js';
import { listingFixture, mergeIntoBatch, orderWithImports } from './delete-fixture.js';
import type { Actor } from '../server/core/auth.js';
import { actor } from './actor-fixture.js';
import { must } from './read-result.js';

const owner = () => localAdministratorActor({ ...actor, role: 'super_admin' });
type Plan = ReturnType<DatabaseMaintenanceService['preview']>;
type ImpactRow = Plan['impact'][number];
/** 本机管理员按“库存数量不动”预览删除 */
const previewPreserve = (store: Store, module: string, items: { id: number; version: number }[]) =>
  new DatabaseMaintenanceService(store).preview({ module, items, inventoryPolicy: 'preserve' }, owner());
const byTable = (plan: Plan, table: string) => plan.impact.filter((r) => r.table === table);

// 一家供应商：两张采购单合成一张订货单、另一张自己一张订货单（单号就是采购单号），一张到货单收了第一张采购单的货
function purchasing() {
    const base = businessBase(actor),
      { store, ops, flow } = base;
    const supplier = base.supplier({ name: '虚构叫法供应商' });
    const raw = base.raw({ name: '虚构叫法纸板' });
    const buy = () =>
      ops.savePurchase(
        {
          supplierId: supplier.id,
          status: '已订货',
          orderDate: '2026-10-01',
          lines: [{ ...raw, stockItemId: raw.id, quantity: '1000', unitPrice: '2', priceBasis: 'quantity' }],
        },
        actor,
      );
    const [first, second, alone] = [buy(), buy(), buy()];
    const batch = (number: string, purchases: number[]) => {
      const id = Number(
        store.db
          .prepare("INSERT INTO order_batches(number,supplier_id,order_date,actor_id,actor_name,created_at,updated_at) VALUES(?,?,'2026-10-01','tester','虚构采购员','t','t')")
          .run(number, supplier.id).lastInsertRowid,
      );
      for (const p of purchases) store.db.prepare('INSERT INTO order_batch_purchases(batch_id,purchase_id) VALUES(?,?)').run(id, p);
    };
    // 已订货的采购单保存时各自有一张订货单：换成两张合一张、一张单独一张
    store.db.exec('DELETE FROM order_batch_purchases; DELETE FROM order_batches;');
    batch('DG-20261001-01', [first.id, second.id]);
    batch(alone.number, [alone.id]);
    const saved = saveDoc(flow, 
      'arrival',
      {
        date: '2026-10-20',
        supplierId: supplier.id,
        reference: 'FICT-NAME-1',
        lines: [{ stockId: raw.id, purchaseLineId: first.lines[0].id, item: raw, quantity: '1000', unitPrice: '2', priceBasis: 'quantity' }],
      },
      actor,
    );
    base.check(saved);
    const purchase = () => must(new OperationsRepository(store).purchases(true).find((p) => p.id === first.id), '采购单');
    return { store, ops, flow, supplier, raw, first, second, alone, arrival: flow.get(saved.id), purchase };
}

/** 删供应商：采购单、采购明细、订货单、订货单里的采购单、到货单、库存流水都列出来；交回影响清单 */
function supplierRows() {
  const f = purchasing();
  try {
    const plan = previewPreserve(f.store, 'suppliers', [{ id: f.supplier.id, version: f.supplier.version }]);
    assert.deepEqual(
      byTable(plan, 'order_batch_purchases').map((r) => r.name).sort(),
      [f.first.number + '（订货单 DG-20261001-01）', f.second.number + '（订货单 DG-20261001-01）', f.alone.number].sort(),
      '只有一张采购单的订货单，单号就是采购单号，只写一遍',
    );
    assert.ok(byTable(plan, 'flow_documents').some((r) => r.kind === 'arrival' && r.name === f.arrival.number));
    assert.equal(tableLabel({ table: 'flow_documents', kind: 'arrival' }), '到货单');
    return plan.impact;
  } finally {
    f.store.close();
  }
}

/** 只删采购单：到货单留着，解除的是“采购明细”，不笼统写“单据内关联”；交回影响清单 */
function purchaseRows() {
  const f = purchasing();
  try {
    const p = f.purchase();
    const plan = previewPreserve(f.store, 'purchases', [{ id: p.id, version: p.version }]);
    const arrival = must(byTable(plan, 'flow_documents').find((r) => r.id === f.arrival.id), '到货单那一行');
    assert.equal(arrival.action, 'detach');
    assert.equal(tableLabel(arrival), '到货单', '解除引用的单据也按单据类型叫，不写“业务单据”');
    assert.ok(arrival.fields?.includes('purchase_line_id'), JSON.stringify(arrival.fields));
    assert.ok(!arrival.fields?.includes('document'));
    return plan.impact;
  } finally {
    f.store.close();
  }
}

/** 删订单：订单明细、导入记录（按订单号叫），挂着这张订单的生产任务解除的是“订单”；交回影响清单 */
function orderRows() {
  const o = orderWithImports();
  try {
    const flow = new FlowService(o.store);
    const task = saveDoc(flow,
      'task',
      { date: '2026-11-02', productId: o.target.lines[0].productId, quantity: '100', unit: '只', orderIds: [o.target.id, o.other.id], notes: '' },
      actor,
    );
    // 安排的任务已下达，订单的生产状态跟着变了（版本号加一），按现在的版本删
    const plan = previewPreserve(o.store, 'orders', [{ id: o.target.id, version: must(o.store.order(o.target.id, true), '订单').version }]);
    assert.deepEqual(byTable(plan, 'import_executions').map((r) => r.name), [o.target.number]);
    const detached = byTable(plan, 'flow_documents').find((r) => r.id === task.id);
    assert.deepEqual(detached?.fields, ['order_id']);
    return plan.impact;
  } finally {
    o.store.close();
  }
}

test('删除影响清单里每种表都叫看得懂的名字：没有英文表名、flow-数字、#数字，表名和叫法不重复说；单据内容里的引用说清是哪种', () => {
  const seen: ImpactRow[] = [...supplierRows(), ...purchaseRows(), ...orderRows()];
  // 守住所有出现过的行：表有中文名，名字不露内部编号、不是“没有单号”，表名不在名字里再说一遍，解除的字段都有中文名
  const tables = new Set(seen.map((r) => r.table));
  for (const t of [
    'suppliers',
    'purchases',
    'purchase_lines',
    'order_batches',
    'order_batch_purchases',
    'flow_documents',
    'stock_movements',
    'orders',
    'order_lines',
    'import_executions',
  ])
    assert.ok(tables.has(t), '造的数据要让 ' + t + ' 出现一次');
  for (const r of seen.filter((r) => !internalTables.has(r.table))) {
    const where = r.table + ' ' + JSON.stringify(r.name);
    assert.notEqual(tableLabel({ table: r.table }), '关联记录', '表有中文名：' + where);
    assert.doesNotMatch(String(r.name), /flow-\d|#\d|^\d+$|[a-z]_[a-z]|没有单号/, '名字不露内部编号：' + where);
    // 档案的名字是人起的（“虚构叫法供应商”），只查登记的叫法
    if (!['customers', 'suppliers', 'products', 'stock_items'].includes(r.table))
      assert.ok(!String(r.name).includes(tableLabel(r)), '表名不在名字里重复：' + where);
    const numbers = String(r.name).match(/[A-Z]{2}-\d{8}-\d+/g) || [];
    assert.equal(new Set(numbers).size, numbers.length, '同一个单号不说两遍：' + where);
    for (const k of r.fields || []) {
      assert.ok(fieldLabels[k], '解除的字段有中文名：' + where + ' ' + k);
      assert.notEqual(k, 'document', '单据内容里的引用说清是哪种：' + where);
    }
  }
});

/** 预览删一条记录（默认本机管理员、库存一起改回） */
const preview = (f: ReturnType<typeof listingFixture>, module: string, row: { id: number; version: number }, policy: 'recalculate' | 'preserve' = 'recalculate', who: Actor = owner()) =>
  f.service.preview({ module, items: [{ id: row.id, version: row.version }], inventoryPolicy: policy }, who);
const deletedMovements = (plan: Plan) => plan.impact.filter((r) => r.table === 'stock_movements' && r.action === 'delete').length;
// 汇总里每一类的条数加起来等于逐条列出的条数（分号前是删除的，分号后是保留的）
const counted = (summary: string, part: 0 | 1) =>
  [...(summary.replace(/。$/, '').split('；')[part] || '').matchAll(/(\d+) /g)].reduce((n, m) => n + Number(m[1]), 0);

test('删除影响清单（采购单、供应商）：顶部按类别汇总、和逐条列的对得上；内部关联和单号相同的订货单不逐条列；保留的写不再挂什么；库存说明按实际删的对象说', () => {
  // 删全部到货的采购单：采购单、采购明细删掉；到货单和入库流水保留、不再挂这张采购单（到货单按订货单登记，也不再属于跟着删掉的订货单）；
  // 订货单（单号就是采购单号）、到货记录不另列
  let f = listingFixture();
  try {
    const p = f.ops.repo.purchases(true, f.purchase.id)[0];
    const plan = preview(f, 'purchases', p);
    const view = deletionImpactView(plan);
    assert.equal(view.summary, '将删除 1 张采购单、1 条采购明细；到货单 1 张、入库流水 1 笔保留，只解除和删掉记录的关联（见下）。');
    assert.deepEqual(view.deleted.map((r) => r.kind), ['采购单', '采购明细']);
    assert.deepEqual(view.kept.map((r) => [r.kind, r.note]), [
      ['到货单', '保留，不再挂这张采购单，不再属于删掉的订货单'],
      ['入库流水', '保留，不再挂这张采购单'],
    ]);
    assert.ok(view.hidden > 0, '订货单、订货单里的采购单、到货记录并进清单末尾的内部关联');
    assert.ok(plan.impact.some((r) => r.table === 'order_batches' && r.partOf === 'purchases'));
    assert.equal(counted(view.summary, 0), view.deleted.length);
    assert.equal(counted(view.summary, 1), view.kept.length);
    assert.equal(plan.inventoryEffect, '库存数量不变：1 张到货单和 1 笔入库流水都保留，只是不再挂这张采购单。');
    // 删档案时“库存怎么处理”的选项不说“这张单子”（页面窗口和助手卡片共用 shared/business/deletion-words.ts 这一份）
    assert.deepEqual(inventoryOptions(plan.selection.module), { recalculate: '库存一起改回（当连带删掉的单据没发生过）', preserve: '库存数量不动，只删记录' });
    assert.equal(deletionDoneMessage('purchases', [p], plan.impact), '已删除采购单 ' + p.number + '，连带 1 条记录一起删除');
  } finally {
    f.store.close();
  }

  // 删供应商：说“连带删掉的到货单”，不说“这张单子”；两张采购单合成的订货单整张删掉时单独列一条并说原因
  f = listingFixture();
  try {
    const second = f.buy(),
      third = f.buy();
    mergeIntoBatch(f.store, f.supplier.id, 'DG-20261101-01', [second, third]);
    for (const policy of ['recalculate', 'preserve'] as const) {
      const plan = preview(f, 'suppliers', f.ops.repo.suppliers(true, f.supplier.id)[0], policy);
      const view = deletionImpactView(plan);
      assert.deepEqual(
        view.deleted.filter((r) => r.kind === '订货单'),
        [{ kind: '订货单', name: 'DG-20261101-01', note: '订货单里已经没有采购单，一起删掉' }],
        policy,
      );
      assert.equal(view.deleted.filter((r) => r.kind === '采购单').length, 3, '每张采购单只列一次');
      assert.ok(!view.deleted.some((r) => ['订货单里的采购单', '到货记录'].includes(r.kind)));
      assert.equal(counted(view.summary, 0), view.deleted.length, view.summary);
      assert.equal(plan.inventoryChoice, 1);
      assert.match(plan.inventoryEffect, /连带删掉的 1 张到货单/);
      assert.doesNotMatch(plan.inventoryEffect, /这张单子/);
      if (policy === 'recalculate') assert.equal(deletedMovements(plan), 1);
      else assert.match(must(view.kept.find((r) => r.kind === '入库流水'), '保留的入库流水').note, /改成系统维护流水，库存数量不动/);
    }
  } finally {
    f.store.close();
  }
});

test('删除影响清单（库存品、产品、待送货的送货单）：库存说明按实际删的对象说、笔数和清单一致；删完的提示说清连带几条', () => {
  // 删库存品：它自己的流水随它删，连带删掉的完工记录在别的库存品上的流水另说；两个数加起来就是清单里删掉的流水笔数
  let f = listingFixture();
  try {
    const plan = preview(f, 'stock_items', f.ops.repo.items(true, [f.raw.id])[0]);
    const view = deletionImpactView(plan);
    assert.equal(
      plan.inventoryEffect,
      '原材料库存“虚构清单纸板”现在还有 990 张，删掉后这些库存就没有了。这个原材料库存的 2 笔出入库流水随它一起删掉。另外，库存一起改回，当连带删掉的 1 张完工记录没发生过：它在别的库存品上的 1 笔入库流水一起删掉，那些库存品的库存重新计算。改回后有库存会变负数（后面的单据已经用掉了）时删不了。',
    );
    assert.equal(deletedMovements(plan), 2 + 1);
    assert.equal(view.deleted.filter((r) => /^(入库|出库)流水$/.test(r.kind)).length, 3, '清单左边按方向叫，和汇总一致');
    assert.match(view.summary, /^将删除 1 个原材料库存、1 张完工记录、2 笔入库流水、1 笔出库流水；/);
    assert.equal(view.deleted[0].kind, '原材料库存');
    // 同一个窗口里同一样东西一个叫法：清单、库存说明、保留的说明、删完的提示都叫“原材料库存”，去掉的流水按方向叫
    assert.equal(view.kept.find((r) => r.kind === '采购明细')?.note, '保留，不再对应这个原材料库存');
    assert.equal(view.kept.find((r) => r.kind === '到货单')?.note, '保留，不再对应这个原材料库存，去掉已删的入库流水');
    assert.doesNotMatch(JSON.stringify([view, plan.inventoryEffect]), /这个库存品|已删的出入库流水/);
    assert.equal(
      deletionDoneMessage('stock_items', [f.ops.repo.items(true, [f.raw.id])[0]], plan.impact),
      '已删除原材料库存“虚构清单纸板”，连带 ' + (view.deleted.length - 1) + ' 条记录一起删除',
    );
  } finally {
    f.store.close();
  }

  // 删产品：连带的成品库存叫“成品库存”，现在还有的 100 只写进库存说明；删完的提示说清连带几条
  f = listingFixture();
  try {
    const product = must(f.store.product(f.product.id, true), '产品');
    const plan = preview(f, 'products', product);
    const view = deletionImpactView(plan);
    assert.ok(view.deleted.some((r) => r.kind === '成品库存'), JSON.stringify(view.deleted));
    assert.ok(!view.deleted.some((r) => r.kind === '库存品'));
    assert.match(plan.inventoryEffect, /^连带删掉的成品库存“[^”]+”现在还有 100 只，删掉后这些库存就没有了。/);
    assert.equal(
      deletionDoneMessage('products', [product], plan.impact),
      '已删除产品“' + product.name + '”，连带 ' + (view.deleted.length - 1) + ' 条记录一起删除',
    );
  } finally {
    f.store.close();
  }

  // 删待送货的送货单：没动过库存，清单只有它自己
  f = listingFixture();
  try {
    const plan = preview(f, 'delivery', f.draft, 'recalculate', actor);
    const view = deletionImpactView(plan);
    assert.equal(view.summary, '将删除 1 张送货单。');
    assert.equal(view.kept.length, 0);
    assert.equal(plan.inventoryEffect, '这张送货单没有动过库存，删了不影响库存。');
    assert.deepEqual(inventoryOptions(plan.selection.module), { recalculate: '库存一起改回（当这张单子没发生过）', preserve: '库存数量不动，只删单子' });
    assert.equal(deletionDoneMessage('delivery', [f.draft], plan.impact), '已删除送货单 ' + f.draft.number);
  } finally {
    f.store.close();
  }
});

test('删除确认的标题和按钮：写明连带删掉几张什么单据，数字就是预览列出的条数；删到单据或库存流水时用警示样式', () => {
  const f = listingFixture();
  try {
    // 供应商：连带的采购单、到货单按类别说，采购明细、到货记录是主单据的一部分不另说
    f.buy();
    const supplier = f.ops.repo.suppliers(true, f.supplier.id)[0];
    const plan = preview(f, 'suppliers', supplier);
    const view = deletionImpactView(plan);
    const headline = deletionHeadline('suppliers', [supplier], plan.impact);
    const purchases = view.deleted.filter((r) => r.kind === '采购单').length,
      arrivals = view.deleted.filter((r) => r.kind === '到货单').length;
    assert.ok(purchases === 2 && arrivals === 1, JSON.stringify(view.deleted));
    assert.match(headline.title, new RegExp('^删除供应商和它的 (.+、)?' + purchases + ' 张采购单、' + arrivals + ' 张到货单'));
    assert.doesNotMatch(headline.title, /明细|到货记录|供应商、/);
    assert.equal(headline.alarming, true);
    // 助手删除卡片的标题用同一个函数、同一份删除预览，再带上名字
    const card = new AssistantTools(f.store).prepare('records.delete', { module: 'suppliers', id: supplier.id }, owner(), 's');
    assert.equal(card.label, deletionHeadline('suppliers', [supplier], z.object({ impact: z.array(impactRowSchema) }).parse(card.after).impact, supplier.name).title);
    assert.match(card.label, new RegExp('^删除供应商 ' + supplier.name + '和它的 ' + purchases + ' 张采购单、' + arrivals + ' 张到货单'));
    // 采购单：明细和到货记录跟着删、到货单保留，标题只说删什么；没删到单据和流水，不用警示样式
    const p = f.ops.repo.purchases(true, f.purchase.id)[0];
    assert.deepEqual(deletionHeadline('purchases', [p], preview(f, 'purchases', p).impact), { title: '删除采购单', alarming: false });
    // 待送货的送货单只删它自己；已核对的单据用警示样式
    const draft = deletionHeadline('delivery', [f.draft], preview(f, 'delivery', f.draft, 'recalculate', actor).impact);
    assert.deepEqual(draft, { title: '删除送货单', alarming: false });
    assert.equal(deletionHeadline('delivery', [{ ...f.draft, status: 'confirmed' }], []).alarming, true);
  } finally {
    f.store.close();
  }
});

test('删除影响清单里的订货单：合并订货单删其中一张时订货单保留并列出；删到一张不剩时整张删、单列并说原因', () => {
  const f = listingFixture();
  try {
    // 两张待订货的采购单合成一份订货单 DG-…（保存时各自的订货单去掉）
    const a = f.buy(),
      b = f.buy();
    mergeIntoBatch(f.store, f.supplier.id, 'DG-20261101-01', [a, b]);
    const row = (p: { id: number }) => f.ops.repo.purchases(true, p.id)[0];
    const preview = (rows: { id: number; version: number }[]) =>
      f.service.preview({ module: 'purchases', items: rows.map((r) => ({ id: r.id, version: r.version })), inventoryPolicy: 'recalculate' }, owner());

    // 删其中一张：订货单还在，列在“保留”里，汇总也带上；成员行不再算进系统内部的关联记录
    const one = preview([row(a)]);
    const member = one.impact.find((r) => r.table === 'order_batch_purchases');
    assert.equal(member?.keptBatch, 'DG-20261101-01', '服务器给出订货单号，前端不拼字符串猜');
    let view = deletionImpactView(one);
    assert.equal(view.summary, '将删除 1 张采购单、1 条采购明细；订货单 DG-20261101-01 保留，去掉这张采购单。');
    assert.deepEqual(view.kept, [{ kind: '订货单', name: 'DG-20261101-01', note: '保留，去掉这张采购单（订货单里还有别的采购单）' }]);
    assert.equal(view.deleted.length, 2);
    // 成员行和订货单本身那一行（去掉安排行、版本号加一）都并进“订货单 DG-… 保留”那一条，不算内部关联
    assert.equal(view.hidden, one.impact.length - view.deleted.length - 2);
    assert.ok(one.impact.some((r) => r.table === 'order_batches' && r.action === 'detach' && r.keptBatch === 'DG-20261101-01'));

    // 两张都删：订货单里一张不剩，整张删掉，单列并说原因
    const both = preview([row(a), row(b)]);
    view = deletionImpactView(both);
    assert.equal(view.summary, '将删除 2 张采购单、2 条采购明细、1 张订货单。');
    assert.deepEqual(
      view.deleted.filter((r) => r.kind === '订货单'),
      [{ kind: '订货单', name: 'DG-20261101-01', note: '订货单里已经没有采购单，一起删掉' }],
    );
    assert.equal(view.kept.length, 0);
  } finally {
    f.store.close();
  }

});
