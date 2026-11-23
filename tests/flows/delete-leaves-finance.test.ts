// 删除业务记录只管业务（server/lifecycle/database-maintenance.ts）：不要财务模块配合，删除的事务里不写财务的表；
// 被删的来源由财务下次补扫时自己发现（见 finance-source-deletion.test.ts）。全部虚构数据、内存库。
// 这个文件不静态引入财务：单独跑时第一条就是在没加载财务的情况下删的。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Store, many, localAdministratorActor } from '../../server/core/index.js';
import { DatabaseMaintenanceService } from '../../server/lifecycle/index.js';
import { z } from 'zod';
import { superActor } from '../support/actor-fixture.js';
import { setup } from '../support/delete-fixture.js';

const tableName = z.object({ name: z.string() });
const anyRow = z.record(z.string(), z.unknown());

/** 财务所有表的全部内容（表名 → 按 rowid 排好的行） */
function financeTables(s: Store) {
  const names = many(s.db, tableName, "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'fin\\_%' ESCAPE '\\'");
  return Object.fromEntries(names.map(({ name }) => [name, many(s.db, anyRow, 'SELECT * FROM "' + name + '" ORDER BY rowid')]));
}

test('不加载财务模块也能删已入库的到货单', () => {
  const f = setup(),
    admin = superActor();
  try {
    const selection = f.selection(f.stocked),
      plan = f.service.preview(selection, admin);
    f.service.delete({ ...selection, requestId: randomUUID(), deletionDigest: plan.digest }, admin, 'test-binding');
    assert.equal(f.exists(f.stocked.id), false);
  } finally {
    f.store.close();
  }
});

test('删除财务已经记过事件的送货单：财务的表一行都不变，补扫以后才标成来源已删除', async () => {
  // 第一条要在没加载财务时跑，财务的准备代码放到这里才加载
  const { maker, newSettings, physical, deliveryDoc } = await import('../finance/finance-fixture.js');
  const { FinanceEvents } = await import('../../server/finance/events/events.js');
  const s = new Store(':memory:');
  try {
    newSettings(s);
    physical(s, 1, 'delivery', '2026-01-20', deliveryDoc('1'));
    const events = new FinanceEvents(s);
    events.sync(maker);
    const before = financeTables(s);
    assert.ok(before.fin_events.length > 0, '测试数据：送货单已经进了财务');
    const admin = localAdministratorActor(maker),
      service = new DatabaseMaintenanceService(s),
      selection = { module: 'delivery', items: [{ id: 1, version: 1 }] },
      plan = service.preview(selection, admin);
    service.delete({ ...selection, requestId: randomUUID(), deletionDigest: plan.digest }, admin, 'test-binding');
    assert.deepEqual(financeTables(s), before);
    events.sync(maker);
    const observed = many(s.db, z.object({ status: z.string() }), "SELECT status FROM fin_source_observations WHERE source_id='1'");
    assert.deepEqual(observed.map((r) => r.status), ['deleted']);
  } finally {
    s.close();
  }
});
