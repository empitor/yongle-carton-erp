import { sales } from '../server/sales/index.js';
import { pageActor } from './actor-fixture.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/core/db.js';
import { SCHEMA_LATEST } from '../server/core/schema/index.js';
import { FinanceSettings } from '../server/finance/base/settings.js';
import { FinanceTemplates } from '../server/finance/base/template.js';
import { financePermissions } from '../shared/core/accounts.js';
import { FinanceLedger } from '../server/finance/ledger/ledger.js';
import { entry } from '../server/finance/base/query.js';
import { maker, newSettings, post } from './finance-fixture.js';
import { count, type Actor } from '../server/core/index.js';
import { z } from 'zod';

/** 财务设置审计里改前改后的“审核分离”这一项 */
const settingsAudit = z.object({
  before: z.object({ requireSeparateApprover: z.unknown() }),
  after: z.object({ requireSeparateApprover: z.unknown() }),
});

const admin = pageActor({
  id: 'admin',
  name: '虚构管理员',
  role: 'super_admin' as const,
  permissions: [...financePermissions],
});
const view = pageActor({ id: 'view', name: '虚构出纳', permissions: ['finance:view', 'finance:cash'] });

test('新库预置科目，期初试算失败时原子回滚，启用后锁定', () => {
  const store = new Store(':memory:');
  try {
    const service = new FinanceSettings(store);
    assert.equal(
      store.db.prepare('SELECT max(version) AS version FROM schema_migrations').get()?.version,
      SCHEMA_LATEST,
    );
    assert.equal(service.accounts(view).find((a) => a.code === '222101')?.leaf, 0);
    assert.equal(service.accounts(view).find((a) => a.code === '22210101')?.leaf, 1);
    const receivable = { accountCode: '1122', debit: 300, credit: 0, yearDebit: 0, yearCredit: 0 };
    const capital = { accountCode: '3001', debit: 0, credit: 300, yearDebit: 0, yearCredit: 0 };
    const customer = { kind: 'customer', id: '1', name: '虚构客户' };
    const opening = { period: '2026-01', taxpayer: 'general', version: 1, requestId: 'enable' };
    assert.throws(() => service.enable(view, { ...opening, rows: [] }), /权限/);
    assert.throws(
      () => service.enable(admin, { ...opening, rows: [receivable, capital] }),
      /辅助明细/,
    );
    assert.equal(service.opening(admin).rows.length, 0);
    assert.throws(
      () => service.enable(admin, { ...opening, rows: [{ ...capital, credit: 0, debit: 300 }] }),
      /借贷平衡/,
    );
    const payload = {
      ...opening,
      rows: [receivable, { ...receivable, auxiliary: customer }, capital],
    };
    const enabled = service.enable(admin, payload);
    assert.equal(enabled.startPeriod, '2026-01');
    assert.deepEqual(service.enable(admin, payload), enabled);
    assert.throws(
      () => service.enable(admin, { ...payload, version: 2, requestId: 'again' }),
      /锁定/,
    );
  } finally {
    store.close();
  }
});

test('财务设置权限和版本校验，审核分离配置修改前后都写审计', () => {
  const store = new Store(':memory:');
  try {
    const service = new FinanceSettings(store);
    assert.throws(() => service.get({ ...view, permissions: [] }), /权限/);
    const patch = { version: 1, requestId: 'allow', requireSeparateApprover: false };
    assert.throws(() => service.update({ ...admin, role: undefined }, patch), /仅管理员/);
    assert.equal(service.update(admin, patch).requireSeparateApprover, false);
    assert.throws(() => service.update(admin, { ...patch, requestId: 'stale' }), /已更新/);
    const row = store.db
      .prepare("SELECT document FROM business_audit WHERE entity='fin_settings'")
      .get();
    const audit = settingsAudit.parse(JSON.parse(String(row?.document)));
    assert.equal(audit.before.requireSeparateApprover, true);
    assert.equal(audit.after.requireSeparateApprover, false);
  } finally {
    store.close();
  }
});

test('财务设置的变更历史：新库没有预置行；每次保存、启用各记一行改完以后的样子，失败和重复提交不记，审计照常另写', () => {
  const store = new Store(':memory:');
  try {
    const service = new FinanceSettings(store);
    const history = () => store.db.prepare('SELECT * FROM fin_settings_history ORDER BY id').all();
    assert.deepEqual(history(), [], '新库不预置行：一次都没改过就是默认值');
    const patch = { version: 1, requestId: 'allow', requireSeparateApprover: false };
    const saved = service.update(admin, patch);
    assert.deepEqual(service.update(admin, patch), saved, '重复提交原样返回');
    assert.throws(() => service.update(admin, { ...patch, requestId: 'stale' }), /已更新/);
    assert.equal(history().length, 1, '重复提交、版本不对的保存都不记历史');
    const first = history()[0];
    assert.equal(first.settings_version, 2);
    assert.equal(first.require_separate_approver, 0);
    assert.equal(first.revenue_recognition, 'delivery');
    assert.equal(first.taxpayer, null);
    assert.equal(first.cost_allocation, 'output');
    assert.deepEqual(JSON.parse(String(first.aging_days)), [30, 60, 90, 180, 365]);
    assert.deepEqual(JSON.parse(String(first.tax_rates)), service.get(admin).taxRates);
    assert.equal(first.actor_id, admin.id);
    assert.equal(first.actor_name, admin.name);
    assert.match(String(first.changed_at), /^\d{4}-\d{2}-\d{2}T/);
    // 启用时定下纳税人身份，也记一行
    service.enable(admin, { period: '2026-01', taxpayer: 'small', version: 2, requestId: 'enable', rows: [] });
    assert.equal(history().length, 2);
    assert.equal(history()[1].taxpayer, 'small');
    assert.equal(history()[1].settings_version, 3);
    service.update(admin, { version: 3, requestId: 'policy', revenueRecognition: 'invoice', agingDays: [15, 45, 75, 120, 300] });
    const last = history()[2];
    assert.equal(last.revenue_recognition, 'invoice');
    assert.equal(last.settings_version, 4);
    assert.equal(last.taxpayer, 'small');
    assert.equal(last.require_separate_approver, 0);
    assert.deepEqual(JSON.parse(String(last.aging_days)), [15, 45, 75, 120, 300]);
    assert.equal(
      count(store.db, "SELECT count(*) FROM business_audit WHERE entity='fin_settings' AND action='update'"),
      2,
      '审计照常另写',
    );
  } finally {
    store.close();
  }
});

test('启用财务：应收、应付、预收、预付按单位填期初就行，科目合计系统加出来，往来跟着建好', async () => {
  const { customerSchema } = await import('../shared/core/domain.js');
  const { OperationsService } = await import('../server/operations/index.js');
  const { FinanceParties } = await import('../server/finance/parties/parties.js');
  const store = new Store(':memory:');
  try {
    sales(store).createCustomer(customerSchema.parse({ name: '虚构客户甲' }));
    sales(store).createCustomer(customerSchema.parse({ name: '虚构客户乙' }));
    new OperationsService(store).saveSupplier({ name: '虚构供应商' }, { ...admin, permissions: [...admin.permissions, 'business:edit'] });
    const service = new FinanceSettings(store);
    const customer = (id: string, name: string) => ({ kind: 'customer', id, name });
    const supplier = { kind: 'supplier', id: '1', name: '虚构供应商' };
    service.enable(admin, {
      period: '2026-03',
      taxpayer: 'general',
      version: 1,
      requestId: 'enable',
      rows: [
        { accountCode: '1122', auxiliary: customer('1', '虚构客户甲'), debit: 300000, credit: 0, yearDebit: 0, yearCredit: 0 },
        { accountCode: '1122', auxiliary: customer('2', '虚构客户乙'), debit: 200000, credit: 0, yearDebit: 0, yearCredit: 0 },
        { accountCode: '2202', auxiliary: supplier, debit: 0, credit: 150000, yearDebit: 0, yearCredit: 0 },
        { accountCode: '2203', auxiliary: customer('2', '虚构客户乙'), debit: 0, credit: 50000, yearDebit: 0, yearCredit: 0 },
        { accountCode: '3001', debit: 0, credit: 300000, yearDebit: 0, yearCredit: 0 },
      ],
    });
    const controls = store.db
      .prepare('SELECT account_code,debit,credit FROM fin_opening WHERE auxiliary_id IS NULL ORDER BY account_code')
      .all()
      .map((r) => [r.account_code, Number(r.debit), Number(r.credit)]);
    assert.deepEqual(controls, [
      ['1122', 500000, 0],
      ['2202', 0, 150000],
      ['2203', 0, 50000],
      ['3001', 0, 300000],
    ]);
    const parties = new FinanceParties(store);
    const owed = (kind: 'receivable' | 'payable') =>
      parties.obligations(admin, { kind }).rows.map((r) => [r.party_name, Number(r.balance)]).sort();
    assert.deepEqual(owed('receivable'), [['虚构客户乙', 200000], ['虚构客户甲', 300000]]);
    assert.deepEqual(owed('payable'), [['虚构供应商', 150000]]);
    // 启用后纳税人身份锁定，界面上写的“已锁定”服务端也拦
    const settings = service.get(admin);
    assert.throws(
      () => service.update(admin, { version: settings.version, requestId: 'small', taxpayer: 'small' }),
      /纳税人身份已锁定/,
    );
    assert.equal(
      service.update(admin, { version: settings.version, requestId: 'same', taxpayer: 'general', agingDays: [30, 60, 90, 180, 365] })
        .taxpayer,
      'general',
      '不改身份的保存照常',
    );
  } finally {
    store.close();
  }
});

test('凭证模板：送货、到货的往来科目只能是应收账款、应付账款或它们的下级', () => {
  const store = new Store(':memory:');
  try {
    const templates = new FinanceTemplates(store);
    const delivery = templates.list(admin).find((t) => t.name === 'delivery.confirmed');
    assert.ok(delivery, '有送货确认的模板');
    assert.throws(
      () =>
        templates.save(admin, {
          name: delivery.name,
          version: delivery.version,
          requestId: 'party-1221',
          mapping: { ...delivery.mapping, party: '1221' },
        }),
      /送货确认的往来科目只能用应收账款（1122）/,
    );
    const arrival = templates.list(admin).find((t) => t.name === 'arrival.confirmed');
    assert.ok(arrival, '有到货暂估的模板');
    assert.throws(
      () =>
        templates.save(admin, {
          name: arrival.name,
          version: arrival.version,
          requestId: 'party-1122',
          mapping: { ...arrival.mapping, party: '1122' },
        }),
      /到货暂估的往来科目只能用应付账款（2202）/,
    );
    const saved = templates.save(admin, {
      name: delivery.name,
      version: delivery.version,
      requestId: 'same',
      mapping: delivery.mapping,
    });
    assert.equal(saved.version, delivery.version + 1);
  } finally {
    store.close();
  }
});

test('记账模板页不露英文：建库预置的每个模板和其中每个用途都有中文名，往来科目的限制只有送货、到货两张', async () => {
  const { templateFieldTitles, templatePartyAccounts, templateTitles } = await import('../shared/finance/index.js');
  const store = new Store(':memory:');
  try {
    const templates = new FinanceTemplates(store).list(admin);
    assert.ok(templates.length > 5);
    for (const t of templates) {
      assert.match(templateTitles[t.name] ?? '', /\p{Script=Han}/u, t.name);
      for (const key of Object.keys(t.mapping))
        assert.match(templateFieldTitles[t.name]?.[key] ?? '', /\p{Script=Han}/u, t.name + '.' + key);
    }
    assert.deepEqual(Object.keys(templatePartyAccounts).sort(), ['arrival.confirmed', 'delivery.confirmed']);
    for (const name of Object.keys(templatePartyAccounts)) {
      const template = templates.find((t) => t.name === name);
      assert.ok(template && Object.hasOwn(template.mapping, 'party'), name);
    }
  } finally {
    store.close();
  }
});

test('科目维护：上级要存在且类别一致，用过的科目不能加下级、只能改启用状态，停用要先停下级，要结账权限', () => {
  const s = new Store(':memory:');
  try {
    newSettings(s);
    // 记一张凭证，1002、3001 成了用过的科目
    const voucher = new FinanceLedger(s).create(maker, {
      requestId: 'used',
      date: '2026-01-10',
      description: '虚构投入',
      entries: [entry('1002', 100, 0, null, '投入资本'), entry('3001', 0, 100)],
    });
    post(s, voucher.header.id);
    const settings = new FinanceSettings(s);
    const account = (code: string) => {
      const found = settings.accounts(maker).find((a) => a.code === code);
      assert.ok(found, '有科目 ' + code);
      return found;
    };
    const save = (a: Record<string, unknown>, version?: number, actor: Actor = maker) =>
      settings.saveAccount(actor, { requestId: 'account-' + JSON.stringify(a) + version, version, account: a });
    const child = (code: string, parent: { category: string; direction: string }, extra: Record<string, unknown> = {}) => ({
      code,
      name: '虚构下级',
      category: parent.category,
      direction: parent.direction,
      ...extra,
    });
    const bank = account('1002');
    assert.throws(() => save(child('100201', bank), undefined, view), /权限/);
    assert.throws(() => save(child('999901', bank)), /上级科目必须存在/);
    const other = account('5301');
    assert.throws(() => save(child('530101', other, { category: 'asset' })), /类别应一致/);
    assert.throws(() => save(child('100201', bank)), /已使用的科目不能增加下级/);
    assert.throws(
      () => save({ code: '1002', name: '虚构改名', category: bank.category, direction: bank.direction, cashKind: bank.cash_kind }, Number(bank.version)),
      /已使用的科目仅可修改启用状态/,
    );
    save(child('530101', other));
    assert.throws(
      () => save({ code: '5301', name: other.name, category: other.category, direction: other.direction, enabled: false }, Number(other.version)),
      /请先停用下级科目/,
    );
  } finally {
    s.close();
  }
});
