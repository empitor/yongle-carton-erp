// 往来对账单的说法和余额（全部是虚构数据，只用内存库）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { Store } from '../server/core/db.js';
import { one } from '../server/core/index.js';
import { FinanceEvents } from '../server/finance/events.js';
import { FinanceLedger } from '../server/finance/ledger.js';
import { entry } from '../server/finance/query.js';
import { FinanceStatements } from '../server/finance/statements.js';
import { FinanceEventVouchers } from '../server/finance/event-voucher.js';
import { FinanceEventHandling } from '../server/finance/event-handling.js';
import { FinanceAllocations } from '../server/finance/allocations.js';
import { maker, newSettings, postDrafts, physical, deliveryDoc, event, obligation, funds, reverseSource } from './finance-fixture.js';
import { businessChanges } from './business-changes-fixture.js';
import { workbook } from './finance-http-fixture.js';
import type { FinanceSettlements } from '../server/finance/settlements.js';

/** 操作员在红字凭证、撤销核销上写的内部原因（对账单不能带出去） */
const reason = '虚构：内部原因';

/** 总账里单位 1 这几个科目的净额（借方为正，乘 sign），对账单期末应该和它一样 */
function partyLedgerNet(s: Store, codes: string[], sign: number) {
  const row = one(
    s.db,
    z.object({ n: z.number() }),
    `SELECT coalesce(sum(CASE WHEN v.reversal_of IS NULL THEN 1 ELSE -1 END*(e.debit-e.credit)),0) AS n
          FROM fin_entries e JOIN fin_vouchers v ON v.id=e.voucher_id WHERE v.status='posted'
          AND e.auxiliary_id='1' AND e.account_code IN (${codes.map(() => '?').join(',')})`,
    ...codes,
  );
  if (!row) throw new Error('测试数据：读不到总账合计');
  return sign * row.n;
}

/** 2026-01-25 红冲一张凭证（linked：来源功能生成的那种），摘要写内部原因；返回红字凭证编号 */
function reverseVoucher(ledger: FinanceLedger, id: unknown, linked: boolean, requestId: string) {
  const header = ledger.get(maker, Number(id)).header;
  return ledger.reverse(maker, Number(id), { version: Number(header.version), requestId, date: '2026-01-25', description: reason }, { linked })
    .header.id;
}

/**
 * 1 月 5–8 日四张送货（前三张入账记账），造出六种红字行：1 送货撤销后红字冲销；2 撤销核销；3 撤销整笔收款；
 * 4 送货凭证被直接红冲；5 手工凭证在凭证页红冲；6 发票凭证整张红冲。第 4 张送货留给调用方（没有单号那一种）。
 */
function sixKindsOfRed(s: Store, cash: FinanceSettlements, events: FinanceEvents) {
  const ledger = new FinanceLedger(s);
  for (const [id, day] of [
    [1, '05'],
    [2, '06'],
    [3, '07'],
    [4, '08'],
  ] as const)
    physical(s, id, 'delivery', '2026-01-' + day, deliveryDoc('1'));
  events.sync(maker, { requestId: 'scan' });
  for (const source of [1, 2, 3])
    new FinanceEventVouchers(s).generate(maker, event(s, source).id, { version: 1, requestId: 'generate-' + source });
  postDrafts(s);

  // 1. 送货单撤销后在财务里红字冲销：“红字冲销 送货单 FICT-1”
  reverseSource(s, 1, '2026-01-20');
  postDrafts(s);
  // 2. 撤销核销：收款单还在，“撤销核销 原核销日期 金额”
  const second = obligation(s, 2);
  funds(s, cash, { kind: 'receipt', date: '2026-01-10', amount: 3000 }, [
    { obligationId: Number(second.id), version: Number(second.version), amount: 3000 },
  ]);
  const allocation = s.db.prepare('SELECT * FROM fin_allocations WHERE obligation_id=?').get(second.id);
  new FinanceAllocations(s).revoke(maker, allocation?.id, { version: Number(allocation?.version), requestId: 'revoke', date: '2026-01-15', reason });
  postDrafts(s);
  // 3. 撤销整笔收款（直接红冲收款凭证造出来：现在的流程里有核销要先撤销核销，收款单撤销时冲的不是应收）
  const third = obligation(s, 3);
  const receipt = funds(s, cash, { kind: 'receipt', date: '2026-01-11', amount: 2000 }, [
    { obligationId: Number(third.id), version: Number(third.version), amount: 2000 },
  ]);
  const receiptVoucher = s.db
    .prepare("SELECT id FROM fin_vouchers WHERE module_source='cash' AND module_id=? AND reversal_of IS NULL ORDER BY id LIMIT 1")
    .get(receipt)?.id;
  reverseVoucher(ledger, receiptVoucher, true, 'cancel-receipt');
  postDrafts(s);
  // 4. 送货生成的凭证被直接红冲、没记冲销往来（比如到票红冲暂估这种）：“红字冲销 送货单 FICT-3”
  reverseVoucher(ledger, third.voucher_id, true, 'red-event-voucher');
  postDrafts(s);
  // 5. 手工凭证在凭证页红冲：“红字冲销 原凭证摘要”
  const manual = ledger.create(maker, {
    requestId: 'manual',
    date: '2026-01-12',
    description: '虚构手工应收调整',
    entries: [entry('1122', 500, 0, { kind: 'customer', id: '1', name: '虚构客户' }), entry('5301', 0, 500)],
  });
  postDrafts(s);
  reverseVoucher(ledger, manual.header.id, false, 'red-manual');
  postDrafts(s);
  // 6. 发票凭证整张红冲（开票确认收入时发票凭证记应收）：“红字冲销 发票 票号”。这里直接生成一张发票模块的凭证造出来
  s.db.exec('BEGIN');
  const invoiceVoucher = ledger.createLinked(maker, 'invoice', 1, {
    requestId: 'invoice-voucher',
    date: '2026-01-13',
    description: '发票 虚构票号-001',
    entries: [entry('1122', 700, 0, { kind: 'customer', id: '1', name: '虚构客户' }), entry('5301', 0, 700)],
  });
  s.db.exec('COMMIT');
  postDrafts(s);
  reverseVoucher(ledger, invoiceVoucher.header.id, true, 'red-invoice');
  postDrafts(s);
}

test('对账单的红字行：每一种都用对方看得懂的说法，不带红字凭证自己的摘要（操作员写的内部原因）', () => {
  const s = new Store(':memory:');
  try {
    const cash = newSettings(s),
      events = new FinanceEvents(s),
      ledger = new FinanceLedger(s);
    const statement = () =>
      new FinanceStatements(s).statement(maker, { kind: 'receivable', partyId: '1', from: '2026-01-01', to: '2026-01-31' }).items;
    const reds = () => statement().filter((r) => r.red);
    sixKindsOfRed(s, cash, events);
    // 7. 没有单号的往来红字冲销，红字凭证还没记账（走没记账的往来那一段）：“红字冲销 原往来的摘要”
    new FinanceEventVouchers(s).generate(maker, event(s, 4).id, { version: 1, requestId: 'generate-4' });
    postDrafts(s);
    const fourth = obligation(s, 4);
    s.db
      .prepare("UPDATE fin_events SET snapshot=json_remove(snapshot,'$.doc.number','$.doc.reference'),source_number=NULL WHERE id=?")
      .run(fourth.event_id);
    businessChanges(s).reverse(4);
    events.sync(maker, { requestId: 'rescan-4' });
    const diff = event(s, 4);
    new FinanceEventHandling(s).correct(maker, diff.id, { version: Number(diff.version), date: '2026-01-26', requestId: 'correct-4', reason });
    const unposted = reds().find((r) => r.date === '2026-01-26');
    assert.ok(unposted, '对账单里有 1 月 26 日冲销的那行');
    assert.equal(unposted.description, '红字冲销 ' + fourth.description, '没记账：按原往来的摘要');
    // 记账以后同一笔走凭证那一段：原凭证是送货生成的，但快照里没有单号，按原凭证的摘要
    postDrafts(s);
    const fourthVoucher = ledger.get(maker, Number(fourth.voucher_id)).header;

    // 红字行的先后按冲销链和日期排，这里只核对每一种的说法
    assert.deepEqual(
      reds()
        .map((r) => r.description)
        .sort(),
      [
        '撤销核销 2026-01-10 30.00 元',
        '红字冲销 送货单 FICT-1',
        '撤销收款 2026-01-11 20.00 元',
        '红字冲销 送货单 FICT-3',
        '红字冲销 虚构手工应收调整',
        '红字冲销 发票 虚构票号-001',
        '红字冲销 ' + fourthVoucher.description,
      ].sort(),
    );
    assert.doesNotMatch(String(fourthVoucher.description), /^红字冲销/);
    for (const r of statement()) {
      assert.doesNotMatch(String(r.description), /内部原因|虚构撤销单据/, '不带操作员写的原因：' + r.description);
      assert.doesNotMatch(String(r.description), /红字冲销 红字冲销/);
    }
  } finally {
    s.close();
  }
});

test('对账单：没核销直接记预收（预付）的收付款也列出来、余额扣掉；以后核销到欠款、再撤销核销都不多出行，余额和总账一致；导出一致', async () => {
  const s = new Store(':memory:');
  try {
    const cash = newSettings(s),
      events = new FinanceEvents(s);
    physical(s, 1, 'delivery', '2026-01-05', deliveryDoc('1'));
    events.sync(maker, { requestId: 'scan' });
    new FinanceEventVouchers(s).generate(maker, event(s, 1).id, { version: 1, requestId: 'generate-1' });
    postDrafts(s);
    const range = { kind: 'receivable' as const, partyId: '1', from: '2026-01-01', to: '2026-01-31' };
    const ledgerNet = (codes: string[], sign: number) => partyLedgerNet(s, codes, sign);
    const before = new FinanceStatements(s).statement(maker, range);
    assert.equal(before.advance, 0);
    // 1 月 3 日收款 100 元：那天还没有欠款，没核销，直接记预收
    const receipt = funds(s, cash, { kind: 'receipt', date: '2026-01-03', amount: 10000 });
    const after = new FinanceStatements(s).statement(maker, range);
    const row = after.items.find((r) => r.date === '2026-01-03');
    assert.ok(row, '已经收到的钱在对账单里');
    assert.equal(Number(row.delta), -10000);
    // 摘要不用资金单上操作员填的“虚构收付款”，写类型、日期、金额（和月度台账、凭证来源同一种写法）
    assert.equal(row.description, '收客户款 01-03 100.00（预收款）');
    assert.equal(Number(row.red), 0);
    assert.equal(after.closing, before.closing - 10000, '期末扣掉预收');
    assert.equal(after.closing, ledgerNet(['1122', '2203'], 1), '和总账的应收减预收一致');
    assert.equal(after.advance, 10000, '还没抵货款的预收单独给出来');
    // 以后核销到欠款：预收转去抵应收，对方欠款没变，不多出行，余额不变
    const owed = obligation(s, 1);
    const doc = s.db.prepare('SELECT version FROM fin_cash_documents WHERE id=?').get(receipt);
    new FinanceAllocations(s).allocate(maker, receipt, {
      version: Number(doc?.version),
      requestId: 'allocate-later',
      date: '2026-01-20',
      allocations: [{ obligationId: Number(owed.id), version: Number(owed.version), amount: 10000 }],
    });
    postDrafts(s);
    const allocated = new FinanceStatements(s).statement(maker, range);
    assert.deepEqual(
      allocated.items.map((r) => [r.date, r.description, Number(r.delta)]),
      after.items.map((r) => [r.date, r.description, Number(r.delta)]),
      '核销净额是 0，不列',
    );
    assert.equal(allocated.closing, after.closing);
    assert.equal(allocated.advance, 0, '预收已经抵完');
    // 撤销这笔核销：钱转回预收，余额照样不变
    const allocation = s.db.prepare('SELECT * FROM fin_allocations WHERE cash_id=?').get(receipt);
    new FinanceAllocations(s).revoke(maker, allocation?.id, {
      version: Number(allocation?.version),
      requestId: 'revoke-later',
      date: '2026-01-25',
      reason: '虚构：内部原因',
    });
    postDrafts(s);
    const revoked = new FinanceStatements(s).statement(maker, range);
    assert.equal(revoked.items.length, after.items.length, '撤销核销净额也是 0，不列');
    assert.equal(revoked.closing, after.closing);
    assert.equal(revoked.closing, ledgerNet(['1122', '2203'], 1));
    assert.equal(revoked.advance, 10000);
    // 下个月对账：期初就扣掉了预收
    const next = new FinanceStatements(s).statement(maker, { ...range, from: '2026-02-01', to: '2026-02-28' });
    assert.equal(next.opening, revoked.closing);
    // 导出：同一行、期末一样，末尾写一句预收
    const { statementWorkbook } = await import('../server/finance/exports.js');
    const exported = new FinanceStatements(s).statementForExport(maker, range);
    const book = await workbook(await statementWorkbook(range.from, range.to, exported.party, range.kind, exported.data));
    const texts: string[] = [];
    book.worksheets[0].eachRow((r) => texts.push(r.values ? JSON.stringify(r.values) : ''));
    assert.ok(texts.some((t) => t.includes('收客户款 01-03 100.00（预收款）')), '导出里有这笔预收');
    assert.ok(!texts.some((t) => t.includes('虚构收付款')), '导出不带资金单上操作员填的摘要');
    assert.ok(texts.some((t) => t.includes('还没抵货款的预收款 100.00 元')), '导出写明预收');

    // 应付一侧：没核销直接记预付的付款也列出来
    const payment = funds(s, cash, { kind: 'payment', date: '2026-01-04', amount: 5000 });
    assert.ok(payment);
    const payable = new FinanceStatements(s).statement(maker, { ...range, kind: 'payable' });
    const paid = payable.items.find((r) => r.date === '2026-01-04');
    assert.ok(paid, '对账单里有 1 月 4 日的付款');
    assert.equal(Number(paid.delta), -5000);
    assert.equal(paid.description, '付供应商款 01-04 50.00（预付款）');
    assert.equal(payable.closing, ledgerNet(['2202', '1123'], -1), '和总账的应付减预付一致');
    assert.equal(payable.advance, 5000);
  } finally {
    s.close();
  }
});
