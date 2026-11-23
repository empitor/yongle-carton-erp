// 财务的表：数据库约束真的拦得住不合规则的值。枚举列的取值由 schema-constraints 的枚举比对守着，这里只放条件型的约束。
// 每条测试一个空业务库（带预置的财务设置、科目、模板），写完核对外键都对得上。
import assert from 'node:assert/strict';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { test } from 'node:test';
import { Store } from '../server/core/index.js';
import * as finance from '../server/finance/base/stored-values.js';
import { accepts, rejects } from './schema-fixture.js';

const now = '2026-11-12T00:00:00.000Z';

/** 在一个空业务库里做完 work，再核对外键都对得上 */
function withBusinessDb(work: (db: DatabaseSync) => void) {
  const store = new Store(':memory:');
  try {
    work(store.db);
    assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    store.close();
  }
}
/** 插一行，返回它的编号 */
const insertId = (db: DatabaseSync, sql: string, ...params: SQLInputValue[]) => Number(db.prepare(sql).run(...params).lastInsertRowid);
const voucher =
  "INSERT INTO fin_vouchers(number,date,period,description,attachment_count,status,maker_id,maker_name,created_at,module_source,module_id) VALUES(?,?,?,'虚构凭证',?,?,'x','虚构',?,?,?)";
/** 凭证的期间要先有：开 2026-01 */
const openJanuary = (db: DatabaseSync) => db.prepare("INSERT INTO fin_periods(period,status) VALUES('2026-01','open')").run();
/** 一张 2026-01 的草稿凭证（期间要先开好） */
const draftVoucher = (db: DatabaseSync) => insertId(db, voucher, 1, '2026-01-15', '2026-01', 0, 'draft', now, null, null);
const obligation =
  'INSERT INTO fin_obligations(kind,party_id,party_name,date,due_date,amount_cents,description,tax_status,terms_snapshot) VALUES(?,?,?,?,?,?,?,?,?)';
/** 一笔应收（虚构客户的货款） */
const receivable = (db: DatabaseSync) => insertId(db, obligation, 'receivable', '1', '虚构客户', '2026-01-15', null, 100, '虚构货款', 'known', null);

test('财务设置和科目（预置的那一行、1001 库存现金）：期间、标志、JSON 列、科目编码的写法', () => {
  withBusinessDb((db) => {
    for (const sql of [
      "UPDATE fin_settings SET start_period='2026-13'",
      "UPDATE fin_settings SET start_period=''",
      'UPDATE fin_settings SET require_separate_approver=2',
      "UPDATE fin_settings SET aging_days='{}'",
      "UPDATE fin_settings SET aging_days='[30,'",
      "UPDATE fin_settings SET tax_rates='[]'",
    ])
      rejects(db, sql);
    accepts(db, "UPDATE fin_settings SET start_period='2026-01',taxpayer='small',require_separate_approver=0");
    accepts(db, 'UPDATE fin_settings SET start_period=NULL,taxpayer=NULL');
    for (const sql of [
      "UPDATE fin_accounts SET auxiliary='{}' WHERE code='1001'",
      "UPDATE fin_accounts SET enabled=2 WHERE code='1001'",
      "UPDATE fin_accounts SET used=-1 WHERE code='1001'",
    ])
      rejects(db, sql);
    const account = "INSERT INTO fin_accounts(code,parent_code,name,category,direction,cash_kind,auxiliary,enabled) VALUES(?,NULL,'虚构科目','asset','debit',NULL,NULL,1)";
    accepts(db, account, ['1009']);
    for (const code of ['12a4', '123', '12345', '100901234567']) rejects(db, account, [code]);
  });
});

test('期间、期末处理：期间月份 01～12；处理种类是登记的那些（成本、工资、折旧可带 #序号）；明细是 JSON', () => {
  withBusinessDb((db) => {
    accepts(db, "INSERT INTO fin_periods(period,status) VALUES('2026-01','open')");
    rejects(db, "INSERT INTO fin_periods(period,status) VALUES('2026-00','open')");
    const job = 'INSERT INTO fin_period_jobs(period,kind,voucher_id,details) VALUES(?,?,NULL,?)';
    for (const kind of [...finance.periodJobKinds, 'costing#1', 'costing#12', 'payroll_pay#3', 'depreciation#2'])
      accepts(db, job, ['2026-01', kind, '{}']);
    // 核对成本时临时用过的 costing#check 现在不再写，库里也不收
    for (const kind of ['costing#check', 'costing#0', 'costing#', 'costing#1a', 'costing#1#2', 'foo', 'foo#1', '#1', ''])
      rejects(db, job, ['2026-02', kind, '{}']);
    rejects(db, job, ['2026-13', 'tax', '{}']);
    rejects(db, job, ['2026-02', 'tax', '{bad']);
  });
});

test('凭证和分录：日期和期间对得上；来源功能和它的编号一起有或一起没有；自增编号删了不复用；辅助核算三列同有同无', () => {
  withBusinessDb((db) => {
    openJanuary(db);
    const first = draftVoucher(db);
    rejects(db, voucher, [2, '2026-02-15', '2026-01', 0, 'draft', now, null, null]);
    rejects(db, voucher, [2, '2026-01-32', '2026-01', 0, 'draft', now, null, null]);
    rejects(db, voucher, [2, '2026-01-15', '2026-01', 10001, 'draft', now, null, null]);
    rejects(db, voucher, [2, '2026-01-15', '2026-01', 0, 'draft', now, 'cash', null]);
    rejects(db, voucher, [2, '2026-01-15', '2026-01', 0, 'draft', now, null, 1]);
    accepts(db, voucher, [2, '2026-01-15', '2026-01', 0, 'draft', now, 'cash', 1]);
    db.prepare('DELETE FROM fin_vouchers').run();
    const next = draftVoucher(db);
    assert.equal(next, first + 2, '凭证编号删掉以后不复用');
    const entry =
      "INSERT INTO fin_entries(voucher_id,position,account_code,description,debit,credit,auxiliary_kind,auxiliary_id,auxiliary_name) VALUES(?,?,'1001','',100,0,?,?,?)";
    accepts(db, entry, [next, 1, null, null, null]);
    accepts(db, entry, [next, 2, 'customer', '1', '虚构客户']);
    rejects(db, entry, [next, 3, 'customer', null, null]);
    rejects(db, entry, [next, 3, null, '1', '虚构客户']);
  });
});

test('事件、模板、账期和税率：日期、金额，快照和模板映射是 JSON，问题说明是文字；账期天数、税率写法、付款日的范围', () => {
  withBusinessDb((db) => {
    const event =
      'INSERT INTO fin_events(source_kind,source_id,event_type,source_version,source_hash,date,amount_cents,status,problem,revenue_recognition,snapshot) VALUES(?,?,?,?,?,?,?,?,?,?,?)';
    accepts(db, event, ['delivery', '1', 'delivery.confirmed', 1, 'h', '2026-01-15', 100, 'ready', '给人看的文字，不是 JSON', 'delivery', '{}']);
    accepts(db, event, ['arrival', '1', 'arrival.confirmed', 1, 'h', '2026-01-15', null, 'info_pending', null, null, '{}']);
    rejects(db, event, ['delivery', '2', 'delivery.confirmed', 1, 'h', '2026-02-30', 100, 'ready', null, null, '{}']);
    rejects(db, event, ['delivery', '2', 'delivery.confirmed', 1, 'h', '2026-01-15', -1, 'ready', null, null, '{}']);
    rejects(db, event, ['delivery', '2', 'delivery.confirmed', 1, 'h', '2026-01-15', 100, 'ready', null, null, '{bad']);
    rejects(db, "UPDATE fin_templates SET mapping='[]' WHERE name='deposit'");
    const terms = 'INSERT INTO fin_party_terms(kind,party_id,party_name,term_days,tax_rate,tax_mode,term_type,payment_day) VALUES(?,?,?,?,?,?,?,?)';
    accepts(db, terms, ['customer', '1', '虚构客户', 30, '13', '含税', 'days', null]);
    accepts(db, terms, ['supplier', '1', '虚构供应商', 0, '0.5%', null, 'none', null]);
    rejects(db, terms, ['customer', '2', '虚构', 3651, null, null, 'days', null]);
    rejects(db, terms, ['customer', '2', '虚构', 30, '101', null, 'days', null]);
    rejects(db, terms, ['customer', '2', '虚构', 30, '百分之十三', null, 'days', null]);
    rejects(db, terms, ['customer', '2', '虚构', 30, '13', '含税', 'monthly', 32]);
    rejects(db, "UPDATE fin_party_terms SET options='{bad' WHERE kind='customer'");
  });
});

test('往来、资金账户、收付款单：到期日不填可以、空串不行；剩余估计不为负；卡号后四位是数字；收付款金额不为 0', () => {
  withBusinessDb((db) => {
    const owed = receivable(db);
    accepts(db, obligation, ['payable', '1', '虚构供应商', '2026-01-15', '2026-02-15', -100, '红冲为负', 'pending', 'null']);
    rejects(db, obligation, ['receivable', '1', '虚构', '2026-01-15', '', 100, '', 'known', null]);
    rejects(db, obligation, ['receivable', '1', '虚构', '2026-01-15', null, 100, '', 'known', '{bad']);
    rejects(db, 'UPDATE fin_obligations SET estimate_remaining=-1 WHERE id=?', [owed]);
    const cashAccount = 'INSERT INTO fin_cash_accounts(name,kind,account_code,last_four,enabled) VALUES(?,?,?,?,?)';
    const bank = insertId(db, cashAccount, '虚构银行', 'bank', '1002', '1234', 1);
    rejects(db, cashAccount, ['虚构钱包', 'other', '1012', '12a4', 1]);
    rejects(db, cashAccount, ['虚构钱包', 'other', '1012', null, 2]);
    const cash = 'INSERT INTO fin_cash_documents(kind,account_id,date,amount_cents,method,description,status) VALUES(?,?,?,?,?,?,?)';
    accepts(db, cash, ['receipt', bank, '2026-01-15', 100, '银行', '虚构收款', 'draft']);
    rejects(db, cash, ['receipt', bank, '2026-1-15', 100, '银行', '', 'draft']);
    rejects(db, cash, ['receipt', bank, '2026-01-15', 0, '银行', '', 'draft']);
  });
});

test('发票和工资：税率是 0～100 的数字文本、不带 %，净额加税额等于价税合计（红票为负也一样）；工资期间、非负、应发等于各项之和', () => {
  withBusinessDb((db) => {
    const invoice =
      "INSERT INTO fin_invoices(direction,type,number,date,party_id,party_name,tax_id,net,rate,tax,gross,status) VALUES(?,'虚构专票',?,?,'1','虚构客户','',?,?,?,?,?)";
    accepts(db, invoice, ['sale', 'N1', '2026-01-15', 100, '13', 13, 113, 'draft']);
    accepts(db, invoice, ['sale', 'N2', '2026-01-15', -100, '13', -13, -113, 'red']);
    rejects(db, invoice, ['sale', 'N3', '2026-01-15', 100, '13%', 13, 113, 'draft']);
    rejects(db, invoice, ['sale', 'N3', '2026-01-15', 100, '130', 13, 113, 'draft']);
    rejects(db, invoice, ['sale', 'N3', '2026-01-15', 100, '13', 13, 114, 'draft']);
    rejects(db, invoice, ['sale', 'N3', '2026-02-31', 100, '13', 13, 113, 'draft']);
    const payroll =
      "INSERT INTO fin_payroll(period,employee_id,employee_name,department,account_code,gross,social,housing,tax,net,employer_social,employer_housing) VALUES(?,?,'虚构员工','虚构部门','560204',?,?,?,?,?,0,0)";
    accepts(db, payroll, ['2026-01', 'e-1', 300, 10, 20, 30, 240]);
    rejects(db, payroll, ['2026-01', 'e-2', 300, 10, 20, 30, 250]);
    rejects(db, payroll, ['2026-01', 'e-2', 300, -10, 20, 30, 260]);
    rejects(db, payroll, ['2026-1', 'e-2', 300, 10, 20, 30, 240]);
  });
});

test('存货成本的期间、预算不为负、押金抵扣要指明往来、坏账核销不为负、对账单起止日、票据到期日和金额', () => {
  withBusinessDb((db) => {
    openJanuary(db);
    const owed = receivable(db),
      posted = draftVoucher(db);
    const cost =
      "INSERT INTO fin_inventory_costs(stock_id,period,stock_name,unit,opening_qty,opening_cents,in_qty,in_cents,out_qty,out_cents,end_qty,end_cents) VALUES(?,?,'虚构纸板',?,0,0,0,0,0,0,0,0)";
    accepts(db, cost, [1, '2026-01', '张']);
    rejects(db, cost, [2, '2026-13', '张']);
    rejects(db, "INSERT INTO fin_budgets(period,account_code,amount_cents) VALUES('2026-01','1001',-1)");
    const deposit = insertId(
      db,
      "INSERT INTO fin_deposits(kind,party_kind,party_id,party_name,date,amount_cents,description) VALUES('paid','supplier','1','虚构供应商','2026-01-15',100,'虚构押金')",
    );
    const action = 'INSERT INTO fin_deposit_actions(deposit_id,kind,date,amount_cents,obligation_id) VALUES(?,?,?,?,?)';
    accepts(db, action, [deposit, 'refund', '2026-01-20', 50, null]);
    accepts(db, action, [deposit, 'apply', '2026-01-20', 50, owed]);
    rejects(db, action, [deposit, 'apply', '2026-01-20', 50, null]);
    rejects(db, action, [deposit, 'refund', '2026-01-20', 0, null]);
    const badDebt = 'INSERT INTO fin_bad_debts(obligation_id,kind,date,amount_cents,reason,voucher_id) VALUES(?,?,?,?,?,?)';
    accepts(db, badDebt, [owed, 'note', '2026-01-20', -50, '票据结算转回记负数', posted]);
    rejects(db, badDebt, [owed, 'writeoff', '2026-01-20', -50, '核销不能为负', posted]);
    const statement = 'INSERT INTO fin_statements(kind,party_id,from_date,to_date,status,discrepancy) VALUES(?,?,?,?,?,?)';
    accepts(db, statement, ['receivable', '1', '2026-01-01', '2026-01-31', 'difference', '差异说明是文字，不是 JSON']);
    rejects(db, statement, ['receivable', '2', '2026-02-01', '2026-01-31', 'sent', '']);
    const note = "INSERT INTO fin_notes(number,kind,bank,party_id,party_name,date,due_date,amount_cents,status) VALUES(?,?,'虚构银行','1','虚构客户',?,?,?,?)";
    accepts(db, note, ['P1', 'receivable', '2026-01-15', '2026-07-15', 100, 'held']);
    rejects(db, note, ['P2', 'receivable', '2026-01-15', '2026-01-14', 100, 'held']);
    rejects(db, note, ['P2', 'receivable', '2026-01-15', '2026-07-15', 0, 'held']);
  });
});
