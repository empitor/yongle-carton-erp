// 月末税费计提怎么算（server/finance/closing-tax.ts 的 taxPlan）：附加税、所得税的分录和缺税率时的提示。全部虚构数据，内存库。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/core/index.js';
import { FinanceSettings } from '../server/finance/base/settings.js';
import { FinanceLedger } from '../server/finance/ledger/ledger.js';
import { entry } from '../server/finance/base/query.js';
import { taxPlan } from '../server/finance/reports/closing-tax.js';
import { maker, newSettings, post } from './finance-fixture.js';

const period = '2026-01';
/** 各税率（万分之几，没填是 null）；不给的项按 0 */
type Rates = { smallVat?: number | null; urban?: number | null; education?: number | null; localEducation?: number | null; income?: number | null };
const zeroRates = { smallVat: null, urban: 0, education: 0, localEducation: 0, income: 0 };

/** 一般纳税人启用 2026-01（newSettings），再把税率改成给的 */
function general(rates: Rates) {
  const s = new Store(':memory:');
  newSettings(s, period);
  new FinanceSettings(s).update(maker, { version: 3, requestId: 'rates-test', taxRates: { ...zeroRates, ...rates } });
  return s;
}

/** 记一张 1 月 10 日的收入凭证并记账：收款 net + vat 分，主营业务收入 net 分，销项税额 vat 分 */
function income(s: Store, net: number, vat: number) {
  const voucher = new FinanceLedger(s).create(maker, {
    requestId: 'income-' + net + '-' + vat,
    date: period + '-10',
    description: '虚构收入',
    entries: [
      entry('1002', net + vat, 0, null, '销售商品收到的现金'),
      entry('5001', 0, net),
      ...(vat ? [entry('22210102', 0, vat)] : []),
    ],
  });
  post(s, voucher.header.id);
}

test('一般纳税人有应交增值税：附加税按应交增值税乘各税率，借税金及附加、贷各附加税；所得税按扣掉附加税的利润算', () => {
  const s = general({ urban: 700, education: 300, localEducation: 200, income: 2500 });
  try {
    income(s, 10000, 1300);
    const plan = taxPlan(s, maker, period);
    assert.deepEqual(
      plan.entries.map((e) => [e.accountCode, e.debit, e.credit]),
      [
        ['5403', 156, 0],
        ['222102', 0, 91],
        ['222103', 0, 39],
        ['222104', 0, 26],
        ['5801', 2461, 0],
        ['222105', 0, 2461],
      ],
      '应交增值税 13 元：城建 7%、教育费附加 3%、地方教育附加 2%；所得税 (100 - 1.56) × 25%',
    );
    assert.deepEqual([plan.details.pretax, plan.details.income], [10000, 2461]);
  } finally {
    s.close();
  }
});

test('一般纳税人有应交增值税但附加税率没填：报请填附加税率，不算出计提', () => {
  const s = general({ urban: null });
  try {
    income(s, 10000, 1300);
    assert.throws(() => taxPlan(s, maker, period), /本月有应交增值税，请到财务设置填写附加税率/);
  } finally {
    s.close();
  }
});

test('本月有利润但所得税率没填：报请填所得税率；没利润时不用填', () => {
  const s = general({ income: null });
  try {
    assert.deepEqual(taxPlan(s, maker, period).entries, [], '没利润、没增值税：不用填，也没有分录');
    income(s, 10000, 0);
    assert.throws(() => taxPlan(s, maker, period), /本月有利润，请到财务设置填写所得税率/);
  } finally {
    s.close();
  }
});

test('小规模纳税人没填征收率：报请填小规模征收率', () => {
  const s = new Store(':memory:');
  try {
    const settings = new FinanceSettings(s);
    settings.enable(maker, { period, taxpayer: 'small', version: 1, requestId: 'enable', rows: [] });
    settings.update(maker, { version: 2, requestId: 'rates', taxRates: zeroRates });
    assert.throws(() => taxPlan(s, maker, period), /请到财务设置填写小规模征收率/);
  } finally {
    s.close();
  }
});
