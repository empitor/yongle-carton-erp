// 删除前一定留破坏前快照（AGENTS.md“删除和初始化前调用 snapshotBeforeDestructive”）：删除引擎对外只有先拍快照的 delete；
// 不另拍快照的那条（server/lifecycle/database-maintenance.ts 的 deleteAfterSnapshot）只给改订单连带删送货单用，
// 要本库真拍过快照的凭证（TakenSnapshot.take，构造函数私有）；订单服务和业务总览的入口都不转交这两样。
import '../../server/import/index.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as business from '../../server/overview/index.js';
import * as orders from '../../server/orders/index.js';
import { DatabaseMaintenanceService, TakenSnapshot, deleteAfterSnapshot } from '../../server/lifecycle/index.js';
import { Store } from '../../server/core/index.js';
import { fixture } from '../support/maintenance-fixture.js';

test('删除归档入口交出去的删除引擎只有 delete 一个删除方法（先拍快照），订单服务和业务总览的入口都不转交不另拍快照的删除和快照凭证', () => {
  // 加方法要先在这里登记：删东西的方法必须先拍快照
  assert.deepEqual(Object.getOwnPropertyNames(DatabaseMaintenanceService.prototype).sort(), [
    'constructor',
    'delete',
    'deletionAccess',
    'deletionActor',
    'preview',
    'replay',
  ]);
  assert.equal('deleteAfterSnapshot' in orders, false);
  assert.equal('TakenSnapshot' in orders, false);
  assert.equal('deleteAfterSnapshot' in business, false);
  assert.equal('TakenSnapshot' in business, false);
});

test('不另拍快照的删除只认本库拍的快照凭证：拿别的库的凭证不删，拿本库的才删', () => {
  const f = fixture(),
    other = new Store(':memory:');
  try {
    const task = f.task(),
      engine = new DatabaseMaintenanceService(f.store),
      selection = { module: 'task', items: [{ id: task.id, version: task.version }] },
      request = () => ({ ...selection, requestId: randomUUID(), deletionDigest: engine.preview(selection, f.who).digest });
    assert.throws(
      () => deleteAfterSnapshot(engine, request(), f.who, 's', TakenSnapshot.take(other, 'fictional-other')),
      /不是这个业务库拍的/,
    );
    assert.equal(f.flow.get(task.id, 'task').id, task.id, '凭证不对，生产任务还在');
    deleteAfterSnapshot(engine, request(), f.who, 's', TakenSnapshot.take(f.store, 'fictional-same'));
    assert.throws(() => f.flow.get(task.id, 'task'), /不存在/);
  } finally {
    f.store.close();
    other.close();
  }
});
