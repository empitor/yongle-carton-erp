// 生产页的登记完工窗口和完工编辑窗（src/flow/ProductionBatchDialog.tsx、FlowEditor.tsx）：列哪些任务、还差多少、
// 批次备注、领纸板的表、超计划提示的口径、完工日期上限。只渲染，不碰数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FlowEditor } from '../../src/flow/FlowEditor.js';
import type { ProductionEditing } from '../../src/flow/ProductionForm.js';
import { completableTask } from '../../shared/business/index.js';
import { taskCounts, taskOptionText } from '../../src/flow/task-progress.js';
import { actions, batchDialog, noop, task } from './flow-ui-fixture.js';

test('登记完工：从单张任务进来只列这一张，取消的任务不列；页头进来列全部能登记的', () => {
  const tasks = [task(1, 'cancelled'), task(2, 'confirmed', '40'), task(3, 'confirmed'), task(4, 'confirmed', '100')];
  assert.deepEqual(
    tasks.filter(completableTask).map((t) => t.id),
    [2, 3],
  );
  const one = batchDialog(tasks, [2]);
  assert.match(one, /SC-虚构-2/);
  assert.doesNotMatch(one, /SC-虚构-3|SC-虚构-1/);
  assert.match(one, /再加任务/);
  assert.match(one, /先登记，稍后核对入库/);
  // 入哪个成品库存由产品决定（服务端自动对应、没有就新建），窗口里不再选；批次备注记到每张完工单上
  assert.doesNotMatch(one, /入哪个成品库存|成品档案|按任务的产品新建/);
  assert.match(one, /aria-label="批次备注"[^>]*maxLength="2000"|maxLength="2000"[^>]*aria-label="批次备注"/);
  assert.match(one, /会显示在成品库存的批次里/);
  const all = batchDialog(tasks, []);
  assert.match(all, /SC-虚构-2/);
  assert.match(all, /SC-虚构-3/);
  assert.doesNotMatch(all, /SC-虚构-1|SC-虚构-4/);
  // 页头进来不预选任何任务，不靠隐藏的勾选状态
  const boxes = all.match(/<input[^>]*aria-label="选择完工任务[^>]*>/g) || [];
  assert.equal(boxes.length, 2);
  assert.ok(boxes.every((b) => !b.includes('checked')));
});

test('登记完工只有一个窗口：“先登记，稍后核对入库”放在“更多”，主按钮还是登记完工；不挂任务的完工也在这个窗口里登记', () => {
  const tasks = [task(2, 'confirmed', '40'), task(3, 'confirmed')];
  const html = batchDialog(tasks, [2]);
  const { primary, more } = actions(html);
  assert.equal(primary, '登记完工');
  assert.match(more, /先登记，稍后核对入库/);
  // 不挂任务的（打样、补做）在同一个窗口里加行登记，不再有单独的“不挂任务单独登记”
  assert.doesNotMatch(html, /不挂任务单独登记/);
  assert.match(html, /不挂任务的完工/);
  // 整个窗口只有一个实心主按钮；先登记不在“更多”外面占按钮
  assert.equal((html.match(/class="primary"/g) || []).length, 1);
  assert.doesNotMatch(html.split('more-menu')[0], /先登记/);
});

test('单张完工登记：不选成品库存，备注叫“批次备注”；别的单据还叫备注', () => {
  const data = { items: [], tasks: [], products: [], orders: [], customers: [], suppliers: [] };
  const production = renderToStaticMarkup(
    h(FlowEditor, {
      kind: 'production',
      value: { kind: 'production', productId: null, taskId: null, goodQuantity: '', scrapQuantity: '0', operator: '', date: '2026-11-05', notes: '', materials: [{ stockId: null, issued: '', returned: '0' }] },
      change: noop,
      data,
    }),
  );
  assert.match(production, /aria-label="批次备注"/);
  assert.doesNotMatch(production, /整单备注|入哪个成品库存|新建成品档案/);
  assert.match(production, /登记时自动新建/);
});

test('登记完工窗口：任务的“还差”和预填的合格数扣掉已登记、待核对入库的；剩下的全在等核对入库的任务不列', () => {
  const tasks = [
    task(2, 'confirmed', '40', { pendingCompleted: '25' }),
    task(3, 'confirmed', '0', { pendingCompleted: '100' }),
    task(4, 'confirmed', '10'),
  ];
  // 第 3 张剩下的 100 只都登记过了：不能再登记
  assert.deepEqual(tasks.filter(completableTask).map((t) => t.id), [2, 4]);
  const one = batchDialog(tasks, [2]);
  // 还差 100 − 40 − 25 = 35，预填的合格数就是 35，服务端不会拒
  assert.match(one, /还差 35 只（另有 25 只已登记、待核对入库）/);
  assert.match(one, /aria-label="SC-虚构-2实际良品"[^>]*value="35"|value="35"[^>]*aria-label="SC-虚构-2实际良品"/);
  // 没有待入库的照旧，不加括号
  const plain = batchDialog(tasks, [4]);
  assert.match(plain, /还差 90 只<\/small>/);
  // 从剩下的全在等核对入库的任务进来：说清先去核对入库
  const none = batchDialog(tasks, [3]);
  assert.match(none, /剩下的数量都已登记、在等核对入库的，先到完工记录里核对入库/);
});

test('领纸板的表：叫“退料”不叫“退回”；必填提示用的读屏名称就是看得见的列名，不出现“原料1”“领用张数1”', () => {
  const html = batchDialog([task(2, 'confirmed', '40')], [2]);
  assert.match(html, /<th class="num">退料（张）<\/th>/);
  assert.doesNotMatch(html, /退回/);
  assert.match(html, /aria-label="第 1 种纸板领用（张）"/);
  assert.match(html, /aria-label="第 1 种纸板退料（张）"/);
  assert.doesNotMatch(html, /原料1|领用张数1|退回张数1/);
  // 单张完工登记同一套名字
  const single = renderToStaticMarkup(
    h(FlowEditor, {
      kind: 'production',
      value: { kind: 'production', date: '2026-11-10', productId: null, taskId: null, goodQuantity: '', scrapQuantity: '0', operator: '', materials: [{ stockId: null, issued: '', returned: '0' }], notes: '' },
      change: noop,
      data: { items: [], products: [], tasks: [] },
    }),
  );
  assert.match(single, /aria-label="第 1 种纸板领用（张）"/);
  assert.match(single, /aria-label="第 1 种纸板退料（张）"/);
  assert.doesNotMatch(single, /原材料品种|实际领用张数|剩余退料张数/);
});

test('单张完工登记：不挂任务的完工不显示任务下拉；编辑挂了任务的待入库完工单才显示，超计划提示算上别的待入库、不算这张自己；完工日期不能选未来', () => {
  const tasks = [{ id: 7, kind: 'task', number: 'SC-虚构-7', productId: 1, quantity: '3', completed: '0', pendingCompleted: '2', unit: '只', status: 'confirmed' }];
  const data = { items: [], tasks, products: [{ id: 1, name: '虚构纸箱' }], orders: [], customers: [], suppliers: [] };
  const base = { kind: 'production' as const, productId: 1, goodQuantity: '2', scrapQuantity: '0', operator: '虚构', notes: '', materials: [{ stockId: null, issued: '', returned: '0' }] };
  const render = (value: ProductionEditing) => renderToStaticMarkup(h(FlowEditor, { kind: 'production', value, change: noop, data }));
  const fresh = render({ ...base, taskId: null, date: '2026-11-05' });
  assert.match(fresh, /完工哪个产品/);
  assert.doesNotMatch(fresh, /完工哪张任务|生产任务|不挂任务/);
  // 完工日期的选择器不能选今天以后
  assert.match(fresh, /aria-label="完工日期" max="\d{4}-\d{2}-\d{2}"/);
  assert.match(render({ ...base, taskId: null, date: '2999-01-01' }), /完工日期不能晚于今天/);
  // 编辑一张挂着任务、已登记 2 只的待入库完工单：任务的待入库 2 只就是它自己，0 + 2 没超计划 3，不提示；
  // 任务选项和提示同一组数，都不算这张自己
  const own = render({ ...base, id: 9, status: 'draft', taskId: 7, goodQuantity: '2', date: '2026-11-05' });
  assert.match(own, /完工哪张任务/);
  assert.match(own, /SC-虚构-7 · 虚构纸箱 · 已完工 0 \/ 3 只 · 不算这张/);
  assert.doesNotMatch(own, /另有 2 只待核对入库/);
  assert.doesNotMatch(own, /超过生产计划数量/);
  // 改成 4 只才超：提示写明不算这张
  assert.match(
    render({ ...base, id: 9, status: 'draft', taskId: 7, goodQuantity: '4', date: '2026-11-05' }),
    /超过生产计划数量（生产任务 SC-虚构-7 计划 3 只，不算这张：已核对入库 0 只）/,
  );
  // 新登记（不是编辑这张）挂上这张任务：待入库的 2 只是别的单，0 + 2 + 2 超了
  const other = render({ ...base, status: 'draft', taskId: 7, goodQuantity: '2', date: '2026-11-05' });
  assert.match(other, /超过生产计划数量（生产任务 SC-虚构-7 计划 3 只，已核对入库 0 只，另有 2 只已登记、待核对入库）/);
  // 扣掉的只有正在编辑的这张待入库单自己；别的任务不扣（已入库的改数量走更正完工单，不在编辑窗里）
  assert.deepEqual(taskCounts(tasks[0], { ownTask: 7, own: true, good: '2' }), { done: 0, waiting: 0, excluded: true });
  assert.equal(taskOptionText({ ...tasks[0], id: 8 }, { ownTask: 7, own: true, good: '2' }), '已完工 0 / 3 只（另有 2 只待核对入库）');
});
