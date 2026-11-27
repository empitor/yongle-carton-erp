// 订单税费“没认出来”的提示按现在填的税率、选的含税口径判断（shared/core/tax-rate.ts 的 hasUnrecognizedTax、orderTaxOriginal）：
// 编辑窗自动展开和税率框下的提示、订单详情和卡片的税费、修改历史的原件写法。升级记下的“口径：…”还留在原话里，
// 口径改选过了就不再叫人改选，没选的照样提示。纯函数和渲染成 HTML，虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import OrderEditor from '../../src/editors/OrderEditor.js';
import { cardContents, orderTaxText } from '../../shared/business/index.js';
import { fieldLabel, fieldTitle, trackedOrderViewSchema } from '../../shared/core/index.js';

const MODE_PROMPT = /含税口径没认出来/;

test('订单详情和卡片的税费：口径改选过了只列原件写法，没选的只说没认出来（只读的地方不叫人去选）', () => {
  assert.equal(
    orderTaxText({ taxRate: 13, taxMode: '含税', taxText: '13\n口径：含税价' }),
    '13% 含税 · 原件写法：13\n口径：含税价',
  );
  assert.equal(orderTaxText({ taxRate: 13, taxText: '13\n口径：含税价' }), '13% · 含税口径没认出来，原件写的是“含税价”。');
  assert.equal(
    orderTaxText({ taxText: '13个点\n口径：含税价' }),
    '税率没认出来，原件写的是“13个点”。含税口径没认出来，原件写的是“含税价”。',
  );
});

test('修改历史的原件写法：有要核对的才说（口径没选、税率没认出来），只读不叫人去选；口径改选过了照原样列', () => {
  const shown = (row: Record<string, unknown>) =>
    cardContents('orders', row, {}).find((item) => item.label === '原件写法')?.value;
  assert.equal(shown({ taxMode: '含税', taxText: '口径：含税价' }), '口径：含税价');
  assert.equal(shown({ taxRate: 13, taxMode: '含税', taxText: '13\n口径：含税价' }), '13\n口径：含税价');
  assert.equal(shown({ taxText: '口径：含税价' }), '含税口径没认出来，原件写的是“含税价”。');
  assert.match(shown({ taxRate: 13, taxText: '13\n口径：含税价' }) ?? '', MODE_PROMPT, '税率认出来了、口径没选也说');
  assert.equal(shown({ taxMode: '含税', taxText: '13个点' }), '税率没认出来，原件写的是“13个点”。');
});

/**
 * 编辑窗打开一张老订单：整单、明细的原话里都留着升级记下的“口径：…”，口径分别选成 headMode、lineMode（空串是没选）；
 * head 换整单的税率和原话（默认 13%、“13\n口径：含税价”）
 */
function editorHtml(headMode: string, lineMode: string, head: { taxRate?: number; taxText?: string } = {}) {
  const line = { productId: 1, productName: '虚构外箱', unit: '只', specification: '', notes: '', shippedQuantity: 0, shippingStatus: '未发货' };
  const value = trackedOrderViewSchema.parse({
    id: 1,
    number: 'SO-虚构-1',
    version: 1,
    customerId: 1,
    customerName: '虚构客户',
    orderDate: '2026-11-01',
    deliveryDate: '2026-11-20',
    status: '已确认',
    shippingProgress: '未发货',
    shippingSummary: { progress: '未发货', completedLines: 0, totalLines: 1 },
    materialProgress: 'none',
    notes: '',
    costs: null,
    totalCents: 15000,
    costCents: null,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    taxRate: 13,
    taxText: '13\n口径：含税价',
    ...head,
    taxMode: headMode || undefined,
    lines: [
      {
        ...line, id: 11, quantity: 100, remainingQuantity: 100, unitPriceExact: '1.5', unitPriceCents: 150,
        taxMode: lineMode || undefined, taxText: '口径：开票另计',
      },
    ],
  });
  return renderToStaticMarkup(h(OrderEditor, { customers: [], products: [], close: () => {}, saved: () => {}, value }));
}

/** 编辑窗里按格子标题找那一格下面的说明（FormField 的 hint）；没有说明是空串 */
function hintOf(html: string, label: string | undefined) {
  assert.ok(label, '格子标题没有叫法');
  const field = html
    .split('<label class="field form-field')
    .map((part) => part.split('</label>')[0])
    .find((part) => part.includes('<span class="form-field-label">' + label + '<'));
  assert.ok(field, '编辑窗里没有“' + label + '”这一格');
  return /<small class="form-field-hint">([\s\S]*?)<\/small>/.exec(field)?.[1] ?? '';
}
const LINE = { record: 'orders', parent: 'lines' };

test('订单编辑窗：税率格只说税率那段原话，口径那句挂在含税口径格下面，一格最多一句', () => {
  const html = editorHtml('', '', { taxRate: undefined, taxText: '13个点\n口径：含税价' });
  assert.equal(hintOf(html, fieldTitle('taxRate')), '税率没认出来，原件写的是“13个点”，请选择或填写税率。');
  assert.equal(hintOf(html, fieldLabel('taxMode')), '含税口径没认出来，原件写的是“含税价”，请选择含税口径。');
  // 明细的原话只有口径那段：税率格没有说明，提示在本项含税口径格
  assert.equal(hintOf(html, fieldTitle('taxRate', LINE)), '', '原话里没有税率那段，税率格不写');
  assert.equal(hintOf(html, fieldLabel('taxMode', LINE)), '含税口径没认出来，原件写的是“开票另计”，请选择含税口径。');
  // 税率认得出、原话带口径：税率格只列税率那段，口径原话不在这一格重复
  const recognized = editorHtml('', '');
  assert.equal(hintOf(recognized, fieldTitle('taxRate')), '原件写法：13');
  assert.equal(hintOf(recognized, fieldLabel('taxMode')), '含税口径没认出来，原件写的是“含税价”，请选择含税口径。');
  const chosen = editorHtml('含税', '未税');
  assert.equal(hintOf(chosen, fieldTitle('taxRate')), '原件写法：13');
  assert.equal(hintOf(chosen, fieldLabel('taxMode')), '', '口径选过了，口径格没有说明');
  assert.equal(hintOf(chosen, fieldLabel('taxMode', LINE)), '', '口径选过了，本项含税口径格也没有说明');
});

test('订单编辑窗：口径没选的老订单自动展开“更多信息”和那一行、提示改选；改选过了不再展开、不再提示', () => {
  const unchosen = editorHtml('', '');
  assert.match(unchosen, /<details class="sales-more-info"[^>]*\bopen=""/, '整单口径没选：“更多信息”展开');
  assert.doesNotMatch(unchosen, /<tr class="sales-line-extra"[^>]*\bhidden=""/, '明细口径没选：那一行展开');
  assert.match(unchosen, /含税口径没认出来，原件写的是“含税价”/);
  assert.match(unchosen, /含税口径没认出来，原件写的是“开票另计”/);
  const chosen = editorHtml('含税', '未税');
  assert.doesNotMatch(chosen, /<details class="sales-more-info"[^>]*\bopen=/, '整单口径选过了：“更多信息”收着');
  assert.match(chosen, /<tr class="sales-line-extra"[^>]*\bhidden=""/, '明细口径选过了：那一行收着');
  assert.doesNotMatch(chosen, MODE_PROMPT);
});
