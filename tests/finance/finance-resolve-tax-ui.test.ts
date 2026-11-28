// 财务页面上的税率，和补扫认税率同一套（shared/finance 的 financeTaxRateReady、documentTaxRate）：
// 单张补税率按这一行税率从哪来预填，认不出的不预填（src/finance/flow/ResolveTax.tsx 的 resolveLine）；
// 来源单据详情的税率财务认得出的一律带 %，认不出的标出来（src/finance/SourceDetail.tsx）。纯函数和渲染成 HTML，虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { resolveLine } from '../../src/finance/flow/ResolveTax.js';
import { SourceDetail } from '../../src/finance/SourceDetail.js';
import { readSourceDetail, type SourceLine, type SourceRow } from '../../src/finance/source-detail-view.js';

/** 补税率表的一行：金额 100、口径含税，税率 rate、从 source 来 */
const fill = (rate: string, source: string | null) => resolveLine({ exact: '100', rate, mode: '含税' }, source);
const filled = (rate: string) => ({ line: { exact: '100', rate, mode: '含税' }, hint: '' });
/** 框里空着；原来写了的，格子下面和单据明细的税率格同一个说法“没认出来：…” */
const empty = (original: string) => ({ line: { exact: '100', rate: '', mode: '含税' }, hint: original ? '没认出来：' + original : '' });

test('单张补税率：单据抄来的税率财务认得出才填；认不出的（没带 % 的 0.13、三位小数、13个点、老快照里的全角和带空格的）框里空着，原来写的放在格子下面', () => {
  for (const [rate, shown] of [['13', '13'], ['13%', '13'], ['0.5%', '0.5'], ['13.50', '13.50'], ['0', '0']])
    assert.deepEqual(fill(rate, 'line'), filled(shown), rate);
  for (const rate of ['0.13', '13.125', '13个点', '１３％', '13 %', ' 0.13 ']) assert.deepEqual(fill(rate, 'line'), empty(rate.trim()), rate);
  assert.deepEqual(fill('', null), empty(''));
  // 缺价格的没有补过的财务行，取单据明细上的（来源就是单据）：认不出的口径（带“口径：”的原话）也空着让人选
  const docLine: SourceLine = { taxRate: '0.13', taxMode: '口径：含税价' };
  assert.deepEqual(resolveLine(docLine, 'line'), { line: { exact: '', rate: '', mode: '' }, hint: '没认出来：0.13' });
});

test('单张补税率：往来单位默认的税率照往来条款认（0.5 就是 0.5%、最多六位小数），和补扫、批量补一个说法；往来条款也不收的才空着', () => {
  for (const [rate, shown] of [['0.5', '0.5'], ['13.123456', '13.123456'], ['6%', '6']]) assert.deepEqual(fill(rate, 'party'), filled(shown), rate);
  assert.deepEqual(fill('13.1234567', 'party'), empty('13.1234567'));
  // 补税率窗口从快照里读得到每行税率从哪来
  const detail = readSourceDetail({ financialLines: [{ exact: '100', rate: '0.5', mode: '含税' }], taxSource: [{ rate: 'party', mode: 'line' }] });
  assert.deepEqual(detail.taxSource, [{ rate: 'party', mode: 'line' }]);
});

/** 月度台账一行：一张送货单，明细按 lines 给 */
const sourceRow = (lines: SourceLine[]): SourceRow => ({
  metric: 'theoreticalIncome',
  id: 1,
  date: '2026-10-20',
  source_month: '2026-10',
  source_id: '1',
  number: 'FICT-1',
  party: '虚构客户',
  amount: 1000,
  detail: { doc: { lines } },
  status: 'info_pending',
  due_date: null,
  paid: 0,
  missing_tax: 1,
});
/** 单据明细表里品名是 name 的那一行的税率格（口径小字之前） */
function rateCell(html: string, name: string) {
  const row = html.split('<tr>').find((r) => r.startsWith('<td>' + name + '</td>'));
  assert.ok(row, '单据明细里没有“' + name + '”这一行');
  return (row.split('<td>').at(-1) ?? '').replace(/<small>[\s\S]*$/, '');
}

test('财务来源详情的税率和补扫同一套认法：认得出的一律带 %，认不出的原话照写并标出没认出来，没写的写“税率未填”', () => {
  const cases: [string | undefined, string][] = [
    ['13', '13%'],
    ['1.5', '1.5%'],
    ['0.5%', '0.5%'],
    ['13%', '13%'],
    ['0.13', '<span class="fb-warn">没认出来：0.13</span>'],
    ['13个点', '<span class="fb-warn">没认出来：13个点</span>'],
    // 升级前抄进快照的全角、带空格的写法：财务记待补税率，详情也照实写没认出来
    ['１３％', '<span class="fb-warn">没认出来：１３％</span>'],
    ['13 %', '<span class="fb-warn">没认出来：13 %</span>'],
    [undefined, '<span class="fb-warn">税率未填</span>'],
  ];
  const lines = cases.map(([taxRate], i) => ({ productName: '虚构纸箱' + i, quantity: '1', unit: '只', unitPriceExact: '1.0000', taxRate, taxMode: '含税' }));
  const html = renderToStaticMarkup(h(SourceDetail, { row: sourceRow(lines) }));
  cases.forEach(([taxRate, shown], i) => assert.equal(rateCell(html, '虚构纸箱' + i), shown, String(taxRate)));
});
