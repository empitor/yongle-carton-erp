import { pageActor } from './actor-fixture.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SNAPSHOT_DIRECTORY } from '../server/core/schema/upgrade.js';
import { Store } from '../server/core/db.js';
import { FinanceSettings } from '../server/finance/settings.js';
import { FinanceLedger } from '../server/finance/ledger.js';
import { FinanceClosing } from '../server/finance/closing.js';
import { FinanceAssets } from '../server/finance/assets.js';
import { FinancePayroll } from '../server/finance/payroll.js';
import { FinanceCosting } from '../server/finance/costing.js';
import { entry } from '../server/finance/query.js';
import { count } from '../server/core/index.js';
import { maker, newSettings, postDrafts as postAll, ledgerBalance, monthEndJobs } from './finance-fixture.js';

/** 结账：计提、成本跑完以后数据又变了（多见于反结账后改账），检查要发现，并能红冲后重做。全部虚构数据。 */
function fixture(period: string, store = ':memory:') {
  const s = new Store(store);
  newSettings(s, period, 1000000);
  new FinanceSettings(s).update(maker, {
    version: 3,
    requestId: 'income-rate',
    taxRates: { smallVat: null, urban: 0, education: 0, localEducation: 0, income: 2500 },
  });
  const ledger = new FinanceLedger(s);
  const postDrafts = () => postAll(s);
  const gl = (code: string, at = period) => ledgerBalance(s, code, at);
  const closing = new FinanceClosing(s);
  /** 结账检查的“月末各步”：过没过、哪些要重做 */
  const jobs = (at = period) => {
    const step = closing.check(maker, { period: at }).steps.find((x) => x.key === 'jobs');
    assert.ok(step && Array.isArray(step.stale), '结账检查有“月末各步”这一步');
    return { ok: step.ok, stale: step.stale };
  };
  return { s, ledger, postDrafts, gl, closing, jobs };
}

/** 2026-01 的工资表：一个虚构员工，应发 gross（分）、实发同数，没有社保公积金和个税；改已有的那行要带 version */
function saveWages(payroll: FinancePayroll, gross: number, requestId: string, version?: number) {
  return payroll.save(maker, {
    requestId,
    period: '2026-01',
    rows: [
      {
        employeeId: 'E1',
        employeeName: '虚构员工',
        department: '虚构部门',
        accountCode: '560204',
        gross,
        social: 0,
        housing: 0,
        tax: 0,
        net: gross,
        employerSocial: 0,
        employerHousing: 0,
        ...(version ? { version } : {}),
      },
    ],
  });
}

test('反结账后改了工资：结账检查发现工资、税费要重做，红冲旧凭证按新数重做后才能再结账', () => {
  const f = fixture('2026-01');
  try {
    const period = '2026-01';
    const payroll = new FinancePayroll(f.s);
    f.ledger.create(maker, {
      requestId: 'income',
      date: '2026-01-10',
      description: '虚构收入',
      entries: [entry('1002', 100000, 0, null, '销售商品收到的现金'), entry('5001', 0, 100000)],
    });
    saveWages(payroll, 30000, 'wages');
    payroll.confirm(maker, { period, requestId: 'payroll' });
    new FinanceAssets(f.s).depreciate(maker, { period, requestId: 'depr' });
    new FinanceCosting(f.s).run(maker, { period, requestId: 'cost' });
    f.postDrafts();
    f.closing.accrueTax(maker, { period, requestId: 'tax' });
    f.postDrafts();
    assert.equal(-f.gl('222105'), 17500, '所得税按 700 元利润的 25%');
    assert.deepEqual(f.jobs().stale, [], '刚跑完不用重做');
    f.closing.settleProfit(maker, { period, requestId: 'profit' });
    f.postDrafts();
    let check = f.closing.check(maker, { period });
    assert.ok(check.canClose);
    f.closing.close(maker, { period, version: check.record?.version, requestId: 'close' });
    const closed = f.closing.check(maker, { period }).record;
    f.closing.reopen(maker, { period, version: closed?.version, reason: '虚构补工资', requestId: 'reopen' });
    // 反结账后工资表改成 400 元：计提和税费都要重做，不能直接用旧数结账
    saveWages(payroll, 40000, 'wages-fix', 1);
    let step = f.jobs();
    assert.deepEqual(step.stale.map((x) => x.kind), ['payroll']);
    assert.equal(step.ok, false);
    check = f.closing.check(maker, { period });
    assert.equal(check.canClose, false);
    const record = check.record;
    assert.ok(record, '有这个月的结账记录');
    assert.throws(
      () => f.closing.close(maker, { period, version: record.version, requestId: 'close-stale' }),
      /结账检查未通过/,
    );
    const old = Number(f.s.db.prepare("SELECT voucher_id FROM fin_period_jobs WHERE period=? AND kind='payroll'").get(period)?.voucher_id);
    payroll.confirm(maker, { period, requestId: 'payroll-redo', redo: true });
    f.postDrafts();
    assert.ok(
      f.s.db.prepare("SELECT 1 FROM fin_vouchers WHERE reversal_of=? AND status='posted'").get(old),
      '已记账的旧凭证红字冲销，不改不删',
    );
    assert.equal(f.s.db.prepare('SELECT status FROM fin_vouchers WHERE id=?').get(old)?.status, 'posted');
    assert.ok(f.s.db.prepare("SELECT 1 FROM fin_period_jobs WHERE period=? AND kind='payroll#1'").get(period), '旧记录留底');
    assert.equal(-f.gl('2211'), 40000, '应付工资按新数');
    step = f.jobs();
    assert.deepEqual(step.stale.map((x) => x.kind), ['tax'], '利润变了，税费也要重做');
    f.closing.accrueTax(maker, { period, requestId: 'tax-redo', redo: true });
    f.postDrafts();
    assert.equal(-f.gl('222105'), 15000, '所得税按 600 元利润重算');
    assert.equal(f.jobs().ok, true);
    // 损益结转按补差的老办法补做，然后才能结账
    f.closing.settleProfit(maker, { period, requestId: 'profit-supplement' });
    f.postDrafts();
    check = f.closing.check(maker, { period });
    assert.ok(check.canClose, JSON.stringify(check.steps));
    f.closing.close(maker, { period, version: check.record?.version, requestId: 'close-again' });
    assert.equal(f.gl('3103'), -45000, '本年利润 = 1000 - 400 - 150');
  } finally {
    f.s.close();
  }
});

test('折旧计提以后又补了资产：检查提示重做折旧，重做后按新资产计提', () => {
  const f = fixture('2026-01');
  try {
    const assets = new FinanceAssets(f.s);
    const add = (number: string, date: string) => {
      assets.add(maker, {
        requestId: 'asset-' + number,
        date,
        number,
        name: '虚构设备' + number,
        category: '设备',
        original: 120000,
        months: 12,
        residualBp: 0,
        department: '虚构部门',
        expenseAccount: '560205',
        counterAccount: '3001',
      });
      f.postDrafts();
    };
    add('A1', '2026-01-10');
    assets.depreciate(maker, { period: '2026-02', requestId: 'depr' });
    f.postDrafts();
    assert.equal(-f.gl('1602', '2026-02'), 10000);
    assert.deepEqual(f.jobs('2026-02').stale, []);
    add('A2', '2026-01-20');
    assert.deepEqual(f.jobs('2026-02').stale.map((x) => x.kind), ['depreciation']);
    assets.depreciate(maker, { period: '2026-02', requestId: randomUUID(), redo: true });
    f.postDrafts();
    assert.equal(-f.gl('1602', '2026-02'), 20000, '两台都提了折旧，旧凭证冲销没有重复');
    assert.equal(count(f.s.db, "SELECT count(*) FROM fin_depreciation WHERE period='2026-02'"), 2);
    assert.deepEqual(f.jobs('2026-02').stale, []);
  } finally {
    f.s.close();
  }
});

test('计提后重新导入工资表：整月覆盖不要版本列，少了的员工删掉；从旧页面再点重做被拦下', async () => {
  const f = fixture('2026-01');
  try {
    const period = '2026-01';
    const payroll = new FinancePayroll(f.s);
    const csv = (lines: string[]) =>
      Buffer.from(['工号,姓名,部门,科目,应发,个人社保,个人公积金,个税,实发,单位社保,单位公积金', ...lines].join('\n'));
    await payroll.upload(maker, { period, format: 'csv', requestId: 'upload-1' }, csv([
      'E1,虚构甲,虚构部门,560204,300.00,0,0,0,300.00,0,0',
      'E2,虚构乙,虚构部门,560204,200.00,0,0,0,200.00,0,0',
    ]));
    payroll.confirm(maker, { period, requestId: 'payroll' });
    f.postDrafts();
    await payroll.upload(maker, { period, format: 'csv', requestId: 'upload-2' }, csv([
      'E1,虚构甲,虚构部门,560204,350.00,0,0,0,350.00,0,0',
    ]));
    // 看明细时一行是一个员工（工资表整行）
    const listed = payroll.list(maker, { period, detail: '1' }).rows.map((r) => [r.employee_id, Number(r.gross)]);
    assert.deepEqual(listed, [['E1', 35000]], '整月覆盖，乙删掉');
    const step = f.jobs();
    const stale = step.stale.find((x) => x.kind === 'payroll');
    assert.ok(stale, '提示重做工资计提');
    assert.throws(
      () => payroll.confirm(maker, { period, requestId: 'redo-old', redo: true, expectedVoucherId: Number(stale.voucherId) + 100 }),
      /已经重做过了/,
    );
    payroll.confirm(maker, { period, requestId: 'redo', redo: true, expectedVoucherId: stale.voucherId });
    f.postDrafts();
    assert.equal(-f.gl('2211'), 35000);
    assert.equal(f.jobs().stale.length, 0);
  } finally {
    f.s.close();
  }
});

test('结账按顺序：上月没结账时本月不能结转损益、不能结账；有没记账的凭证不能结转；12 月以外不能结转年度利润', () => {
  const f = fixture('2026-01');
  try {
    monthEndJobs(f.s, '2026-01');
    f.closing.settleProfit(maker, { period: '2026-01', requestId: 'profit-2026-01' });
    f.postDrafts();
    assert.throws(() => f.closing.settleProfit(maker, { period: '2026-01', annual: true, requestId: 'annual' }), /仅 12 月/);
    f.ledger.create(maker, {
      requestId: 'feb-income',
      date: '2026-02-10',
      description: '虚构二月收入',
      entries: [entry('1002', 100, 0, null, '销售商品收到的现金'), entry('5001', 0, 100)],
    });
    assert.throws(() => f.closing.settleProfit(maker, { period: '2026-02', requestId: 'feb-draft' }), /未记账凭证/);
    f.postDrafts();
    assert.throws(() => f.closing.settleProfit(maker, { period: '2026-02', requestId: 'feb-early' }), /须按顺序/);
    const feb = f.closing.check(maker, { period: '2026-02' });
    assert.equal(feb.canClose, false);
    const febRecord = feb.record;
    assert.ok(febRecord, '有 2 月的结账记录');
    assert.throws(
      () => f.closing.close(maker, { period: '2026-02', version: Number(febRecord.version), requestId: 'close-feb' }),
      /期间顺序不正确/,
    );
  } finally {
    f.s.close();
  }
});

test('重新导入工资表少了员工：删之前拍一份快照；员工没少不拍', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-finance-payroll-'));
  const f = fixture('2026-01', join(dir, 'erp.sqlite'));
  try {
    const payroll = new FinancePayroll(f.s);
    const csv = (lines: string[]) =>
      Buffer.from(['工号,姓名,部门,科目,应发,个人社保,个人公积金,个税,实发,单位社保,单位公积金', ...lines].join('\n'));
    const snapshots = () =>
      existsSync(join(dir, SNAPSHOT_DIRECTORY))
        ? readdirSync(join(dir, SNAPSHOT_DIRECTORY)).filter((n) => n.includes('finance-payroll-replace')).length
        : 0;
    const both = ['E1,虚构甲,虚构部门,560204,300.00,0,0,0,300.00,0,0', 'E2,虚构乙,虚构部门,560204,200.00,0,0,0,200.00,0,0'];
    await payroll.upload(maker, { period: '2026-01', format: 'csv', requestId: 'upload-1' }, csv(both));
    await payroll.upload(maker, { period: '2026-01', format: 'csv', requestId: 'upload-2' }, csv(both));
    assert.equal(snapshots(), 0, '员工没少');
    await payroll.upload(maker, { period: '2026-01', format: 'csv', requestId: 'upload-3' }, csv([both[0]]));
    assert.equal(snapshots(), 1, '删乙之前拍了快照');
  } finally {
    f.s.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('年度反结账（12 月）只允许管理员，别的有结账权限的账号被拒', () => {
  const f = fixture('2026-12');
  try {
    const accountant = pageActor({ id: 'accountant', name: '虚构会计', permissions: maker.permissions });
    assert.throws(
      () => f.closing.reopen(accountant, { period: '2026-12', version: 2, reason: '虚构', requestId: 'reopen' }),
      /年度反结账只允许管理员/,
    );
  } finally {
    f.s.close();
  }
});
