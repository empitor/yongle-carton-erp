// 本机管理员（在服务器本机登录的超级管理员）和数据管理：谁算本机管理员、数据管理直接改业务数据的规矩、
// AI 工作区的管理服务。助手的数据管理命令在 assistant-management-tools.test.ts。虚构数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, scryptSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { Store } from '../server/core/db.js';
import { AppError } from '../server/core/errors.js';
import { AuthManager } from '../server/core/auth.js';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { changeLifecycle } from '../server/business/lifecycle.js';
import { manageWorkspaces } from '../server/admin/workspace-management.js';
import { OperationsRepository } from '../server/operations/repository.js';
import { recordContext } from '../server/business/record-context.js';
import { customerSchema, productSchema, orderSchema } from '../shared/core/domain.js';
import { AUDIT_SOURCE } from '../shared/core/audit-sources.js';
import { historyActionName } from '../shared/business/history-fields.js';
import { superActor } from './assistant-fixture.js';
import { arrivalAssistantFixture } from './arrival-assistant-fixture.js';
import { startHttp, stateActor } from './http-fixture.js';
import { fixture } from './maintenance-fixture.js';
import { command as cmd, firstResult, firstWorkspace } from './data-management-fixture.js';

const password = 'Fictional-local-admin-123';
const jsonObject = z.record(z.string(), z.unknown());
/** 回答正文（JSON 对象） */
const body = async (r: Response) => jsonObject.parse(await r.json());
/** 库里的订单：必须在 */
function storedOrder(store: Store, id: number) {
  const order = store.order(id);
  assert.ok(order, '订单还在');
  return order;
}

/** 编辑窗给的明细（数据管理列表的 input）：明细照它改；读出来的订单、单据带着已送数量这类派生的栏目，录入不收 */
function editorLines(f: ReturnType<typeof fixture>, module: 'orders' | 'delivery', id: number) {
  const row = f.dataManagement.list(module, f.who).records.find((r) => r.record.id === id);
  assert.ok(row, '列表里有这一条');
  return row.input.lines;
}

/** 本机模式起服务：账号库是文件、时钟可拨，最高管理员从本机建好 */
async function localServer() {
  const dir = mkdtempSync(join(tmpdir(), 'erp-local-admin-')),
    file = join(dir, 'users.sqlite'),
    store = new Store(':memory:'),
    clock = { now: Date.now() };
  const h = await startHttp(store, {
    auth: new AuthManager(file, () => clock.now, { localAdministration: true }),
    admin: { name: '虚构最高管理员', password },
  });
  const req = (path: string, body?: unknown, headers: Record<string, string> = {}, method?: string, cookie = h.cookie) =>
    h.send(path, body, cookie, { headers, method });
  return {
    h,
    file,
    store,
    clock,
    req,
    async close() {
      await h.close();
      store.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('本机登录的最高管理员就是本机管理员，过了 15 分钟仍然有效，数据管理和初始化预览不用进模式', async () => {
  const s = await localServer();
  try {
    assert.equal(stateActor(await body(await s.req('/auth/state')))?.localAdministrator, true);
    s.clock.now += 16 * 60000;
    assert.equal(stateActor(await body(await s.req('/auth/state')))?.localAdministrator, true);
    const command = cmd('customers', 'create', [], { name: '虚构无需模式客户' });
    assert.equal((await s.req('/management/execute', command)).status, 200);
    assert.equal((await s.req('/management/execute', command)).status, 200, '同一请求重放');
    assert.equal(s.store.customers().length, 1);
    // 初始化预览按范围列出各表要清的条数，只看不动
    const preview = await s.req('/management/reset-preview?scope=business');
    assert.equal(preview.status, 200);
    assert.equal(z.object({ tables: z.record(z.string(), z.number()) }).parse(await preview.json()).tables.customers, 1);
    assert.equal(s.store.customers().length, 1);
  } finally {
    await s.close();
  }
});

test('本机管理员的数据管理请求也要页面凭证；带了代理头就不算本机', async () => {
  const s = await localServer();
  try {
    const command = cmd('customers', 'create', [], { name: '虚构客户' });
    assert.equal((await s.req('/management/execute', command, { 'X-ERP-Auth-Token': '' })).status, 403);
    assert.equal((await s.req('/management/execute', command, { 'X-Forwarded-For': '127.0.0.1' })).status, 403);
    assert.equal(s.store.customers().length, 0);
  } finally {
    await s.close();
  }
});

test('本机管理员能直接改已核对的订单，在页面上删除不用再输密码', async () => {
  const s = await localServer();
  try {
    const f = fixture(s.store),
      order = storedOrder(s.store, f.order.id);
    const updated = await s.req('/orders/' + order.id, { ...orderSchema.parse(order), version: order.version, notes: '直接编辑已确认订单' }, {}, 'PUT');
    assert.equal(updated.status, 200);
    assert.equal(s.store.order(order.id)?.notes, '直接编辑已确认订单');
    const clean = s.store.saveCustomer(customerSchema.parse({ name: '虚构待删客户' }));
    const selection = { module: 'customers', items: [{ id: clean.id, version: clean.version }] };
    const preview = z.object({ digest: z.string() }).parse(await (await s.req('/deletions/preview', selection)).json());
    const r = await s.req('/deletions/execute', { ...selection, requestId: randomUUID(), deletionDigest: preview.digest });
    assert.equal(r.status, 200);
    assert.equal(s.store.customer(clean.id, true), undefined);
  } finally {
    await s.close();
  }
});

test('在服务器本机登录的业务账号不是本机管理员，用不了数据管理；退出后要重新登录', async () => {
  const s = await localServer();
  try {
    const db = new DatabaseSync(s.file),
      salt = 'fictional-local-admin-salt';
    db.prepare('INSERT INTO users(id,name,salt,password_hash,permissions,role) VALUES(?,?,?,?,?,?)').run(
      randomUUID(),
      '虚构普通账号',
      salt,
      scryptSync(password, salt, 64).toString('hex'),
      '["business:edit"]',
      'admin',
    );
    db.close();
    const cookie = await s.h.login('虚构普通账号', password);
    const as = (path: string, body?: unknown) => s.req(path, body, {}, undefined, cookie);
    const actor = stateActor(await body(await as('/auth/state')));
    assert.ok(actor);
    assert.equal(actor.localAdministrator, undefined);
    assert.equal((await as('/management/execute', cmd('customers', 'create', [], { name: '不可创建' }))).status, 403);
    await as('/auth/logout', {});
    assert.equal((await as('/management/records?module=orders')).status, 401);
  } finally {
    await s.close();
  }
});

test('数据管理改已生效的完工单、送货单：改数量、日期被拒（提示用更正），库存、任务、订单一条不动；同一请求重放原样拒', () => {
  const f = fixture();
  try {
    f.arrival();
    const task = f.task(),
      production = f.production(task.id),
      delivery = f.delivery();
    const before = f.ops.repo.movements().length;
    const command = cmd('production', 'update', [production], { goodQuantity: '850' });
    assert.throws(() => f.dataManagement.execute(command, f.who, 's'), (e: unknown) => e instanceof AppError && e.status === 409 && /改数量请用“更正完工单”/.test(e.message));
    assert.throws(() => f.dataManagement.execute(cmd('delivery', 'update', [delivery], { lines: [{ ...editorLines(f, 'delivery', delivery.id)[0], quantity: '90' }] }), f.who, 's'), /改数量请用“更正送货单”/);
    assert.throws(() => f.dataManagement.execute(cmd('delivery', 'update', [delivery], { plannedDate: '2026-11-01' }), f.who, 's'), /更正送货单/);
    assert.equal(f.ops.repo.movements().length, before);
    assert.deepEqual([f.ops.repo.balance(f.raw.id), f.ops.repo.balance(f.finished.id)], [100000, 760000]);
    assert.equal(f.flow.get(task.id, 'task').completed, '860');
    assert.equal(f.store.order(f.order.id, true)?.lines[0].shippedQuantity, 100);
    f.flow.reverse(delivery.id, { version: f.flow.get(delivery.id).version, reason: '虚构发错', acknowledged: true }, f.who);
    assert.throws(() => f.dataManagement.execute(cmd('delivery', 'update', [f.flow.get(delivery.id)], { notes: '虚构' }), f.who, 's'), /已撤销、已取消、已被更正替代的单据不能再改/);
  } finally {
    f.store.close();
  }
});

test('数据管理只改已生效单据的说明（备注、操作人、地址）走说明编辑：版本加一、库存流水不动；记的是“改说明”，两条都标“数据管理”', () => {
  const f = fixture();
  try {
    f.arrival();
    const production = f.production(f.task().id),
      delivery = f.delivery();
    const before = f.ops.repo.movements().length;
    const result = firstResult(f.dataManagement.execute({ ...cmd('production', 'update', [production], { notes: '虚构批次备注B', operator: '实际机长' }), entry: AUDIT_SOURCE.dataManagement }, f.who, 's'));
    assert.deepEqual([result.notes, result.operator, result.version, result.status], ['虚构批次备注B', '实际机长', production.version + 1, 'confirmed']);
    const shipped = firstResult(f.dataManagement.execute(cmd('delivery', 'update', [delivery], { address: '虚构新地址', notes: '虚构送货备注' }), f.who, 's'));
    assert.deepEqual([shipped.address, shipped.notes], ['虚构新地址', '虚构送货备注']);
    assert.equal(f.ops.repo.movements().length, before);
    const history = recordContext(f.store, 'production', production.id, superActor()).history;
    const labeled = history.filter((e) => e.sourceLabel === '数据管理');
    assert.deepEqual(labeled.map((e) => historyActionName(e.action)), ['修改', '编辑说明'], '数据管理记的和说明编辑自己记的都在，来源都是数据管理');
    for (const e of history) assert.doesNotMatch(historyActionName(e.action), /数据管理/, e.action);
    const raw = f.ops.repo.items().find((s) => s.id === f.raw.id);
    assert.ok(raw);
    assert.throws(
      () => f.dataManagement.execute(cmd('stock_items', 'update', [raw], { balanceUnits: -1 }), f.who, 's'),
      (e: unknown) => e instanceof Error && /库存数量：是系统算出来的.*库存数量请登记盘点/.test(e.message) && !/[A-Za-z]/.test(e.message),
    );
  } finally {
    f.store.close();
  }
});

test('本机管理员删订单（删除引擎）：连送货一起删，留下生产和库存，解开任务和采购单上的引用', () => {
  const f = fixture();
  try {
    f.arrival();
    const task = f.task();
    f.production(task.id);
    f.delivery();
    const order = storedOrder(f.store, f.order.id),
      // 明确选“库存数量不动，只删单子”（默认是库存一起改回）
      selection = { module: 'orders', items: [{ id: order.id, version: order.version }], inventoryPolicy: 'preserve' as const };
    assert.equal(changeLifecycle(f.store, 'orders', { action: 'archive', items: selection.items }, f.who).results[0].success, false);
    const preview = f.service.preview(selection, f.who),
      command = { ...selection, requestId: randomUUID(), deletionDigest: preview.digest };
    f.service.delete(command, f.who, 's');
    assert.equal(f.store.order(order.id, true), undefined);
    assert.equal(f.flow.list('delivery', true).length, 0);
    assert.equal(f.flow.list('production', true).length, 1);
    assert.equal(f.ops.repo.balance(f.finished.id), 760000);
    assert.equal(f.ops.repo.balance(f.raw.id), 100000);
    assert.deepEqual(f.flow.get(task.id, 'task').orderIds, []);
    assert.equal(new OperationsRepository(f.store).purchases(true)[0].customerOrderId, null);
    f.service.delete(command, f.who, 's');
    assert.equal(f.ops.repo.balance(f.finished.id), 760000);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    f.store.close();
  }
});

test('本机管理员删订单（删除引擎）：订单版本变了、看过范围后又多了关联都拒绝，库里出错整单回滚', () => {
  const f = fixture();
  try {
    f.arrival();
    f.production();
    const maintenance = f.service;
    let order = storedOrder(f.store, f.order.id);
    const selection = () => ({ module: 'orders', items: [{ id: order.id, version: order.version }] }),
      remove = (deletionDigest: string) => maintenance.delete({ ...selection(), requestId: randomUUID(), deletionDigest }, f.who, 's'),
      old = maintenance.preview(selection(), f.who);
    f.delivery();
    // 送货出库让订单版本加一：按看到时的旧版本删被拒
    assert.throws(() => remove(old.digest), /版本已改变/);
    order = storedOrder(f.store, order.id);
    assert.throws(() => remove(old.digest), /范围|变化/);
    const fresh = maintenance.preview(selection(), f.who);
    f.store.db.exec("CREATE TRIGGER fictional_delete_failure BEFORE DELETE ON orders BEGIN SELECT RAISE(ABORT,'fixture abort'); END");
    assert.throws(() => remove(fresh.digest), /fixture abort/);
    assert.ok(f.store.order(order.id, true));
    assert.equal(f.flow.list('delivery', true).length, 1);
    assert.equal(f.ops.repo.balance(f.finished.id), 760000);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(), []);
    f.store.db.exec('DROP TRIGGER fictional_delete_failure');
    remove(maintenance.preview(selection(), f.who).digest);
    assert.equal(f.store.order(order.id, true), undefined);
  } finally {
    f.store.close();
  }
});

test('订单只关联了生产任务时，数据管理能改客户、规格、加删没被引用的明细', () => {
  const f = fixture();
  try {
    f.task();
    const another = f.store.saveCustomer(customerSchema.parse({ name: '虚构更正客户' })),
      otherProduct = f.store.saveProduct(productSchema.parse({ name: '虚构新增产品' }));
    const order = storedOrder(f.store, f.order.id);
    const input = {
      customerId: another.id,
      lines: [
        { ...editorLines(f, 'orders', order.id)[0], specification: '合理修正规格', quantity: 500 },
        { productId: otherProduct.id, quantity: 100, unitPriceCents: 200, unit: '只' },
      ],
    };
    const updated = firstResult(f.dataManagement.execute(cmd('orders', 'update', [order], input), f.who, 's'));
    assert.equal(updated.customerId, another.id);
    assert.equal(updated.lines[0].id, f.order.lines[0].id);
    assert.equal(updated.totalCents, 70000);
    const addedId = updated.lines[1].id;
    assert.ok(addedId !== undefined);
    const trimmed = firstResult(f.dataManagement.execute(cmd('orders', 'update', [updated], { lines: [editorLines(f, 'orders', updated.id)[0]] }), f.who, 's'));
    assert.equal(trimmed.lines.length, 1);
    assert.ok(!f.store.db.prepare('SELECT 1 FROM order_lines WHERE id=?').get(addedId));
    assert.equal(f.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
  } finally {
    f.store.close();
  }
});

test('AI 工作区的复制、归档、恢复、删除走同一个服务：重复和并发的请求只复制一次，改状态要带版本，审计写不进去就待核验', async () => {
  const f = await arrivalAssistantFixture(),
    who = localAdministratorActor(superActor()),
    binding = 'workspace-local';
  const manage = (raw: unknown) => manageWorkspaces(f.store, f.manager, raw, who, binding);
  try {
    const raw = { requestId: randomUUID(), action: 'fork', items: [{ id: f.workspace.id }] };
    const concurrent = await Promise.allSettled([manage(raw), manage(raw)]);
    assert.equal(concurrent.filter((r) => r.status === 'fulfilled').length, 1);
    const cloned = firstWorkspace(await manage(raw)).result;
    assert.ok(cloned);
    assert.notEqual(cloned.id, f.workspace.id);
    await manage({ requestId: randomUUID(), action: 'archive', items: [{ id: cloned.id, revision: cloned.revision }] });
    // 改状态的要带版本：没带就拦，不拿当前版本顶上
    await assert.rejects(() => manage({ requestId: randomUUID(), action: 'restore', items: [{ id: cloned.id }] }), /要带上它的版本（revision）/);
    const revision = () => f.manager.get(cloned.id).revision;
    await manage({ requestId: randomUUID(), action: 'restore', items: [{ id: cloned.id, revision: revision() }] });
    await manage({ requestId: randomUUID(), action: 'archive', items: [{ id: cloned.id, revision: revision() }] });
    const purge = { requestId: randomUUID(), action: 'delete', items: [{ id: cloned.id, revision: revision() }] };
    assert.equal(firstWorkspace(await manage(purge)).success, true);
    assert.equal(firstWorkspace(await manage(purge)).success, true, '重放原样返回');
    assert.ok(f.manager.get(f.workspace.id), '原工作区还在');
    assert.equal(f.ai.sources().length, 1, '正式来源保留');
    f.store.db.exec("CREATE TRIGGER fictional_audit_failure BEFORE INSERT ON business_audit BEGIN SELECT RAISE(ABORT,'fictional audit unavailable'); END");
    const uncertain = { requestId: randomUUID(), action: 'fork', items: [{ id: f.workspace.id }] };
    await assert.rejects(() => manage(uncertain), /待核验/);
    const count = f.manager.status().workspaces.length;
    await assert.rejects(() => manage(uncertain), /待核对/);
    assert.equal(f.manager.status().workspaces.length, count);
  } finally {
    f.close();
  }
});
