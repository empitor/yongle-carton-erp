// 凭证的属性测试（fast-check 随机生成）：随机数量、单价、税率口径的送货单生成的凭证借贷相等；
// 随机分录的手工凭证借贷不平的拒收、平的收下；红字冲销后原凭证和冲销凭证每个科目合起来为零。内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { Store } from '../server/core/db.js';
import { count, many, rows } from '../server/core/index.js';
import { FinanceLedger } from '../server/finance/ledger.js';
import { exactText } from '../shared/core/precision.js';
import { booked, deliveryDoc, maker, newSettings, physical, post } from './finance-fixture.js';

const entryRows = rows.fin_entries.pick({ voucher_id: true, account_code: true, debit: true, credit: true });
const entries = (s: Store) =>
  many(s.db, entryRows, 'SELECT voucher_id,account_code,debit,credit FROM fin_entries ORDER BY voucher_id,position');

/** 每张凭证借方合计等于贷方合计 */
function assertBalanced(s: Store) {
  const sums = new Map<number, bigint>();
  for (const e of entries(s)) sums.set(e.voucher_id, (sums.get(e.voucher_id) ?? 0n) + BigInt(e.debit) - BigInt(e.credit));
  assert.ok(sums.size > 0);
  for (const [id, diff] of sums) assert.equal(diff, 0n, '凭证 ' + id + ' 借贷不平');
}

test('随机数量、单价、税率口径的送货单生成的每张凭证借贷相等', () => {
  // 合计不足一元的不要：金额取整成 0 分的事件本来就不能制单
  const line = fc
    .record({
      quantity: fc.integer({ min: 1, max: 5000 }),
      priceUnits: fc.bigInt({ min: 1n, max: 100_000_000n }),
      taxMode: fc.constantFrom('含税', '未税', '不含税'),
      taxRate: fc.constantFrom('0', '1', '3', '6', '9', '13'),
    })
    .filter((l) => l.priceUnits * BigInt(l.quantity) >= 10_000n);
  fc.assert(
    fc.property(line, (l) => {
      const s = new Store(':memory:');
      try {
        newSettings(s);
        const doc = deliveryDoc(String(l.quantity), { price: exactText(l.priceUnits), line: { taxMode: l.taxMode, taxRate: l.taxRate } });
        physical(s, 1, 'delivery', '2026-01-20', doc);
        booked(s, 1, 'delivery');
        assertBalanced(s);
      } finally {
        s.close();
      }
    }),
    { numRuns: 12 },
  );
});

test('手工凭证：借贷合计不等的拒收、库里不多一张；相等的收下，红字冲销后每个科目合起来为零', () => {
  const amounts = fc.array(fc.integer({ min: 1, max: 10_000_000 }), { minLength: 1, maxLength: 4 });
  fc.assert(
    fc.property(amounts, amounts, (debits, credits) => {
      const s = new Store(':memory:');
      try {
        newSettings(s);
        const ledger = new FinanceLedger(s);
        const voucher = {
          requestId: 'property',
          date: '2026-01-20',
          description: '虚构投入',
          entries: [
            ...debits.map((debit) => ({ accountCode: '1002', debit, credit: 0, cashFlow: '投入资本' })),
            ...credits.map((credit) => ({ accountCode: '3001', debit: 0, credit })),
          ],
        };
        const total = (list: number[]) => list.reduce((sum, n) => sum + n, 0);
        if (total(debits) !== total(credits)) {
          assert.throws(() => ledger.create(maker, voucher), /借贷必须平衡/);
          assert.equal(count(s.db, 'SELECT count(*) AS n FROM fin_vouchers'), 0);
          return;
        }
        const id = Number(ledger.create(maker, voucher).header.id);
        post(s, id);
        const red = Number(ledger.reverse(maker, id, { version: 4, requestId: 'red', date: '2026-01-25', description: '虚构冲销' }).header.id);
        assertBalanced(s);
        const net = new Map<string, number>();
        for (const e of entries(s).filter((x) => x.voucher_id === id || x.voucher_id === red))
          net.set(e.account_code, (net.get(e.account_code) ?? 0) + e.debit - e.credit);
        for (const [account, value] of net) assert.equal(value, 0, '科目 ' + account + ' 冲销后没归零');
      } finally {
        s.close();
      }
    }),
    { numRuns: 25 },
  );
});
