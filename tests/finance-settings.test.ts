import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Store } from '../server/db.js';
import { FinanceSettings } from '../server/finance/settings.js';
import { financePermissions } from '../shared/finance.js';

const admin = {
  id: 'admin',
  name: '虚构管理员',
  role: 'super_admin' as const,
  permissions: [...financePermissions],
};
const view = { id: 'view', name: '虚构出纳', permissions: ['finance:view', 'finance:cash'] };

test('财务迁移预置科目，期初试算失败时原子回滚，启用后锁定', () => {
  const store = new Store(':memory:');
  try {
    const service = new FinanceSettings(store);
    assert.equal(
      store.db.prepare('SELECT max(version) AS version FROM schema_migrations').get()?.version,
      17,
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
    assert.throws(
      () => service.deleteAccount(admin, { code: '1122', version: 1, requestId: 'delete' }),
      /已使用/,
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
      .prepare("SELECT document FROM business_audit WHERE source='finance'")
      .get()!;
    const audit = JSON.parse(String(row.document));
    assert.equal(audit.before.requireSeparateApprover, true);
    assert.equal(audit.after.requireSeparateApprover, false);
  } finally {
    store.close();
  }
});
