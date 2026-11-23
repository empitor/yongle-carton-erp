// 仓库页的到货、送货（src/warehouse/）：到货明细的排法，列表的筛选排序，
// 更正到货单窗口交给服务端的输入（src/flow/arrival-correction.ts）。
// 只渲染和纯函数，不碰数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ArrivalLines } from '../../src/flow/DocLines.js';
import { partyChoices, warehouseRows } from '../../src/warehouse/warehouse-list.js';
import { flowStatusChoices, matchesFlowStatus } from '../../shared/business/index.js';
import { correctionHead, correctionInput, correctionRows, newCorrectionRow } from '../../src/flow/arrival-correction.js';

test('到货明细：采购单和到货进度放在纸板下面一行，表格只有四列，详情窄时不横向撑出去', () => {
  const html = renderToStaticMarkup(
    h(ArrivalLines, {
      confirmed: true,
      lines: [
        {
          item: { name: '虚构E三层', unit: '张', length: 800, width: 600, dimensionUnit: 'mm' },
          quantity: '1100',
          acceptedQuantity: '1100',
          rejectedQuantity: '0',
          stockedQuantity: '1100',
          purchaseId: 3,
          purchaseNumber: 'CG-20261103-0001',
          orderedQuantity: '1100',
          receivedQuantity: '0',
          remainingQuantity: '1100',
          arrivalStatus: '未到货',
        },
        { item: { name: '虚构衬板', unit: '张' }, quantity: '20', differenceReason: '虚构补货' },
      ],
    }),
  );
  assert.equal((html.match(/<th[ >]/g) || []).length, 4);
  assert.doesNotMatch(html, /<th>采购单<\/th>/);
  assert.match(html, /采购单 <a class="nowrap" href="#purchases\?record=3">CG-20261103-0001<\/a> · 订 1100 · 已到 0 · 还差 1100 · 未到货/);
  assert.match(html, /无采购单<\/small><small>虚构补货<\/small>/);
});

test('到货、送货列表：待处理只列还要办的，按日期先后；全部里待处理的排前面；按客户、状态筛，状态和单据页同一份叫法', () => {
  const rows = [
    { id: 1, status: 'confirmed', shippedAt: '2026-11-03T02:00:00.000Z', deliveredAt: '2026-11-04', date: '2026-11-03', customerId: 1, customerName: '虚构甲', lines: [] },
    { id: 2, status: 'draft', pending: true, plannedDate: '2026-11-10', customerId: 2, customerName: '虚构乙', lines: [] },
    { id: 3, status: 'draft', pending: true, plannedDate: '2026-11-08', customerId: 1, customerName: '虚构甲', lines: [] },
  ] as Parameters<typeof warehouseRows>[1];
  type Filter = Parameters<typeof warehouseRows>[2];
  const filters = { scope: 'all', q: '', party: '', status: '', from: '', to: '', purchases: [] } satisfies Filter;
  const ids = (over: Partial<Filter>) =>
    warehouseRows('delivery', rows, { ...filters, ...over }).map((r) => r.id);
  assert.deepEqual(ids({ scope: 'open' }), [3, 2]);
  assert.deepEqual(ids({ scope: 'all' }), [2, 3, 1]);
  assert.deepEqual(ids({ scope: 'all', party: 'c1' }), [3, 1]);
  assert.deepEqual(partyChoices(rows), [['c1', '虚构甲'], ['c2', '虚构乙']]);
  assert.deepEqual(ids({ scope: 'all', status: '待送货' }), [2, 3]);
  assert.deepEqual(ids({ scope: 'all', status: '已送达' }), [1]);
  assert.equal(matchesFlowStatus({ status: 'reversed', replacedBy: 9 }, 'arrival', '已更正'), true);
  assert.ok(flowStatusChoices.arrival.every((s) => !/计划/.test(s)));
});

test('更正到货单的输入：按到货单取数，只传改了的；验收数没动不传（服务端按原批次算）；管理员改单价、加删行也只写改了的', () => {
  const arrival = {
    id: 7,
    version: 3,
    date: '2026-11-10',
    reference: 'GYS-虚构-1',
    supplierId: 2,
    lines: [
      { item: { name: '虚构甲纸板' }, quantity: '1000', acceptedQuantity: '1000', rejectedQuantity: '0', stockedQuantity: '1000', stockId: 5, purchaseLineId: 9, unitPrice: '2', priceBasis: 'quantity' as const },
      { item: { name: '虚构乙纸板' }, quantity: '50', acceptedQuantity: '50', rejectedQuantity: '0', stockedQuantity: '50', stockId: 6, purchaseLineId: null, unitPrice: null, priceBasis: 'area' as const },
    ],
  };
  const head = correctionHead(arrival),
    rows = correctionRows(arrival);
  assert.equal(correctionInput(arrival, head, rows, '虚构').changed, false, '没改不去核验');
  // 业务员只改数量
  const less = rows.map((r, i) => (i === 0 ? { ...r, quantity: '900' } : r));
  assert.deepEqual(correctionInput(arrival, head, less, ' 点错数量 ').input, {
    expectedVersion: 3,
    reason: '点错数量',
    lines: [{ index: 0, quantity: '900' }, { index: 1, quantity: '50' }],
  });
  // 动过验收数才传
  const inspected = rows.map((r, i) => (i === 0 ? { ...r, quantity: '900', acceptedQuantity: '890', rejectedQuantity: '10', stockedQuantity: '', touched: true } : r));
  assert.deepEqual(correctionInput(arrival, head, inspected, 'x').input.lines[0], { index: 0, quantity: '900', acceptedQuantity: '890', rejectedQuantity: '10' });
  // 本机管理员改单价、删第二行、加一行（新行写全）
  const added = { ...newCorrectionRow(), item: { name: '虚构丙纸板' }, quantity: '30', stockId: 8, priceBasis: 'quantity' as const };
  const admin = correctionInput(arrival, { ...head, reference: 'GYS-虚构-2' }, [{ ...rows[0], unitPrice: '2.5' }, added], 'x');
  assert.equal(admin.changed, true);
  assert.deepEqual(admin.input, {
    expectedVersion: 3,
    reason: 'x',
    reference: 'GYS-虚构-2',
    lines: [
      { index: 0, quantity: '1000', unitPrice: '2.5' },
      { item: { name: '虚构丙纸板' }, quantity: '30', stockId: 8, priceBasis: 'quantity' },
    ],
  });
});
