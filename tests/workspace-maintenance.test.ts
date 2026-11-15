// 识别工作区的维护：归档保留、永久删除真删；删掉到货后解除引用；归档的可以直接改、直接删；已正式导入的可以改、撤销、归档，不重复导入。
import { pageActor } from './actor-fixture.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DatabaseMaintenanceService } from '../server/business/database-maintenance.js';
import { FlowService } from '../server/flow/service.js';
import { OperationsService } from '../server/operations/service.js';
import { localAdministratorActor } from '../server/core/local-administrator.js';
import { arrivalLinks } from '../server/import/business-links.js';
import { arrivalAssistantFixture } from './arrival-assistant-fixture.js';
import { createOrderWorkflowFixture } from './assistant-workflow-fixture.js';
import { actor as fixtureActor } from './assistant-fixture.js';
import { imageFixture } from './import-fixtures.js';

/** 工作区草稿的第一行；没有草稿说明识别没做成，直接报错 */
function firstLine<L>(w: { draft?: { lines: L[] } | null }): L {
  if (!w.draft) throw new Error('工作区还没有草稿');
  return w.draft.lines[0];
}

test('工作区归档后库里和原件都还在；永久删除后库里的行和原件都没了，也恢复不了', async () => {
  const f = await arrivalAssistantFixture();
  try {
    const who = localAdministratorActor(pageActor({
        id: 'workspace-owner',
        name: '虚构维护',
        role: 'super_admin',
        permissions: ['business:edit'],
      })),
      id = f.workspace.id;
    f.manager.changeArchive({ action: 'archive', items: [{ id: id, version: f.manager.get(id).revision }] }, who);
    const archived = f.manager.get(id);
    const db = new DatabaseSync(join(f.dir, 'imports', 'workspaces.sqlite'));
    assert.equal(db.prepare('SELECT COUNT(*) n FROM workspaces WHERE id=?').get(id)?.n, 1);
    assert.ok(f.manager.archives().some((r) => r.id === id));
    assert.ok(existsSync(join(f.dir, 'imports', id)));
    await f.manager.deleteMany({ items: [{ id, version: archived.revision }] }, who);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM workspaces WHERE id=?').get(id)?.n, 0);
    assert.equal(existsSync(join(f.dir, 'imports', id)), false);
    assert.equal(f.manager.changeArchive({ action: 'restore', items: [{ id, version: archived.revision }] }, who).results[0].message, '记录不存在。');
    db.close();
  } finally {
    f.close();
  }
});

test('物理删除到货后工作区解除跨库引用，保留独立识别草稿而非悬空404', async () => {
  const f = await arrivalAssistantFixture();
  try {
    const who = localAdministratorActor(pageActor({
      id: 'fixture-owner',
      name: '虚构维护',
      role: 'super_admin',
      permissions: ['business:edit'],
    }));
    const supplier = new OperationsService(f.store).saveSupplier(
      { name: '解除关联虚构供应商' },
      who,
    );
    const flow = new FlowService(f.store);
    const arrival = flow.save(
      'arrival',
      {
        date: '2026-10-27',
        supplierId: supplier.id,
        reference: randomUUID(),
        lines: [{ item: { name: '独立纸板', unit: '张' }, quantity: '100' }],
      },
      who,
    );
    f.manager.linkArrival(f.workspace.id, {
      expectedRevision: f.manager.get(f.workspace.id).revision,
      docId: arrival.id,
    });
    f.manager.connectArrivals(arrivalLinks(f.store));
    const service = new DatabaseMaintenanceService(f.store),
      selection = { module: 'arrival', items: [{ id: arrival.id, version: arrival.version }] };
    const plan = service.preview(selection, who);
    service.delete(
      { ...selection, requestId: randomUUID(), deletionDigest: plan.digest },
      who,
      's',
    );
    assert.equal(f.manager.get(f.workspace.id).arrivalDocId, null);
    assert.ok(f.manager.get(f.workspace.id).arrivalSourceId);
  } finally {
    f.close();
  }
});

test('归档的工作区可以直接编辑并保留归档状态，也可以不恢复直接永久删除', async () => {
  for (const action of ['edit', 'delete']) {
    const f = await arrivalAssistantFixture();
    try {
      const who = localAdministratorActor(pageActor({
          id: 'legacy-archive-owner',
          name: '虚构维护',
          role: 'super_admin',
          permissions: ['business:edit'],
        })),
        id = f.workspace.id;
      f.manager.changeArchive({ action: 'archive', items: [{ id: id, version: f.manager.get(id).revision }] }, who);
      assert.ok(f.manager.archives().some((r) => r.id === id));
      if (action === 'edit') {
        const archived = f.manager.get(id);
        assert.equal(archived.archived, true);
        f.manager.linkArrival(id, { expectedRevision: archived.revision, docId: null, sourceId: null });
        assert.equal(f.manager.get(id).arrivalSourceId, null);
        assert.ok(f.manager.archives().some((r) => r.id === id));
        assert.ok(!f.manager.status().workspaces.some((r) => r.id === id));
        assert.ok(existsSync(join(f.dir, 'imports', id, 'original')));
      } else {
        await f.manager.deleteMany({ items: [{ id, version: f.manager.get(id).revision }] }, who);
        assert.ok(!f.manager.archives().some((r) => r.id === id));
        assert.ok(!existsSync(join(f.dir, 'imports', id)));
        assert.equal(f.manager.changeArchive({ action: 'restore', items: [{ id, version: 1 }] }, who).results[0].success, false);
      }
    } finally {
      f.close();
    }
  }
});

test('已正式导入的工作区可由本机管理员编辑、撤销和归档，正式订单及来源回执不被重复执行', async () => {
  const f = createOrderWorkflowFixture(undefined, { agent: { autoConfirm: true } });
  try {
    const user = { ...fixtureActor, permissions: ['business:edit', 'import:execute'] };
    const attachment = await f.manager.attachments.upload(
      f.thread.id,
      imageFixture(),
      '虚构已导入草稿.png',
      randomUUID(),
      user,
    );
    await f.send('识别这张客户订单', [attachment.id]);
    await f.send('确认导入');
    const original = f.store.orders()[0];
    assert.ok(original);
    const who = localAdministratorActor({ ...user, name: '虚构维护', role: 'super_admin' });
    let w = f.current();
    w = f.imports.edit(
      w.id,
      {
        expectedRevision: w.revision,
        operations: [
          {
            op: 'set-line',
            lineId: firstLine(w).id,
            field: 'quantity',
            value: '250',
            reason: '管理员明确更正工作草稿',
          },
        ],
      },
      'manual',
      who,
    );
    assert.equal(firstLine(w).fields.quantity.value, '250');
    assert.equal(f.store.order(original.id)?.lines[0].quantity, 100);
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM import_executions').get()?.n, 1);
    w = f.imports.undo(w.id, { expectedRevision: w.revision }, who);
    assert.equal(firstLine(w).fields.quantity.value, '100');
    f.replies.push(
      {
        toolCalls: [
          {
            name: 'order_import.edit',
            args: {
              expectedRevision: w.revision,
              operations: [
                {
                  op: 'set-line',
                  lineId: firstLine(w).id,
                  field: 'quantity',
                  value: '275',
                  reason: '用户明确修改工作草稿',
                },
              ],
            },
          },
        ],
      },
      { message: '已保存工作草稿。' },
    );
    await f.send('把已导入订单的工作区草稿第一行数量改为275，不重复导入', [], randomUUID(), who);
    w = f.current();
    assert.equal(firstLine(w).fields.quantity.value, '275');
    assert.equal(f.store.order(original.id)?.lines[0].quantity, 100);
    f.imports.changeArchive({ action: 'archive', items: [{ id: w.id, version: w.revision }] }, who);
    assert.ok(f.imports.archives().some((r) => r.id === w.id));
    assert.equal(f.store.orders().length, 1);
    assert.equal(f.recognitionCalls(), 1);
  } finally {
    f.close();
  }
});
