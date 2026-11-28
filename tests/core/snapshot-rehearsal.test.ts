// 试执行（出助手卡片时在回滚点里跑一遍，server/core/storage/savepoint.ts 的 rehearse）不拍破坏前快照：试完整段撤回，什么都没动；
// 真执行照拍（丢数据保护）。规则只在 server/core/backup/snapshots.ts 的 snapshotBeforeDestructive 一处。
// 用临时目录里的文件库（内存库不拍快照），虚构数据。
import '../../server/import/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, localAdministratorActor, rehearse } from '../../server/core/index.js';
import { createBusinessService } from '../../server/orders/index.js';
import { sales } from '../../server/sales/index.js';
import { customerSchema } from '../../shared/core/domain.js';
import { pageActor } from '../support/actor-fixture.js';
import { businessBase } from '../support/business-base-fixture.js';

const admin = localAdministratorActor(
  pageActor({ id: 'fictional-admin', name: '虚构管理员', permissions: ['business:edit'], role: 'super_admin', superAdminMode: true, superAdminUntil: Date.now() + 60_000 }),
);

test('本机管理员改订单、客户编辑里去掉厂区：试执行不拍快照，真执行各拍一份', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-f6-rehearsal-'));
  const store = new Store(join(dir, 'erp.sqlite'));
  const snapshots = () => (existsSync(join(dir, 'snapshots')) ? readdirSync(join(dir, 'snapshots')) : []);
  try {
    const base = businessBase(admin, store);
    const a = base.customer({ name: '虚构甲', sites: [{ name: '虚构东厂', address: '虚构一路', isDefault: true }, { name: '虚构西厂', address: '虚构二路' }] }),
      b = base.customer({ name: '虚构乙' });
    const order = base.order(a, [base.line(base.product({ name: '虚构纸箱' }), 100)]);
    const service = createBusinessService(store),
      context = { source: 'manual-ui' as const, operatorId: admin.id, superAdminMode: true, actor: admin };
    const editOrder = () => {
      const now = sales(store).order(order.id);
      assert.ok(now);
      return service.execute({ entity: 'orders', action: 'update', id: order.id, input: { ...now, customerId: b.id } }, context);
    };
    const dropSite = () => {
      const now = sales(store).customer(a.id);
      assert.ok(now);
      return service.execute({ entity: 'customers', action: 'update', id: a.id, input: { ...customerSchema.parse({ ...now, sites: [now.sites[0]] }), version: now.version } }, context);
    };
    const jobs: (() => unknown)[] = [editOrder, dropSite];
    for (const job of jobs) {
      const before = snapshots().length;
      rehearse(store.db, job);
      assert.equal(snapshots().length, before, job.name + ' 试执行不拍快照');
      job();
      assert.equal(snapshots().length, before + 1, job.name + ' 真执行拍一份');
    }
    assert.equal(sales(store).order(order.id)?.customerId, b.id);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
