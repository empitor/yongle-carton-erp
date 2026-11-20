// 单据页的列表、详情操作条和确认窗（src/flow/FlowTable.tsx、FlowActions.tsx、FlowDialogs.tsx）：按状态一个主按钮，
// 危险项在“更多”里，撤销只开确认窗，调整排程报错写出来。只渲染，不碰数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { z } from 'zod';
import FlowTable from '../src/flow/FlowTable.js';
import { FlowActionBar, type ActionDoc, type FlowActionContext } from '../src/flow/FlowActions.js';
import { FlowActionDialog, FlowScheduleDialog } from '../src/flow/FlowDialogs.js';
import { allWaitingReview } from '../shared/business/task-progress.js';
import type { FlowDocView } from '../shared/business/index.js';
import { productSchema, today } from '../shared/core/domain.js';
import { ProductionCompletion } from '../server/flow/batch-completion.js';
import { actions, ctx, noop, task } from './flow-ui-fixture.js';
import { clerk, flowFixture } from './flow-fixture.js';

/** 操作条交给 ActionBar 的按钮：不渲染，直接点它的 onClick */
const barAction = z.looseObject({ label: z.unknown(), onClick: z.custom<() => void>((v) => typeof v === 'function').optional() });
const barProps = z.object({ primary: z.array(barAction), secondary: z.array(barAction), more: z.array(barAction) });
const barOf = (view: ActionDoc, c: FlowActionContext) => barProps.parse(FlowActionBar({ view, ctx: c }).props);
/** 点一组按钮里叫这个名字的那个（没有这个按钮就让测试失败） */
const click = (list: z.output<typeof barAction>[], label: string) => {
  const found = list.find((a) => a.label === label);
  assert.ok(found?.onClick, '没有按钮：' + label);
  found.onClick();
};

/** 服务端真实存出来的单据：产品“虚构纸箱2”的生产任务（计划 100 只，登记完工直接入库 40 只）和那张完工单 */
function storedTaskAndProduction() {
  const f = flowFixture();
  const product = f.store.saveProduct(productSchema.parse({ name: '虚构纸箱2' }));
  f.stockIn('10', f.raw.id);
  const planned = f.task({ productId: product.id, quantity: '100', unit: '只', plannedDate: '2026-11-02' });
  new ProductionCompletion(f.store).execute(
    {
      requestId: randomUUID(),
      taskIds: [planned.id],
      date: today(),
      operator: '虚构生产人员',
      allocation: 'shared-proportional',
      materials: [{ stockId: f.raw.id, unit: '张', issued: '1', returned: '0' }],
      quantities: [{ taskId: planned.id, goodQuantity: '40', scrapQuantity: '0' }],
    },
    clerk,
  );
  return { store: f.store, task: f.flow.get(planned.id, 'task'), productions: f.flow.list('production') };
}

test('生产任务列表变窄时先收实际完工、再收产品，计划日期一直留着；完工记录照旧全显示', () => {
  const render = (kind: 'task' | 'production', rows: FlowDocView[]) =>
    renderToStaticMarkup(
      h(FlowTable, {
        kind,
        filtered: rows,
        sliced: rows,
        selected: [],
        setSelected: noop,
        view: null,
        setView: noop,
        labelRow: (r) => ('productName' in r ? r.productName : undefined),
      }),
    );
  const head = (html: string) =>
    Object.fromEntries([...html.split('</thead>')[0].matchAll(/<th(?: class="([^"]*)")?>([^<]*)</g)].map((m) => [m[2], m[1] || '']));
  const stored = storedTaskAndProduction();
  try {
    assert.equal(stored.task.completed, '40');
    const tasks = head(render('task', [stored.task]));
    assert.equal(tasks['计划日期'], '');
    assert.equal(tasks['产品'], 'col-mid');
    assert.equal(tasks['实际完工'], 'col-low');
    assert.equal(tasks['状态'], '');
    const html = render('task', [stored.task]);
    // 格子和表头同一个优先级
    assert.match(html, /<td class="cell-wrap col-mid">虚构纸箱2<\/td>/);
    const production = head(render('production', stored.productions));
    assert.ok(Object.values(production).every((c) => !/col-/.test(c)));
  } finally {
    stored.store.close();
  }
});

test('生产任务详情按状态一个主按钮：安排即下达（没有“确认下达”），开工前编辑，开工后调整排程，危险项叫取消、撤销', () => {
  const fresh = actions(renderToStaticMarkup(h(FlowActionBar, { view: task(3, 'confirmed'), ctx: ctx() })));
  assert.equal(fresh.primary, '登记完工');
  assert.ok(fresh.visible.includes('编辑'));
  assert.ok(!fresh.visible.includes('调整排程'));
  assert.doesNotMatch(fresh.more + fresh.visible.join(), /确认下达|修改(?!历史)|冲销/);

  const started = actions(
    renderToStaticMarkup(
      h(FlowActionBar, { view: task(2, 'confirmed', '40', { hasProduction: true }), ctx: ctx() }),
    ),
  );
  assert.equal(started.primary, '登记完工');
  assert.ok(started.visible.includes('调整排程'));
  assert.ok(!started.visible.includes('编辑'));
  assert.match(started.more, /取消这张任务/);
  assert.doesNotMatch(started.more, /取消剩余任务/);

  const superMode = ctx({ superMode: true });
  const done = actions(
    renderToStaticMarkup(
      h(FlowActionBar, { view: task(4, 'confirmed', '100', { hasProduction: true }), ctx: superMode }),
    ),
  );
  assert.equal(done.primary, undefined);
  assert.match(done.more, /撤销这张任务/);
  assert.doesNotMatch(done.more, /冲销更正/);
});

test('已生效的送货单、完工单：“编辑”只改说明、详情留着，“更多”里有更正送货单、更正完工单；任何状态都没有直接编辑和按原单重新填写', () => {
  const calls: [string, number | undefined][] = [];
  let closed = false;
  const c = (over: Partial<FlowActionContext> = {}) =>
    ctx({
      correct: (d) => void calls.push(['correct', 'id' in d ? d.id : undefined]),
      editInfo: (d) => void calls.push(['info', d.id]),
      setView: (v) => {
        if (v === null) closed = true;
      },
      ...over,
    });
  const shipped = { id: 8, kind: 'delivery' as const, status: 'confirmed', number: 'SH-虚构-8', version: 1, shippedAt: '2026-11-10T04:00:00Z', lines: [] };
  const delivery = actions(renderToStaticMarkup(h(FlowActionBar, { view: shipped, ctx: c() })));
  assert.equal(delivery.primary, '确认送达');
  assert.ok(delivery.visible.includes('送货单') && delivery.visible.includes('编辑'));
  assert.match(delivery.more, /更正送货单/);
  // 客户已签收的也能更正
  const delivered = actions(renderToStaticMarkup(h(FlowActionBar, { view: { ...shipped, deliveredAt: '2026-11-11' }, ctx: c() })));
  assert.match(delivered.more, /更正送货单/);
  const bar = barOf(shipped, c());
  click(bar.secondary, '编辑');
  click(bar.more, '更正送货单');
  assert.deepEqual(calls, [['info', 8], ['correct', 8]]);
  assert.equal(closed, false, '打开编辑、更正窗时不关详情');
  // 完工更正和撤销这次完工同一级：超级管理员模式才有
  const stocked = { id: 9, kind: 'production' as const, status: 'confirmed', number: 'WG-虚构-9', version: 1, materials: [] };
  const plain = actions(renderToStaticMarkup(h(FlowActionBar, { view: stocked, ctx: c() })));
  assert.ok(plain.visible.includes('编辑'));
  assert.doesNotMatch(plain.more, /更正完工单/);
  const superMode = { superMode: true };
  assert.match(actions(renderToStaticMarkup(h(FlowActionBar, { view: stocked, ctx: c(superMode) }))).more, /更正完工单/);
  // 已被更正替代的原单：不能再编辑、再更正
  const replaced = actions(renderToStaticMarkup(h(FlowActionBar, { view: { ...shipped, status: 'reversed', replacedBy: 10 }, ctx: c(superMode) })));
  assert.ok(!replaced.visible.includes('编辑'));
  assert.doesNotMatch(replaced.more, /更正送货单/);
  // 本机管理员 + 超级管理员模式下，任何状态都没有“直接编辑（管理员）”“按原单重新填写”
  const admin = { superMode: true, local: true };
  for (const kind of ['delivery', 'production', 'task', 'arrival'] as const)
    for (const status of ['draft', 'confirmed', 'reversed', 'cancelled']) {
      const html = renderToStaticMarkup(h(FlowActionBar, { view: { id: 1, kind, status, number: '虚构-1', version: 1, lines: [], quantity: '100', progress: 40, completed: '40', hasProduction: true }, ctx: c(admin) }));
      assert.doesNotMatch(html, /直接编辑|按原单重新填写/, kind + ' ' + status);
    }
});

test('待送货的送货单：主按钮导出送货单，更多里有不导出直接出库、调整排程、归档、取消；打印在导出窗里，不另放', () => {
  const pending = { id: 9, kind: 'delivery' as const, status: 'draft', number: 'SH-虚构-9', version: 2, lines: [] };
  const bar = actions(renderToStaticMarkup(h(FlowActionBar, { view: pending, ctx: ctx() })));
  assert.equal(bar.primary, '导出送货单');
  assert.ok(bar.visible.includes('编辑'));
  for (const label of ['不导出直接出库', '调整排程', '归档', '取消这次送货']) assert.ok(bar.more.includes(label), label);
  assert.doesNotMatch(bar.more + bar.visible.join(), /打印|查看正式记录|修改 \//);
});

test('调整排程窗口显示保存没成功的原因', () => {
  const html = renderToStaticMarkup(
    h(FlowScheduleDialog, {
      doc: { number: 'SC-虚构-1' },
      label: '虚构纸箱',
      date: '2026-11-12',
      time: '',
      setDate: noop,
      setTime: noop,
      busy: false,
      error: '单据已被别人改过，请刷新后再改。',
      close: noop,
      save: noop,
    }),
  );
  assert.match(html, /role="alert"[^>]*>单据已被别人改过/);
});

test('撤销这次完工、这次送货：只打开撤销确认窗，详情留着（点“取消”回到详情）', () => {
  for (const kind of ['production', 'delivery'] as const) {
    const asked: [string, number][] = [];
    let closed = false;
    const c = ctx({
      superMode: true,
      ask: (type, rows) => void asked.push([type, rows[0].id]),
      setView: (v) => {
        if (v === null) closed = true;
      },
    });
    const view = { id: 7, kind, status: 'confirmed', number: '虚构-7', version: 1, lines: [] };
    const undo = barOf(view, c).more.find((a) => /^撤销这次/.test(String(a.label)));
    assert.ok(undo?.onClick, kind);
    undo.onClick();
    assert.deepEqual(asked, [['reverse', 7]], kind);
    assert.equal(closed, false, kind + '：打开撤销确认窗时不关详情');
  }
});

test('剩下的都已登记、在等核对入库的生产任务：详情主按钮是核对入库（一张直接核对，几张去完工记录），不再是登记完工', () => {
  const waiting = task(5, 'confirmed', '40', { quantity: '100', pendingCompleted: '60', hasProduction: true });
  const reviewed: ActionDoc[] = [];
  const one = actions(
    renderToStaticMarkup(
      h(FlowActionBar, {
        view: waiting,
        ctx: ctx({ pendingCompletions: () => [{ id: 51, kind: 'production', status: 'draft' }], review: (d) => void reviewed.push(d) }),
      }),
    ),
  );
  assert.equal(one.primary, '核对入库');
  assert.ok(one.visible.includes('调整排程'));
  assert.ok(!one.visible.includes('登记完工'));
  const bar = barOf(waiting, ctx({ pendingCompletions: () => [{ id: 51, kind: 'production', status: 'draft' }], review: (d) => void reviewed.push(d) }));
  const first = bar.primary.at(0);
  assert.ok(first?.onClick);
  first.onClick();
  assert.equal(reviewed.at(-1)?.id, 51, '只有一张待入库：直接打开它的核对窗');
  // 几张待入库：去完工记录的待处理里逐张核对
  const many = renderToStaticMarkup(
    h(FlowActionBar, { view: waiting, ctx: ctx({ pendingCompletions: () => [{ id: 51, kind: 'production', status: 'draft' }, { id: 52, kind: 'production', status: 'draft' }] }) }),
  );
  assert.match(many, /<a class="button-link primary" href="#production\?view=production&amp;pending=1"[^>]*>核对入库<\/a>/);
  // 还有没登记的：照旧登记完工
  assert.equal(allWaitingReview(task(6, 'confirmed', '40', { quantity: '100', pendingCompleted: '20' })), false);
  assert.equal(
    actions(renderToStaticMarkup(h(FlowActionBar, { view: task(6, 'confirmed', '40', { pendingCompleted: '20', hasProduction: true }), ctx: ctx() }))).primary,
    '登记完工',
  );
});

test('“取消这次完工”的确认窗写清取消后会怎样：不入库、库存不动、记录保留，挂任务的还差加回来', () => {
  // 页面上交进确认窗的是完工记录列表里的单据（还带编号、种类、状态这些）
  const render = (rows: (Pick<FlowDocView<'production'>, 'number' | 'taskId'> & Record<string, unknown>)[]) =>
    renderToStaticMarkup(
      h(FlowActionDialog, { action: { type: 'cancel', rows }, kind: 'production', reason: '', setReason: noop, busy: false, close: noop, perform: noop }),
    );
  const linked = render([{ id: 1, number: 'DJ-虚构-1', kind: 'production', status: 'draft', taskId: 7 }]);
  assert.match(linked, /取消这次完工/);
  assert.match(linked, /取消后成品不入库、领的纸板也不扣，库存不变；完工记录保留在列表里，标“已取消”，生产任务还差的数量跟着加回来。/);
  const alone = render([{ id: 2, number: 'DJ-虚构-2', kind: 'production', status: 'draft', taskId: null }]);
  assert.match(alone, /标“已取消”。/);
  assert.doesNotMatch(alone, /生产任务还差/);
});
