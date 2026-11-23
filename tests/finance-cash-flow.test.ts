// 收付款和资金：多付转抵撤销、资金日报、收付计划（全部是虚构数据，只用内存库）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/core/db.js';
import { FinanceEvents } from '../server/finance/events/events.js';
import { FinanceParties } from '../server/finance/parties/parties.js';
import { FinanceInvoices } from '../server/finance/cash/invoices.js';
import { FinanceDue } from '../server/finance/parties/due.js';
import { FinanceStatements } from '../server/finance/parties/statements.js';
import { FinanceEventVouchers } from '../server/finance/events/event-voucher.js';
import { FinanceAllocations } from '../server/finance/cash/allocations.js';
import { FinanceCashAccounts } from '../server/finance/cash/cash-accounts.js';
import { FinanceInvoiceConfirm } from '../server/finance/cash/invoice-confirm.js';
import { maker, newSettings, postDrafts, physical, deliveryDoc, event, obligation, obligationRow, funds, bill, ledgerBalance, subledger, invoicedPayable } from './finance-fixture.js';
import { cashEntries, type CashRow } from '../server/finance/cash/cash-posting.js';
import { count, one, rows } from '../server/core/index.js';

const versionOf = (s: Store, id: number) => Number(obligationRow(s, id).version);

/** 应付逐笔里这笔的余额（找不到就让测试失败） */
function payableBalance(s: Store, id: number) {
  const row = new FinanceParties(s).obligations(maker, { kind: 'payable' }).rows.find((r) => r.id === id);
  assert.ok(row, '应付逐笔里有往来 ' + id);
  return Number(row.balance);
}

/** 01-28 把 from 那笔多付的 amount 分转抵到 to 那笔 */
const transferCredit = (s: Store, from: number, to: number, amount: number) =>
  new FinanceAllocations(s).transferCredit(maker, {
    requestId: 'transfer',
    date: '2026-01-28',
    from: { id: from, version: versionOf(s, from) },
    to: { id: to, version: versionOf(s, to) },
    amount,
  });

/** 到货 1 开 100 元蓝票的应付，01-20 全额付清，01-22 红票冲掉 30 元：多付 30。返回收付款服务、那笔应付和付款单编号 */
function overpaidPayable(s: Store) {
  const cash = newSettings(s);
  const first = invoicedPayable(s, 1, '2026-01-15', 'BLUE-1');
  const cashId = funds(s, cash, { kind: 'payment', date: '2026-01-20', amount: 10000 }, [
    { obligationId: first.id, version: versionOf(s, first.id), amount: 10000 },
  ]);
  const red = new FinanceInvoices(s).create(
    maker,
    bill('purchase', 'RED-1', { date: '2026-01-22', net: -3000, gross: -3000, originalId: first.blue.id }),
  );
  new FinanceInvoiceConfirm(s).confirm(maker, red.id, { version: 1, requestId: 'confirm-red', counterAccount: '1403' });
  postDrafts(s);
  return { cash, first, cashId };
}

test('多付转抵两笔一起撤销，一张红冲凭证；撤销原核销后资金单也能撤销，明细和总账一致', () => {
  const s = new Store(':memory:');
  try {
    const { cash, first, cashId } = overpaidPayable(s);
    const statement = () =>
      new FinanceStatements(s).statement(maker, { kind: 'payable', partyId: '1', from: '2026-01-01', to: '2026-01-31' }).closing;
    assert.equal(statement(), -3000, '红票后多付 30 元，对账单期末显示 −30');
    const second = invoicedPayable(s, 2, '2026-01-25', 'BLUE-2');
    const before = statement();
    transferCredit(s, first.id, second.id, 3000);
    postDrafts(s);
    const [original, out, into] = s.db.prepare('SELECT * FROM fin_allocations WHERE cash_id=? ORDER BY id').all(cashId);
    assert.equal(out.voucher_id, into.voucher_id, '转出、转入共用一张对冲凭证');
    const result = new FinanceAllocations(s).revoke(maker, into.id, {
      version: Number(into.version),
      requestId: 'revoke-transfer',
      date: '2026-01-29',
      reason: '虚构转错了',
    });
    assert.equal(Number(result.paired?.id), Number(out.id));
    const reds = s.db
      .prepare("SELECT id FROM fin_vouchers WHERE reversal_of=? AND status<>'void'")
      .all(out.voucher_id);
    assert.equal(reds.length, 1, '只生成一张红冲凭证');
    const reversals = s.db
      .prepare('SELECT * FROM fin_allocations WHERE reversal_of IN (?,?) ORDER BY reversal_of')
      .all(out.id, into.id);
    assert.deepEqual(
      reversals.map((r) => [Number(r.amount_cents), Number(r.voucher_id)]),
      [
        [3000, Number(reds[0].id)],
        [-3000, Number(reds[0].id)],
      ],
    );
    postDrafts(s);
    assert.deepEqual(
      [out.id, into.id].map((id) => s.db.prepare('SELECT status FROM fin_allocations WHERE id=?').get(id)?.status),
      ['revoked', 'revoked'],
    );
    const revokedOut = one(s.db, rows.fin_allocations.pick({ version: true }), 'SELECT version FROM fin_allocations WHERE id=?', out.id);
    assert.ok(revokedOut, '转出那笔核销还在');
    assert.throws(
      () =>
        new FinanceAllocations(s).revoke(maker, out.id, {
          version: revokedOut.version,
          requestId: 'revoke-again',
          date: '2026-01-29',
          reason: '虚构重复撤销',
        }),
      /已撤销/,
    );
    assert.equal(payableBalance(s, first.id), -3000, '多付回到原来那笔');
    assert.equal(payableBalance(s, second.id), 10000);
    assert.equal(statement(), before);
    assert.equal(subledger(s, 'payable'), -ledgerBalance(s, '2202'), '往来明细等于总账');
    new FinanceAllocations(s).revoke(maker, original.id, {
      version: Number(original.version),
      requestId: 'revoke-payment',
      date: '2026-01-29',
      reason: '虚构付款撤销',
    });
    postDrafts(s);
    const doc = s.db.prepare('SELECT * FROM fin_cash_documents WHERE id=?').get(cashId);
    const cancelled = cash.cancel(maker, cashId, {
      version: Number(doc?.version),
      requestId: 'cancel-cash',
      date: '2026-01-30',
      reason: '虚构付款录错',
    });
    assert.equal(cancelled.status, 'cancelled');
    postDrafts(s);
    assert.equal(subledger(s, 'payable'), -ledgerBalance(s, '2202'));
    assert.equal(subledger(s, 'payable'), 17000, '两笔应付都恢复未付');
    assert.equal(ledgerBalance(s, '1123'), 0, '预付已随资金单撤销冲回');
    assert.equal(ledgerBalance(s, '1002'), 0);
  } finally {
    s.close();
  }
});

test('资金账户当天按实际进出算：撤销核销的红字凭证冲减收入、不算支出；对账单收付款行不用操作员填的摘要，撤销“转为预收款”那张写原收款日期', () => {
  const s = new Store(':memory:');
  try {
    const cash = newSettings(s),
      events = new FinanceEvents(s);
    physical(s, 1, 'delivery', '2026-01-05', deliveryDoc('1'));
    events.sync(maker);
    new FinanceEventVouchers(s).generate(maker, event(s, 1).id, { version: 1, requestId: 'generate-1' });
    postDrafts(s);
    const owed = obligation(s, 1);
    // 1 月 6 日收 150 元，确认时核销 100，剩下 50 记预收
    const receipt = funds(s, cash, { kind: 'receipt', date: '2026-01-06', amount: 15000 }, [
      { obligationId: Number(owed.id), version: Number(owed.version), amount: 10000 },
    ]);
    const day = (date: string) => new FinanceCashAccounts(s).daily(maker, { date }).rows[0];
    assert.deepEqual([Number(day('2026-01-06').income), Number(day('2026-01-06').expense)], [15000, 0]);
    // 1 月 10 日撤销那笔核销：原核销凭证红冲 100、转预收又进 100，账户里的钱没动
    const allocation = s.db.prepare('SELECT * FROM fin_allocations WHERE cash_id=? AND reversal_of IS NULL').get(receipt);
    new FinanceAllocations(s).revoke(maker, allocation?.id, {
      version: Number(allocation?.version),
      requestId: 'revoke',
      date: '2026-01-10',
      reason: '虚构：内部原因甲',
    });
    postDrafts(s);
    const revokedDay = day('2026-01-10');
    assert.equal(Number(revokedDay.income), 0, '红字冲掉的 100 抵掉转预收进的 100');
    assert.equal(Number(revokedDay.expense), 0, '红字凭证不算支出');
    assert.equal(Number(revokedDay.closing), Number(revokedDay.opening));
    // 1 月 12 日撤销整笔收款：冲的是前几天的收款，冲减成负数的那边挪成支出，不显示负收入；期末不变
    const doc = s.db.prepare('SELECT version FROM fin_cash_documents WHERE id=?').get(receipt);
    cash.cancel(maker, receipt, {
      version: Number(doc?.version),
      requestId: 'cancel',
      date: '2026-01-12',
      reason: '虚构：内部原因乙',
    });
    postDrafts(s);
    const cancelDay = day('2026-01-12');
    assert.deepEqual([Number(cancelDay.income), Number(cancelDay.expense)], [0, 15000]);
    assert.equal(Number(cancelDay.closing), Number(cancelDay.opening) - 15000);

    const statement = new FinanceStatements(s).statement(maker, { kind: 'receivable', partyId: '1', from: '2026-01-01', to: '2026-01-31' });
    const texts = statement.items.map((r) => String(r.description));
    // 收付款行写类型、日期、这笔收付款的总额，不用资金单上操作员填的“虚构收付款”
    assert.ok(texts.includes('收客户款 01-06 150.00'), '确认时就核销的那行：' + texts.join(' / '));
    assert.ok(texts.includes('收客户款 01-06 150.00（预收款）'), '没核销记预收的那行');
    assert.ok(texts.every((t) => !t.includes('虚构收付款') && !t.includes('内部原因')), texts.join(' / '));
    const cancelled = statement.items
      .filter((r) => r.red && String(r.description).startsWith('撤销收款'))
      .map((r) => String(r.description));
    // 撤销“转为预收款”那张（1 月 10 日记的）写原收款日期 1 月 6 日：客户没有 1 月 10 日的收款
    assert.deepEqual(cancelled.sort(), ['撤销收款 2026-01-06 100.00 元', '撤销收款 2026-01-06 50.00 元']);
    assert.equal(statement.closing, 10000, '收款全撤了，还欠 100');
  } finally {
    s.close();
  }
});

test('收付计划：到期日早于今天的进“已逾期”一行，和到期提醒的逾期一致；本月一行只算今天及以后到期的；明细能按已逾期看', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    const parties = new FinanceParties(s),
      due = new FinanceDue(s);
    const owe = (requestId: string, date: string, dueDate: string, amount: number) =>
      parties.create(maker, {
        requestId,
        kind: 'receivable',
        partyId: 1,
        date,
        dueDate,
        amount,
        description: '虚构货款',
        counterAccount: '5001',
      });
    owe('overdue', '2026-01-02', '2026-01-11', 381000);
    owe('later', '2026-01-05', '2026-01-20', 100000);
    owe('today', '2026-01-06', '2026-01-13', 5000);
    postDrafts(s);
    const date = '2026-01-13';
    const plan = due.plan(maker, { date, months: 2 });
    const row = (period: string) => {
      const found = plan.forecast.find((r) => r.period === period);
      assert.ok(found, '收付计划有“' + period + '”这一行');
      return found;
    };
    assert.equal(row('overdue').receivable, 381000, '1 月 11 日到期、已逾期 2 天的进“已逾期”');
    assert.equal(row('2026-01').receivable, 105000, '今天到期的还不算逾期，进本月');
    const overdueSoon = due.soon(maker, { date, days: 7 }).rows.filter((r) => Number(r.days_to_due) < 0);
    assert.equal(
      overdueSoon.reduce((n, r) => n + Number(r.balance), 0),
      row('overdue').receivable,
      '和到期提醒里逾期的对得上',
    );
    const detail = (dueMonth: string) =>
      due
        .plan(maker, { date, months: 2, dueMonth })
        .detail.rows.map((r) => Number(r.balance))
        .sort((a, b) => a - b);
    assert.deepEqual(detail('overdue'), [381000]);
    assert.deepEqual(detail('2026-01'), [5000, 100000]);
  } finally {
    s.close();
  }
});

test('收付款分录直接算：收客户款核销记应收、不核销记预收，转账两边都标内部转账', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    // 资金单一行：只有方向、账户、往来单位要紧，别的列随便填
    const cash = (fields: Partial<CashRow>): CashRow => ({
      id: 1, kind: 'receipt', account_id: 1, target_account_id: null, party_id: null, party_name: null, date: '2026-01-15',
      amount_cents: 500, method: '银行', description: '虚构收款', counter_account: null, cash_flow: null, voucher_id: null,
      status: 'draft', version: 1, ...fields,
    });
    const receipt = cash({ kind: 'receipt', account_id: 1, party_id: '1', party_name: '虚构客户' });
    const toParty = cashEntries(s.db, receipt, 500, true);
    assert.deepEqual(toParty.map((e) => [e.accountCode, e.debit, e.credit]), [['1002', 500, 0], ['1122', 0, 500]]);
    assert.equal(toParty[0].cashFlow, '销售商品收到的现金');
    assert.equal(cashEntries(s.db, receipt, 500, false)[1].accountCode, '2203');
    assert.throws(() => cashEntries(s.db, cash({ kind: 'transfer', account_id: 1, target_account_id: 99 }), 500, false), /财务记录不存在/);
  } finally {
    s.close();
  }
});

test('多付分散在几张付款单上：一次转抵按张拆开，每张一张对冲凭证，撤销按张撤', () => {
  const s = new Store(':memory:');
  try {
    const cash = newSettings(s),
      invoices = new FinanceInvoices(s);
    const version = (id: number) => versionOf(s, id);
    const first = invoicedPayable(s, 1, '2026-01-15', 'BLUE-1');
    // 100 元分两次付：01-18 付 50，01-20 付 50；之后红票冲掉 80，多付 80 分在两张付款单上
    const cashA = funds(s, cash, { kind: 'payment', date: '2026-01-18', amount: 5000 }, [{ obligationId: first.id, version: version(first.id), amount: 5000 }]);
    const cashB = funds(s, cash, { kind: 'payment', date: '2026-01-20', amount: 5000 }, [{ obligationId: first.id, version: version(first.id), amount: 5000 }]);
    const red = invoices.create(maker, bill('purchase', 'RED-1', { date: '2026-01-22', net: -8000, gross: -8000, originalId: first.blue.id }));
    new FinanceInvoiceConfirm(s).confirm(maker, red.id, { version: 1, requestId: 'confirm-red', counterAccount: '1403' });
    postDrafts(s);
    const second = invoicedPayable(s, 2, '2026-01-25', 'BLUE-2');
    const balance = (id: number) => payableBalance(s, id);
    assert.equal(balance(first.id), -8000);
    const result = transferCredit(s, first.id, second.id, 8000);
    // 两张都是 50，同样多先取后付的那张（编号大），再从另一张取剩下的 30
    assert.deepEqual(result.parts.map((p) => [p.cashId, p.amount]), [[cashB, 5000], [cashA, 3000]]);
    assert.notEqual(result.parts[0].voucherId, result.parts[1].voucherId, '每张资金单各一张对冲凭证');
    postDrafts(s);
    assert.deepEqual([balance(first.id), balance(second.id)], [0, 2000]);
    const allocated = (cashId: number) =>
      Number(s.db.prepare('SELECT sum(amount_cents) AS n FROM fin_allocations WHERE cash_id=?').get(cashId)?.n);
    assert.deepEqual([allocated(cashA), allocated(cashB)], [5000, 5000], '每张资金单的总核销金额不变');
    // 只撤从 A 转的那 30
    const into = s.db
      .prepare('SELECT * FROM fin_allocations WHERE cash_id=? AND obligation_id=? AND amount_cents>0 AND reversal_of IS NULL')
      .get(cashA, second.id);
    new FinanceAllocations(s).revoke(maker, Number(into?.id), {
      version: Number(into?.version),
      requestId: 'revoke-a',
      date: '2026-01-29',
      reason: '虚构撤销一张',
    });
    postDrafts(s);
    assert.deepEqual([balance(first.id), balance(second.id)], [-3000, 5000], '从 B 转的 50 还在');
    assert.equal(subledger(s, 'payable'), -ledgerBalance(s, '2202'), '往来明细等于总账');
    // 超过多付的不转，什么都不留
    const vouchers = count(s.db, 'SELECT count(*) FROM fin_vouchers');
    assert.throws(
      () =>
        new FinanceAllocations(s).transferCredit(maker, {
          requestId: 'too-much',
          date: '2026-01-30',
          from: { id: first.id, version: version(first.id) },
          to: { id: second.id, version: version(second.id) },
          amount: 3001,
        }),
      /超过/,
    );
    assert.equal(count(s.db, 'SELECT count(*) FROM fin_vouchers'), vouchers);
  } finally {
    s.close();
  }
});

test('资金账户保存：银行账户要对应银行类末级科目、现金对现金；名称或科目重复被拒；建好后不能改科目和类型；不是银行不能存后四位', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s); // 已有“虚构资金账户”对应 1002 银行存款
    const accounts = new FinanceCashAccounts(s);
    const save = (input: Record<string, unknown>) => accounts.saveAccount(maker, { requestId: JSON.stringify(input), ...input });
    // 科目是资金科目、只是和类型对不上：说清是不匹配、该选哪类科目
    assert.throws(() => save({ kind: 'bank', name: '虚构现金当银行', accountCode: '1001' }), /类型和科目对不上：银行账户要选银行存款类科目/);
    assert.throws(() => save({ kind: 'cash', name: '虚构银行当现金', accountCode: '1002' }), /类型和科目对不上：现金账户要选库存现金类科目/);
    assert.throws(() => save({ kind: 'bank', name: '虚构不是资金科目', accountCode: '1122' }), /须对应启用的末级资金科目/);
    assert.throws(() => save({ kind: 'cash', name: '虚构现金', accountCode: '1001', lastFour: '1234' }), /只有银行账户可保存账号后四位/);
    assert.throws(() => save({ kind: 'bank', name: '虚构资金账户', accountCode: '1002' }), /名称或对应科目已使用/);
    const petty = save({ kind: 'cash', name: '虚构现金', accountCode: '1001' });
    assert.throws(
      () => save({ id: petty.id, version: petty.version, kind: 'wechat', name: '虚构现金', accountCode: '1001' }),
      /科目和类型须保持一致/,
    );
  } finally {
    s.close();
  }
});
