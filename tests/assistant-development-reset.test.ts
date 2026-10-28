import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { assistantFixture, actor, superActor } from './assistant-fixture.js';
import { createOrderWorkflowFixture } from './assistant-workflow-fixture.js';
import { imageFixture } from './import-fixtures.js';
import { localAdministratorActor } from '../server/developer-capability.js';
import { customerSchema, productSchema } from '../shared/domain.js';

test('本机最高管理员可一次清空业务数据，普通账号被拒绝，清理写入审计', () => {
  const f = assistantFixture();
  try {
    const previous = f.store.saveCustomer(customerSchema.parse({ name: '一键清空客户' }));
    f.store.saveProduct(
      productSchema.parse({
        name: '一键清空产品',
        length: 30,
        width: 20,
        height: 10,
        dimensionUnit: 'cm',
        material: 'BC',
        flute: 'BC',
      }),
    );
    assert.throws(
      () => f.manager.tools.prepare('management.reset', { scope: 'business' }, actor, 'binding'),
      /最高管理员/,
    );
    const who = localAdministratorActor(superActor());
    const plan = f.manager.tools.prepare('management.reset', { scope: 'business' }, who, 'binding');
    assert.equal(plan.before.tables.customers, 1);
    const result = f.manager.tools.commit(plan, who, 'binding');
    assert.equal(result.scope, 'business');
    assert.ok(result.count >= 2);
    assert.equal(
      f.manager.tools.prepare('management.reset', { scope: 'business' }, who, 'binding').before
        .tables.customers,
      0,
    );
    assert.equal(
      (
        f.store.db
          .prepare("SELECT count(*) AS n FROM business_audit WHERE action = 'development-reset'")
          .get() as any
      ).n,
      1,
    );
    const next = f.store.saveCustomer(customerSchema.parse({ name: '初始化后的虚构客户' }));
    assert(next.id > previous.id, '保留的审计与旧任务不能指向复用ID的新记录');
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.close();
  }
});

test('management.workspaces 的 list 允许携带可选 requestId，不触发业务写入', async () => {
  const f = createOrderWorkflowFixture();
  try {
    f.replies.push({
      message: '查询识别工作区',
      toolCalls: [
        { name: 'management.workspaces', args: { action: 'list', requestId: randomUUID() } },
      ],
    });
    await f.send('查一下识别工作区');
    assert.equal(f.imports.status().workspaces.length, 0);
    assert.equal(f.store.customers().length, 1);
  } finally {
    f.close();
  }
});

test('清空全部数据同时删除AI识别工作区和原件', async () => {
  const f = createOrderWorkflowFixture();
  try {
    await f.imports.upload(imageFixture(true), 'invoice.jpg', true);
    assert.equal(f.imports.status().workspaces.length, 1);
    const who = localAdministratorActor(superActor());
    const plan = f.manager.tools.prepare('management.reset', { scope: 'all' }, who, 'binding');
    const result = f.manager.tools.commit(plan, who, 'binding');
    assert.equal(result.scope, 'all');
    assert.ok(result.aiImports >= 1);
    assert.equal(f.imports.status().workspaces.length, 0);
    assert.equal(f.imports.archives().length, 0);
    assert.equal(f.store.customers().length, 0);
  } finally {
    f.close();
  }
});
