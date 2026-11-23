// 初始化删原件归档：只在清了导入台账时删；最后删，删不掉只给警告不推翻；工作区清理失败就不删；跟着外层事务走。
import { sales } from '../server/sales/index.js';
import { pageActor } from './actor-fixture.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  Store,
  count,
  many,
  one,
  rows,
  type Actor,
  localAdministratorActor,
  viaEntry,
} from '../server/core/index.js';
import { testImports } from './order-import-fixture.js';
import { BusinessReset } from '../server/admin/business-reset.js';
import { clearArchiveNow, deferArchiveCleanup } from '../server/admin/reset-archive.js';
// 初始化时各模块清自己的表，删除时各模块配合（server/core/records/deletion-rules.ts）。
// 初始化要求单据导出登记了清空规则，不引它，单独跑这个文件会报“初始化要单据导出模块配合”
import '../server/finance/index.js';
import '../server/import/index.js';
import '../server/documents/index.js';
import { AUDIT_SOURCE } from '../shared/core/audit-sources.js';
import { customerSchema, productSchema } from '../shared/core/domain.js';
import { AiSettingsManager } from '../server/ai/settings-manager.js';
import { testProtector as protector } from './fake-deepseek.js';

const superActor = (): Actor => (pageActor({ id: 'p0', name: '虚构操作员', permissions: ['business:edit'], role: 'super_admin', superAdminMode: true, superAdminUntil: Date.now() + 60000 }));
const auditor: Actor = pageActor({ id: 'audit-fixture', name: '虚构验收员', permissions: ['business:edit'] });

const owner = () =>
  localAdministratorActor({
    ...auditor,
    role: 'super_admin',
    superAdminMode: true,
    superAdminUntil: Date.now() + 120000,
  });

/** 初始化要用识别导入的两件事（BusinessReset 第二个参数）：替身照这个写 */
type ResetImports = NonNullable<ConstructorParameters<typeof BusinessReset>[1]>;

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function seedBusiness(store: Store) {
  sales(store).createCustomer(customerSchema.parse({ name: '虚构初始化客户' }));
  sales(store).createProduct(productSchema.parse({ name: '虚构初始化产品' }));
}

const customerCount = (store: Store) => count(store.db, 'SELECT COUNT(*) FROM customers');

const auditCount = (store: Store, action: string) =>
  count(store.db, 'SELECT COUNT(*) FROM business_audit WHERE action=?', action);

test('初始化清空导入台账时一并删除原件归档；只清工作区时不删', () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-p0-archive-')),
    archive = join(dir, 'import-archive'),
    store = new Store(':memory:'),
    settings = new AiSettingsManager({
      file: join(dir, 'ai.sqlite'),
      protector: { protect: (s) => s, unprotect: (s) => s },
    }),
    who = localAdministratorActor(superActor());
  const seed = () => {
    for (const hash of ['a'.repeat(64), 'b'.repeat(64)]) {
      mkdirSync(join(archive, hash), { recursive: true });
      writeFileSync(join(archive, hash, 'original'), '虚构原件');
    }
  };
  const withArchive = testImports({ directory: join(dir, 'ai-imports'), archiveDirectory: archive, settings });
  try {
    seed();
    new BusinessReset(store, withArchive).execute({ scope: 'ai-imports' }, who);
    assert.equal(readdirSync(archive).length, 2, '只清工作区时导入台账还在，原件归档保留');
    const result = new BusinessReset(store, withArchive).execute({ scope: 'business' }, who);
    assert.equal(result.archives, 2);
    assert.deepEqual(readdirSync(archive), [], '归档目录清空，目录本身保留');
    seed();
    assert.equal(new BusinessReset(store, withArchive).execute({ scope: 'all' }, who).archives, 2);
    assert.deepEqual(readdirSync(archive), []);
  } finally {
    withArchive.close?.();
    settings.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('原件归档最后删：工作区和审计都完成后才删，删不掉只记警告不推翻结果', () => {
  const store = new Store(':memory:');
  try {
    seedBusiness(store);
    const order: string[] = [];
    const imports: ResetImports = {
      deleteAllWorkspaces: () => {
        order.push('workspaces');
        return { count: 0, ids: [], failed: [] };
      },
      clearArchive: () => {
        order.push(auditCount(store, 'business-reset') === 1 ? 'archive-after-audit' : 'archive-before-audit');
        throw new Error('虚构权限不足');
      },
    };
    const result = new BusinessReset(store, imports).execute({ scope: 'all' }, owner());
    assert.deepEqual(order, ['workspaces', 'archive-after-audit']);
    assert.equal(customerCount(store), 0);
    assert.equal(result.archives, 0);
    const warning = result.warnings?.[0];
    assert.ok(warning, '带回了警告');
    assert.match(warning, /业务数据已清空，但原件归档没有删干净：虚构权限不足/);
    assert.equal(auditCount(store, 'business-reset'), 1);
    assert.equal(auditCount(store, 'business-reset-warning'), 1);
  } finally {
    store.close();
  }
});

test('识别工作区清理失败时原件归档不删；在外层事务里提示业务数据没有清空', () => {
  const store = new Store(':memory:');
  try {
    let archiveCalls = 0;
    const failing: ResetImports = {
      clearArchive: () => {
        archiveCalls++;
        return 0;
      },
      deleteAllWorkspaces: () => ({ count: 1, ids: ['fictional-ok'], failed: ['fictional-failed'] }),
    };
    seedBusiness(store);
    assert.throws(
      () => new BusinessReset(store, failing).execute({ scope: 'all' }, owner()),
      /业务数据已清空；已清理1份AI工作区，另有1份失败.*原件归档暂未删除/,
    );
    assert.equal(archiveCalls, 0);

    seedBusiness(store);
    store.db.exec('SAVEPOINT fictional_outer');
    try {
      assert.throws(
        () => new BusinessReset(store, failing).execute({ scope: 'all' }, owner()),
        (e: Error) =>
          /本次初始化已撤回，业务数据没有清空/.test(e.message) && !/业务数据已清空/.test(e.message),
      );
    } finally {
      store.db.exec('ROLLBACK TO fictional_outer; RELEASE fictional_outer');
    }
    assert.equal(archiveCalls, 0);
    assert.equal(customerCount(store), 1, '外层回滚后业务数据还在');
  } finally {
    store.close();
  }
});

test('在外层事务里初始化：外层回滚就保留原件归档，外层提交后才删除', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'erp-audit-reset-')),
    archive = join(dir, 'import-archive'),
    store = new Store(':memory:'),
    settings = new AiSettingsManager({ protector }),
    imports = testImports({ directory: join(dir, 'ai-imports'), archiveDirectory: archive, settings });
  const seedArchive = () => {
    for (const hash of ['c'.repeat(64), 'd'.repeat(64)]) {
      mkdirSync(join(archive, hash), { recursive: true });
      writeFileSync(join(archive, hash, 'original'), '虚构原件');
    }
  };
  try {
    seedArchive();
    seedBusiness(store);
    store.db.exec('SAVEPOINT fictional_outer');
    const pending = new BusinessReset(store, imports).execute({ scope: 'business' }, owner());
    assert.equal(pending.archiveCleanup, 'after-commit');
    assert.equal(readdirSync(archive).length, 2, '还在外层事务里，不能先删原件');
    store.db.exec('ROLLBACK TO fictional_outer; RELEASE fictional_outer');
    await tick();
    await tick();
    assert.equal(readdirSync(archive).length, 2, '外层回滚后导入台账还在，原件归档保留');
    assert.equal(customerCount(store), 1);
    assert.equal(auditCount(store, 'business-reset'), 0);

    store.db.exec('SAVEPOINT fictional_outer');
    new BusinessReset(store, imports).execute({ scope: 'business' }, owner());
    store.db.exec('RELEASE fictional_outer');
    await tick();
    await tick();
    assert.deepEqual(readdirSync(archive), [], '外层提交后删除原件归档');
    assert.equal(customerCount(store), 0);
    const row = one(
      store.db,
      rows.business_audit.pick({ document: true }),
      "SELECT document FROM business_audit WHERE action='business-reset-archive'",
    );
    assert.ok(row, '记了删原件归档的审计');
    assert.equal(z.object({ archives: z.number() }).parse(JSON.parse(row.document)).archives, 2);

    // 不在事务里直接调用时照旧当场删除并返回份数
    seedArchive();
    const direct = new BusinessReset(store, imports).execute({ scope: 'business' }, owner());
    assert.equal(direct.archives, 2);
    assert.equal(direct.archiveCleanup, undefined);
    assert.deepEqual(readdirSync(archive), []);
  } finally {
    imports.close();
    settings.close();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('初始化删原件归档直接调用：删成了记审计；删不掉只给警告不抛错；从数据管理发起的初始化审计来源是数据管理', () => {
  const store = new Store(':memory:');
  try {
    // 数据管理的地址（server/admin/data-management-router.ts）给账号标上数据管理这个入口
    const who = viaEntry(owner(), AUDIT_SOURCE.dataManagement),
      resetId = randomUUID();
    assert.deepEqual(clearArchiveNow(store, who, 'business', resetId, () => 3), { archives: 3 });
    const failed = clearArchiveNow(store, who, 'business', resetId, () => {
      throw new Error('虚构权限不足');
    });
    assert.equal(failed.archives, 0);
    assert.ok(failed.warning, '带回了警告');
    assert.match(failed.warning, /原件归档没有删干净：虚构权限不足/);
    const sources = many(
      store.db,
      rows.business_audit.pick({ action: true, source: true }),
      "SELECT action,source FROM business_audit WHERE action LIKE 'business-reset%' ORDER BY id",
    ).map((r) => r.action + '/' + r.source);
    assert.deepEqual(sources, ['business-reset-archive/data-management', 'business-reset-warning/data-management']);
    // 数据管理窗口（不带 by）清空业务数据：审计来源是数据管理，不是助手
    new BusinessReset(store, undefined).execute({ scope: 'business' }, who);
    assert.equal(
      one(store.db, rows.business_audit.pick({ source: true }), "SELECT source FROM business_audit WHERE action='business-reset'")?.source,
      AUDIT_SOURCE.dataManagement,
    );
  } finally {
    store.close();
  }
});

// 审计记不上（这里用关掉的库造出来）不推翻删原件归档的结果，只在服务端日志留下没记上的那一笔
test('原件删成了、审计记不上：照样回删了几份，日志写明审计没记上', (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const store = new Store(':memory:');
  store.close();
  assert.deepEqual(clearArchiveNow(store, owner(), 'business', randomUUID(), () => 3), { archives: 3 });
  assert.equal(logged.mock.callCount(), 1);
  assert.match(String(logged.mock.calls[0].arguments[0]), /原件归档已删除，审计没有记上/);
});

test('原件删不掉、警告的审计也记不上：照样回警告不抛错，日志里有警告原文', (t) => {
  const logged = t.mock.method(console, 'error', () => {});
  const store = new Store(':memory:');
  store.close();
  const failed = clearArchiveNow(store, owner(), 'business', randomUUID(), () => {
    throw new Error('虚构权限不足');
  });
  assert.equal(failed.archives, 0);
  assert.ok(failed.warning, '带回了警告');
  assert.match(failed.warning, /原件归档没有删干净：虚构权限不足/);
  assert.equal(logged.mock.callCount(), 1);
  assert.match(String(logged.mock.calls[0].arguments[0]), /原件归档没有删干净：虚构权限不足.*审计没有记上/);
});

test('等外层提交再删原件时库已经关了：不删，原件留着下次初始化再清', async () => {
  const store = new Store(':memory:');
  let calls = 0;
  deferArchiveCleanup({
    store,
    actor: owner(),
    scope: 'business',
    resetId: randomUUID(),
    auditRow: 1,
    clear: () => ++calls,
  });
  store.close();
  await tick();
  await tick();
  assert.equal(calls, 0);
});

test('第一次看时外层事务还没结束：过一会儿再看，还没结束就接着等，提交以后才删原件', (t) => {
  t.mock.timers.enable({ apis: ['setImmediate', 'setTimeout'] });
  const store = new Store(':memory:');
  let calls = 0;
  const imports: ResetImports = {
    deleteAllWorkspaces: () => ({ count: 0, ids: [], failed: [] }),
    clearArchive: () => ++calls,
  };
  try {
    seedBusiness(store);
    store.db.exec('SAVEPOINT fictional_outer');
    assert.equal(new BusinessReset(store, imports).execute({ scope: 'business' }, owner()).archiveCleanup, 'after-commit');
    t.mock.timers.tick(0);
    assert.equal(calls, 0, '第一次看：还在外层事务里，不删');
    t.mock.timers.runAll();
    assert.equal(calls, 0, '过一会儿再看：外层还没结束，接着等');
    store.db.exec('RELEASE fictional_outer');
    t.mock.timers.runAll();
    assert.equal(calls, 1, '外层提交后，下一次再看时删了');
  } finally {
    store.close();
  }
});
