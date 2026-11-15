// 单据页的详情（src/flow/FlowDetails.tsx）：到货明细的入库数、生产任务的完工进度。只渲染，不碰数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { flowViewSchema } from '../shared/business/index.js';
import FlowDetails from '../src/flow/FlowDetails.js';

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
