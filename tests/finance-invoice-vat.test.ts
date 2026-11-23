// 税务底稿：增值税留抵按月滚动（全部是虚构数据，只用内存库）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/core/index.js';
import { FinanceLedger } from '../server/finance/ledger/ledger.js';
import { entry } from '../server/finance/base/query.js';
import { FinanceTax } from '../server/finance/base/vat.js';
import { maker, newSettings, post } from './finance-fixture.js';

test('增值税留抵按月滚动：上月期末留抵等于本月上期留抵，交过税的月份不吃掉后面的留抵', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const ledger = new FinanceLedger(s),
      tax = new FinanceTax(s);
    let n = 0;
    const book = (date: string, output: number, input: number) => {
      const entries = [
        ...(output ? [entry('1403', output, 0), entry('22210102', 0, output)] : []),
        ...(input ? [entry('22210101', input, 0), entry('1403', 0, input)] : []),
      ];
      post(
        s,
        ledger.create(maker, { requestId: 'vat-' + n++, date, description: '虚构税额', entries })
          .header.id,
      );
    };
    book('2026-01-20', 1000, 300);
    book('2026-02-20', 100, 500);
    book('2026-03-20', 300, 0);
    const jan = tax.worksheet(maker, { period: '2026-01' }),
      feb = tax.worksheet(maker, { period: '2026-02' }),
      mar = tax.worksheet(maker, { period: '2026-03' }),
      apr = tax.worksheet(maker, { period: '2026-04' });
    assert.deepEqual(
      [jan.carryIn, jan.payable, jan.carryOut],
      [0, 700, 0],
      '1 月销项 10 元、进项 3 元，应交 7 元',
    );
    assert.deepEqual([feb.carryIn, feb.payable, feb.carryOut], [0, 0, 400], '2 月期末留抵 4 元');
    assert.deepEqual(
      [mar.output, mar.input, mar.carryIn, mar.payable, mar.carryOut],
      [300, 0, 400, 0, 100],
      '3 月上期留抵 4 元，抵掉 3 元销项后还留抵 1 元',
    );
    assert.equal(mar.carryIn, feb.carryOut, '本月上期留抵等于上月期末留抵');
    assert.deepEqual([apr.carryIn, apr.payable, apr.carryOut], [100, 0, 100], '没有发生额的月份留抵照转');
  } finally {
    s.close();
  }
});

test('期初进项留抵作为启用月的上期留抵', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s, '2026-01', [
      { accountCode: '22210101', debit: 500, credit: 0, yearDebit: 0, yearCredit: 0 },
      { accountCode: '3001', debit: 0, credit: 500, yearDebit: 0, yearCredit: 0 },
    ]);
    const ledger = new FinanceLedger(s),
      tax = new FinanceTax(s);
    for (const [i, date] of ['2026-01-20', '2026-02-20'].entries())
      post(
        s,
        ledger.create(maker, {
          requestId: 'out-' + i,
          date,
          description: '虚构销项',
          entries: [entry('1403', 300, 0), entry('22210102', 0, 300)],
        }).header.id,
      );
    const jan = tax.worksheet(maker, { period: '2026-01' }),
      feb = tax.worksheet(maker, { period: '2026-02' });
    assert.deepEqual([jan.carryIn, jan.payable, jan.carryOut], [500, 0, 200]);
    assert.deepEqual([feb.carryIn, feb.payable, feb.carryOut], [200, 100, 0]);
  } finally {
    s.close();
  }
});
