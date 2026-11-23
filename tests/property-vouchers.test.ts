// 凭证的属性测试（fast-check 随机生成）：随机数量、单价、税率口径的送货单生成的凭证借贷相等；
// 随机分录的手工凭证借贷不平的拒收、平的收下；红字冲销后原凭证和冲销凭证每个科目合起来为零（红冲凭证按取负算）；
// 造出来的错账（红冲借贷不平、红冲金额不对）能被抓住。内存库、虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fc from 'fast-check';
import { z } from 'zod';
import { Store } from '../server/core/db.js';
import { count, many, rows } from '../server/core/index.js';
import { FinanceLedger } from '../server/finance/ledger/ledger.js';
import { exactText } from '../shared/core/precision.js';
import { booked, deliveryDoc, ledgerBalance, maker, newSettings, physical, post } from './finance-fixture.js';

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

/** 一张手工凭证：借 1002 银行存款（几行）、贷 3001 实收资本（几行） */
const manualVoucher = (debits: number[], credits: number[]) => ({
  requestId: 'property',
  date: '2026-01-20',
  description: '虚构投入',
  entries: [
    ...debits.map((debit) => ({ accountCode: '1002', debit, credit: 0, cashFlow: '投入资本' })),
    ...credits.map((credit) => ({ accountCode: '3001', debit: 0, credit })),
  ],
});
const total = (list: number[]) => list.reduce((sum, n) => sum + n, 0);

/** 记账一张手工凭证再红字冲销（红冲凭证也记账），回原凭证和红冲凭证的编号 */
function postAndReverse(s: Store, debits: number[], credits: number[]) {
  const ledger = new FinanceLedger(s);
  const id = Number(ledger.create(maker, manualVoucher(debits, credits)).header.id);
  post(s, id);
  const red = Number(ledger.reverse(maker, id, { version: 4, requestId: 'red', date: '2026-01-25', description: '虚构冲销' }).header.id);
  post(s, red);
  return { id, red };
}

const reversalSign = z.object({ id: z.number(), reversal_of: z.number().nullable() });
/**
 * 红字冲销以后原凭证和红冲凭证每个科目合起来为零。红冲凭证的存法（server/finance/ledger.ts 的 reverse）是照抄原凭证的分录、
 * 金额同号，靠 fin_vouchers.reversal_of 标明是红冲；账簿、报表一律按“红冲凭证的借贷取负”算（books.ts、cash-accounts.ts 等的
 * CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END）。这里照同一个口径算，再用总账余额（报表的算法）核对一遍。
 */
function assertReversedOut(s: Store, id: number, red: number) {
  const sign = new Map(
    many(s.db, reversalSign, 'SELECT id,reversal_of FROM fin_vouchers WHERE id IN (?,?)', id, red).map((v) => [v.id, v.reversal_of === null ? 1 : -1]),
  );
  assert.deepEqual([sign.get(id), sign.get(red)], [1, -1], '红冲凭证标着冲的是原凭证');
  const net = new Map<string, number>();
  for (const e of entries(s).filter((x) => x.voucher_id === id || x.voucher_id === red))
    net.set(e.account_code, (net.get(e.account_code) ?? 0) + (sign.get(e.voucher_id) ?? 0) * (e.debit - e.credit));
  for (const [account, value] of net) assert.equal(value, 0, '科目 ' + account + ' 冲销后没归零');
  for (const code of ['1002', '3001']) assert.equal(ledgerBalance(s, code), 0, '总账 ' + code + ' 冲销后没归零');
}

test('手工凭证：借贷合计不等的拒收，库里不多一张', () => {
  const amounts = fc.array(fc.integer({ min: 1, max: 10_000_000 }), { minLength: 1, maxLength: 4 });
  fc.assert(
    fc.property(
      fc.tuple(amounts, amounts).filter(([debits, credits]) => total(debits) !== total(credits)),
      ([debits, credits]) => {
        const s = new Store(':memory:');
        try {
          newSettings(s);
          assert.throws(() => new FinanceLedger(s).create(maker, manualVoucher(debits, credits)), /借贷必须平衡/);
          assert.equal(count(s.db, 'SELECT count(*) AS n FROM fin_vouchers'), 0);
        } finally {
          s.close();
        }
      },
    ),
    { numRuns: 25 },
  );
});

/** 借方几行，贷方把同一个合计拆成 parts 行（每行至少 1 分）：借贷一定平 */
const balanced = fc
  .tuple(fc.array(fc.integer({ min: 1, max: 10_000_000 }), { minLength: 1, maxLength: 4 }), fc.integer({ min: 1, max: 4 }))
  .map(([debits, parts]) => {
    const sum = total(debits),
      rows = Math.min(parts, sum),
      each = Math.floor(sum / rows);
    return { debits, credits: [...Array<number>(rows - 1).fill(each), sum - each * (rows - 1)] };
  });

test('手工凭证：借贷合计相等的收下，红字冲销后每张凭证借贷相等、每个科目合起来为零', () => {
  fc.assert(
    fc.property(balanced, ({ debits, credits }) => {
      const s = new Store(':memory:');
      try {
        newSettings(s);
        const { id, red } = postAndReverse(s, debits, credits);
        assertBalanced(s);
        assertReversedOut(s, id, red);
      } finally {
        s.close();
      }
    }),
    // 固定样例：原来的写法把红冲凭证的分录直接相加，借贷合计相等（只有这时才走到红冲）就报“冲销后没归零”
    { numRuns: 25, examples: [[{ debits: [7], credits: [7] }], [{ debits: [3, 4], credits: [5, 2] }]] },
  );
});

test('真的错账能被抓住：红冲凭证借贷不平、或者红冲金额和原凭证对不上', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const { id, red } = postAndReverse(s, [700], [700]);
    assertBalanced(s);
    assertReversedOut(s, id, red);
    // 不经程序直接改库，造两种错账（虚构数据）
    s.db.prepare('UPDATE fin_entries SET debit=debit+1 WHERE voucher_id=? AND debit>0').run(red);
    assert.throws(() => assertBalanced(s), /借贷不平/, '红冲凭证借贷不平');
    s.db.prepare('UPDATE fin_entries SET credit=credit+1 WHERE voucher_id=? AND credit>0').run(red);
    assertBalanced(s);
    assert.throws(() => assertReversedOut(s, id, red), /冲销后没归零/, '借贷平了、但红冲金额比原凭证多 1 分');
  } finally {
    s.close();
  }
});
